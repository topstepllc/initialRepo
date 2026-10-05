// Replaces Celigo for populating the SPP data CSVs in S3. Reads a per-
// company master config file describing which SPP tables/fields to sync,
// pulls only what changed since the last successful run (via SPP's XML API,
// filtered on "updated" so both new records AND edits to old-but-still-
// active records are caught -- see the design discussion this came out of),
// and merges the results into a single CSV per table using DuckDB.
//
// Deliberately writes to a NEW S3 path (spp-data/{company}/sync/{table}.csv)
// rather than the existing recent/historical files Celigo currently
// populates -- this can be built and validated in full isolation from the
// working production pipeline. Cutting aiQueryReports/reportEngine.js's
// REPORT_VIEWS over to read from here instead is a separate, deliberate
// step for later, not bundled into this.
//
// Known, accepted gap (per direct instruction): no periodic full
// reconciliation pass. An "updated"-based incremental sync can never detect
// a record that gets hard-purged after SPP's own (unpublished, ~30+ day)
// soft-delete retention window -- that gap is accepted for now rather than
// solved here.

const fs = require("fs");
const { DuckDBInstance } = require("@duckdb/node-api");
const { XMLParser } = require("fast-xml-parser");
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";
const WATERMARKS_TABLE = process.env.WATERMARKS_TABLE || "sppSyncWatermarks";
const PAGE_SIZE = 1000;

// Once less than this remains on the Lambda's clock, stop starting new
// work for the current table: flush whatever's pending, checkpoint
// progress, and return "partial" instead of racing the hard 900s cutoff.
// Sized to comfortably cover one worst-case mergeIntoS3Csv call (a full
// read-modify-write of the existing S3 file), which grows as a table's
// backfill progresses.
const BACKFILL_TIME_BUDGET_MS = 90_000;

// Rows accumulated in memory before an incremental merge-to-S3 flush
// during a table's backfill. Smaller = less progress lost per timeout,
// larger = fewer (cheaper) full-file merge/rewrite cycles -- see
// runFieldDataPhase.
const MERGE_BATCH_SIZE = 25_000;

// Every table gets "id" in its SPP field list regardless of what's in the
// master config -- required by the merge step below. "deleted" is NOT a
// requestable field value (confirmed empirically: even querying
// deleted="1" for records known to be deleted, no <deleted> element comes
// back at all) -- deletion status is purely a query-mode thing (which
// combination of deleted="1"/include_nondeleted="1" you used), not a
// per-row field. It's computed separately in runDeletedIdsPhase() below
// and merged in as a synthetic column, not requested via _Return.
const ALWAYS_INCLUDED_SPP_FIELDS = ["id"];
const DELETED_CSV_FIELD = "deleted";

function s3Path(company, ...parts) {
  return `s3://${BUCKET}/${DATA_PREFIX}/${company}/${parts.join("/")}`;
}

async function getSsmParam(name) {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  return result.Parameter.Value;
}

// --- DuckDB setup (same pattern as aiQueryReports/reportEngine.js) ---------------

async function setupDuckDB(region) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("SET home_directory='/tmp';");
  await connection.run("INSTALL httpfs;");
  await connection.run("LOAD httpfs;");
  await connection.run("INSTALL aws;");
  await connection.run("LOAD aws;");
  await connection.run(`
    CREATE SECRET s3_credentials (
      TYPE S3,
      PROVIDER CREDENTIAL_CHAIN,
      REGION '${region}'
    );
  `);
  return connection;
}

// --- Master config -----------------------------------------------------

// Reads spp-data/{company}/_config/stepwise_mapping.csv and groups rows by
// localTable. Each group: { sppType, fields: [{sppField, subKey, csvField}] }.
// (Renamed from master.csv -- same file, same shape, just the Stepwise
// branding naming convention.)
//
// sppField may carry a dotted sub-path (e.g. "addr.city") to pull one named
// piece out of a compound field -- SPP always returns the WHOLE nested
// object for a compound field (confirmed for both dates and addresses, via
// Postman), there's no way to ask it for just one sub-part server-side, so
// "addr" is still what gets requested from SPP; "city" just says which
// piece of the response to extract client-side. See extractSubFieldValue.
// A plain sppField with no dot (subKey undefined) is unaffected by this --
// same single string as before, same flattenFieldValue call site.
async function readMasterConfig(connection, company) {
  const path = s3Path(company, "_config", "stepwise_mapping.csv");
  const reader = await connection.runAndReadAll(
    `SELECT company, localTable, sppType, sppField, csvField FROM read_csv_auto('${path}', header=true);`,
  );
  const rows = await reader.getRowObjects();

  const byTable = {};
  for (const row of rows) {
    if (!byTable[row.localTable]) {
      byTable[row.localTable] = { sppType: row.sppType, fields: [] };
    }
    // "deleted" isn't a real requestable field (see DELETED_CSV_FIELD's
    // comment) -- drop it here if someone's master file lists it, rather
    // than sending SPP a field name that silently returns nothing.
    if (row.sppField === DELETED_CSV_FIELD) continue;

    const dotIndex = row.sppField.indexOf(".");
    const sppField =
      dotIndex === -1 ? row.sppField : row.sppField.slice(0, dotIndex);
    const subKey =
      dotIndex === -1 ? undefined : row.sppField.slice(dotIndex + 1);

    byTable[row.localTable].fields.push({
      sppField,
      subKey,
      csvField: row.csvField,
    });
  }

  // Always include "id", whether or not the master file explicitly lists
  // it -- required by the merge step below.
  for (const table of Object.values(byTable)) {
    for (const required of ALWAYS_INCLUDED_SPP_FIELDS) {
      const alreadyPresent = table.fields.some((f) => f.sppField === required);
      if (!alreadyPresent) {
        table.fields.push({ sppField: required, csvField: required });
      }
    }
  }

  return byTable;
}

// --- Sync state: committed watermark + resumable backfill progress --------
//
// A table's sync can span multiple Lambda invocations: if bringing it up
// to date takes longer than fits in one 900s run, progress is checkpointed
// here between attempts (see runTableSync below) instead of restarting
// from scratch every time -- confirmed necessary in practice (a customer's
// "task" table ran past 13 minutes with the old all-in-one-shot design).

function syncStateKey(integrationKey, localTable) {
  return `${integrationKey}#${localTable}`;
}

// Epoch used when no watermark exists yet -- effectively "everything",
// giving a full load on a table's first-ever run.
const EPOCH_START = { year: 2000, month: 1, day: 1 };

// Safety margin subtracted from the committed watermark before it's sent to
// SPP as the "newer-than" cutoff. Confirmed in production (2026-09-29,
// top-step "timesheet" id 18292): SPP's own updated-field filter can simply
// fail to surface a record that objectively matches -- every scheduled run
// still completed without error and correctly advanced the watermark right
// past it, for about 40 hours, with no periodic reconciliation to catch the
// miss. Always re-asking for a few extra days of already-synced data is
// cheap and safe -- mergeIntoS3Csv upserts by id -- so this never trusts
// SPP's filter to be complete right at the exact watermark boundary.
const WATERMARK_OVERLAP_DAYS = 2;
const WATERMARK_OVERLAP_SECONDS = WATERMARK_OVERLAP_DAYS * 24 * 60 * 60;

function epochToDateParts(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

// Reads the committed watermark (if any) and any in-progress, not-yet-
// finished backfill (if a prior invocation ran out of time mid-table) in
// one read -- resuming needs both at once.
async function getSyncState(integrationKey, localTable) {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: WATERMARKS_TABLE,
      Key: marshall({ pk: syncStateKey(integrationKey, localTable) }),
    }),
  );
  if (!result.Item) return { lastSyncedAt: null, backfill: null };
  const item = unmarshall(result.Item);
  return {
    lastSyncedAt: item.lastSyncedAt ?? null,
    backfill: item.backfill ?? null,
  };
}

// Checkpoints an in-progress backfill's progress WITHOUT touching the
// committed watermark -- that only ever advances once completeBackfill
// runs, at the end of the whole chain of invocations for this table.
// `backfill` only ever holds small scalar bookkeeping now (offsets, done
// flags, the commit watermark) -- the deleted-ids set itself lives in S3
// (see deletedIdsS3Path), not here, after a table with tens of thousands
// of deleted records blew past DynamoDB's 400KB per-item limit in
// production when it was carried in this object directly.
async function saveBackfillProgress(integrationKey, localTable, backfill) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: WATERMARKS_TABLE,
      Key: marshall({ pk: syncStateKey(integrationKey, localTable) }),
      UpdateExpression: "SET backfill = :backfill, updatedAt = :now",
      ExpressionAttributeValues: marshall({
        ":backfill": backfill,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// Marks a table's backfill fully done: advances the committed watermark to
// commitWatermark (fixed once, at the start of the FIRST attempt at this
// backfill -- see runTableSync) and clears the in-progress state (PutItem
// replaces the whole item, so omitting `backfill` here removes it) so the
// next invocation runs a fresh, normally-small incremental sync instead of
// re-running this backfill again.
async function completeBackfill(integrationKey, localTable, commitWatermark) {
  await dynamo.send(
    new PutItemCommand({
      TableName: WATERMARKS_TABLE,
      Item: marshall({
        pk: syncStateKey(integrationKey, localTable),
        lastSyncedAt: commitWatermark,
        updatedAt: Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// --- XML request/response ---------------------------------------------

// deletedMode: "nondeleted-only" (default, omit both attributes -- matches
// normal SPP UI behavior), "both" (deleted="1" include_nondeleted="1"), or
// "deleted-only" (deleted="1" alone).
function buildReadXml({
  apiKey,
  accessToken,
  sppType,
  sppFieldNames,
  watermark,
  start,
  deletedMode,
}) {
  const returnFields = sppFieldNames.map((f) => `<${f}/>`).join("");
  const deletedAttrs =
    deletedMode === "both"
      ? ` deleted="1" include_nondeleted="1"`
      : deletedMode === "deleted-only"
        ? ` deleted="1"`
        : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${apiKey}">
  <Auth>
    <Login>
      <access_token>${accessToken}</access_token>
    </Login>
  </Auth>
  <Read type="${sppType}" method="all" enable_custom="1" filter="newer-than" field="updated"${deletedAttrs} limit="${start},${PAGE_SIZE}">
    <Date>
      <year>${watermark.year}</year>
      <month>${String(watermark.month).padStart(2, "0")}</month>
      <day>${String(watermark.day).padStart(2, "0")}</day>
    </Date>
    <_Return>${returnFields}</_Return>
  </Read>
</request>`;
}

// SPP wraps every date-typed field's value in a nested <Date> element with
// year/month/day plus hour/minute/second/timezone (confirmed empirically --
// e.g. <updated><Date><year>2015</year><month>02</month>...</Date></updated>).
// The audit fields (created/updated) carry real time-of-day; a plain
// business "date" field has those sub-elements present but empty. Flatten
// either shape to "YYYY-MM-DD" (no time component) or "YYYY-MM-DD
// HH:MM:SS" (time component present).
//
// Non-date fields are coerced to a string (or left null/undefined) rather
// than passed through as-is: fast-xml-parser auto-converts numeric-looking
// XML text to real JS numbers, but an empty element for that same field on
// another record comes through as "" -- writing that mix straight into the
// batch JSON gives DuckDB's read_json_auto a column with both numbers and
// strings, and it infers a numeric type from its early sample then fails
// to cast the "" it hits later in a large batch. Forcing every value to a
// string keeps every column uniformly VARCHAR in the JSON, matching how
// mergeIntoS3Csv already treats everything as text.
function flattenFieldValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value);

  const dateObj = value.Date ?? value;
  const year = dateObj.year ?? dateObj.Year;
  const month = dateObj.month ?? dateObj.Month;
  const day = dateObj.day ?? dateObj.Day;
  if (year === undefined || month === undefined || day === undefined) {
    // Unrecognized nested shape -- don't silently drop data, but don't
    // crash the whole sync over one odd field either.
    return JSON.stringify(value);
  }

  const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hour = dateObj.hour ?? dateObj.Hour;
  const minute = dateObj.minute ?? dateObj.Minute;
  const second = dateObj.second ?? dateObj.Second;
  if (hour === "" || hour === undefined) return datePart;

  return `${datePart} ${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}:${String(second || 0).padStart(2, "0")}`;
}

// Pulls one named piece out of a compound field's nested value -- e.g.
// addr -> <addr><Address><city>...</city>...</Address></addr>, so
// extractSubFieldValue(rawRow.addr, "city") drills into the single nested
// wrapper (whatever it's called -- "Address" here, generic rather than
// hardcoded since other compound field types may wrap under a different
// name) and returns that one sub-value. Entirely separate from, and never
// called in place of, flattenFieldValue -- a field with no subKey (every
// stepwise_mapping.csv row before this feature, and every date field
// regardless) still goes through flattenFieldValue exactly as before.
function extractSubFieldValue(value, subKey) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value);

  const keys = Object.keys(value);
  const wrapper =
    keys.length === 1 &&
    typeof value[keys[0]] === "object" &&
    value[keys[0]] !== null
      ? value[keys[0]]
      : value;

  const raw = wrapper[subKey];
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== "object") return String(raw);
  // A sub-field that's itself compound (unexpected) -- don't silently drop
  // data, but don't try to guess how to flatten it either.
  return JSON.stringify(raw);
}

// fast-xml-parser caps total XML entity expansions (&amp;, &lt;, etc.) per
// document at 1000 by default -- an anti-DoS protection meant for parsing
// untrusted XML. SPP is an authenticated, trusted source, not arbitrary
// attacker input, and a single page can legitimately contain far more than
// that: up to 1000 records per page (PAGE_SIZE), and rich-text fields like
// Issue.description/notes are full of &amp;/&lt;/&gt; entities -- confirmed
// hitting this exact default ("Entity expansion limit exceeded: 1009 >
// 1000") syncing the "issue" table. maxExpandedLength (total expanded
// content length, default 100,000 chars) is the next limit a large page of
// rich text would hit right after -- raised together rather than one at a
// time. maxEntitySize/maxExpansionDepth only apply to custom DTD-declared
// entities, which SPP's XML never uses, so they're left at their defaults.
const xmlParser = new XMLParser({
  processEntities: {
    maxTotalExpansions: 1_000_000,
    maxExpandedLength: 50_000_000,
  },
});

// Fetches exactly ONE page (up to PAGE_SIZE rows). The building block both
// resumable phases below drive themselves, checking the remaining time
// budget between pages -- unlike the old all-in-one-shot loop this
// replaced, nothing here drains every page in a single uninterruptible
// call.
async function fetchOnePage({
  xmlUrl,
  apiKey,
  accessToken,
  sppType,
  sppFieldNames,
  watermark,
  start,
  deletedMode,
}) {
  const xml = buildReadXml({
    apiKey,
    accessToken,
    sppType,
    sppFieldNames,
    watermark,
    start,
    deletedMode,
  });

  const response = await fetch(xmlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xml,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `SPP XML request failed [${response.status}]: ${responseText}`,
    );
  }

  const parsed = xmlParser.parse(responseText);
  const pageData = parsed?.response?.Read?.[sppType];
  const rows =
    pageData === undefined
      ? []
      : Array.isArray(pageData)
        ? pageData
        : [pageData];

  return { rows, isLastPage: rows.length < PAGE_SIZE };
}

// context is the Lambda invocation's context object (getRemainingTimeInMillis) --
// absent (e.g. local/manual test scripts calling these directly) means
// never time-box, run to completion.
function remainingMs(context) {
  return context && typeof context.getRemainingTimeInMillis === "function"
    ? context.getRemainingTimeInMillis()
    : Infinity;
}

// The accumulated deleted-ids set lives in S3, not the DynamoDB backfill
// item -- confirmed necessary in production: a table with a large enough
// deletion count (tens of thousands of ids) blew past DynamoDB's 400KB
// per-item limit ("Item size has exceeded the maximum allowed size"),
// failing the whole sync. S3 has no comparable size limit, and everything
// else in this file already goes through DuckDB/httpfs for S3 I/O, so this
// follows the same pattern rather than adding a raw S3 client.
function deletedIdsS3Path(company, integrationKey, localTable) {
  return s3Path(company, "_backfill_state", `${integrationKey}#${localTable}_deletedIds.csv`);
}

async function saveDeletedIdsToS3(connection, path, ids) {
  if (ids.length === 0) {
    // An empty JSON array has no fields for read_json_auto to infer a
    // schema from -- "SELECT id FROM ..." then fails with "column id not
    // found" (confirmed happening on every table with zero deletions,
    // which in practice is most small/stable reference tables). Simplest
    // fix: write nothing. loadDeletedIdsFromS3's catch already treats a
    // missing file as an empty set, which is exactly what this is.
    return;
  }
  const tmpFile = `/tmp/deleted_ids_${Date.now()}.json`;
  fs.writeFileSync(tmpFile, JSON.stringify(ids.map((id) => ({ id }))));
  await connection.run(
    `CREATE OR REPLACE TABLE deleted_ids_state AS SELECT id FROM read_json_auto('${tmpFile}');`,
  );
  await connection.run(`COPY deleted_ids_state TO '${path}' (FORMAT CSV, HEADER);`);
  fs.unlinkSync(tmpFile);
}

async function loadDeletedIdsFromS3(connection, path) {
  try {
    const reader = await connection.runAndReadAll(
      `SELECT id FROM read_csv_auto('${path}', header=true, sample_size=-1);`,
    );
    return (await reader.getRowObjects()).map((r) => String(r.id));
  } catch {
    // Nothing saved yet for this table -- a fresh backfill's deleted-ids
    // phase hasn't completed even one checkpoint.
    return [];
  }
}

// Phase 1 of a table's backfill: collect every deleted id matching the
// watermark ("deleted" isn't a requestable field value -- see
// DELETED_CSV_FIELD's comment -- so this is the only way to know which ids
// among a changed set are deleted). Resumable via state.deletedIdsOffset,
// with the accumulated set itself checkpointed to S3 (see above) rather
// than carried in state directly -- typically small and fast (deletions
// are usually a small fraction of a table), but time-boxed the same way
// as the field-data phase in case it isn't, for some table.
async function runDeletedIdsPhase({
  xmlUrl,
  apiKey,
  accessToken,
  sppType,
  watermark,
  state,
  context,
  connection,
  company,
  integrationKey,
  localTable,
}) {
  const idsPath = deletedIdsS3Path(company, integrationKey, localTable);
  const priorIds = state.deletedIdsOffset > 0
    ? await loadDeletedIdsFromS3(connection, idsPath)
    : [];
  const ids = new Set(priorIds);
  let offset = state.deletedIdsOffset ?? 0;

  while (true) {
    if (remainingMs(context) < BACKFILL_TIME_BUDGET_MS) {
      await saveDeletedIdsToS3(connection, idsPath, [...ids]);
      return { offset, done: false };
    }

    const { rows, isLastPage } = await fetchOnePage({
      xmlUrl,
      apiKey,
      accessToken,
      sppType,
      watermark,
      start: offset,
      sppFieldNames: ["id"],
      deletedMode: "deleted-only",
    });
    for (const row of rows) ids.add(String(row.id));
    offset += PAGE_SIZE;

    if (isLastPage) {
      await saveDeletedIdsToS3(connection, idsPath, [...ids]);
      return { offset, done: true };
    }
  }
}

// Phase 2: the field-data pages, merged into S3 in batches as they're
// fetched (MERGE_BATCH_SIZE rows at a time, or whatever's pending once the
// last page comes in) instead of accumulated entirely in memory and
// written once at the very end -- so a timeout mid-table loses at most one
// batch's worth of already-fetched-but-not-yet-merged rows, not the whole
// table's progress. Resumable via state.fieldOffset.
async function runFieldDataPhase({
  xmlUrl,
  apiKey,
  accessToken,
  sppType,
  fields,
  watermark,
  deletedIds,
  state,
  context,
  connection,
  company,
  localTable,
}) {
  // Dedupe -- several fields can share the same base sppField (e.g.
  // addr.city and addr.state both come from requesting "addr" once), so
  // request each base field from SPP only once regardless of how many
  // csvFields extract pieces from it.
  const sppFieldNames = [...new Set(fields.map((f) => f.sppField))];

  let offset = state.fieldOffset ?? 0;
  let pendingBatch = [];
  let totalMerged = 0;
  let lastRowsWritten = null;

  const flush = async () => {
    if (pendingBatch.length === 0) return;
    const result = await mergeIntoS3Csv(
      connection,
      company,
      localTable,
      fields,
      pendingBatch,
    );
    lastRowsWritten = result.rowsWritten;
    totalMerged += pendingBatch.length;
    pendingBatch = [];
  };

  while (true) {
    if (remainingMs(context) < BACKFILL_TIME_BUDGET_MS) {
      await flush();
      return { offset, done: false, totalMerged, rowsWritten: lastRowsWritten };
    }

    const { rows: rawRows, isLastPage } = await fetchOnePage({
      xmlUrl,
      apiKey,
      accessToken,
      sppType,
      watermark,
      start: offset,
      sppFieldNames,
      deletedMode: "both",
    });

    for (const rawRow of rawRows) {
      const csvRow = {};
      for (const field of fields) {
        csvRow[field.csvField] = field.subKey
          ? extractSubFieldValue(rawRow[field.sppField], field.subKey)
          : flattenFieldValue(rawRow[field.sppField]);
      }
      csvRow[DELETED_CSV_FIELD] = deletedIds.has(String(rawRow.id)) ? "1" : "0";
      pendingBatch.push(csvRow);
    }
    offset += PAGE_SIZE;

    if (pendingBatch.length >= MERGE_BATCH_SIZE || isLastPage) {
      await flush();
    }

    if (isLastPage) {
      if (lastRowsWritten === null) {
        // Nothing was ever merged this run (e.g. genuinely zero changed
        // rows) -- still need the current total for reporting.
        const result = await mergeIntoS3Csv(
          connection,
          company,
          localTable,
          fields,
          [],
        );
        lastRowsWritten = result.rowsWritten;
      }
      return { offset, done: true, totalMerged, rowsWritten: lastRowsWritten };
    }
  }
}

// Runs (or resumes) one table's full sync end to end. A table's backfill
// can span multiple Lambda invocations -- progress is checkpointed to
// DynamoDB between phases/batches (see saveBackfillProgress), so
// re-invoking with the same integrationKey/company/table just continues
// rather than restarting from scratch. Returns:
//   { status: "complete", rowsThisRun, rowsWritten }
//   { status: "partial", phase: "deletedIds" | "fieldData", rowsThisRun }
async function runTableSync({
  xmlUrl,
  apiKey,
  accessToken,
  integrationKey,
  company,
  localTable,
  tableConfig,
  connection,
  context,
}) {
  const { lastSyncedAt, backfill: existingBackfill } = await getSyncState(
    integrationKey,
    localTable,
  );
  // See WATERMARK_OVERLAP_SECONDS -- always query a bit further back than
  // the literal committed watermark, so a record SPP's own filter misses on
  // one run still gets a real chance to be picked up on a later one instead
  // of being permanently skipped the moment the watermark advances past it.
  const watermark =
    lastSyncedAt != null
      ? epochToDateParts(lastSyncedAt - WATERMARK_OVERLAP_SECONDS)
      : EPOCH_START;

  const backfill = existingBackfill ?? {
    // Fixed once, at the start of the FIRST attempt at this backfill --
    // reused on every resume, same as `watermark` above (read from
    // lastSyncedAt, which isn't touched until completeBackfill), so a page
    // offset always means the same thing across the whole chain of
    // invocations for this table. The accumulated deleted-ids set itself
    // is NOT carried here -- see deletedIdsS3Path -- only its offset/done
    // bookkeeping, so this object stays small regardless of table size.
    commitWatermark: Math.floor(Date.now() / 1000),
    deletedIdsOffset: 0,
    deletedIdsDone: false,
    fieldOffset: 0,
  };

  if (!backfill.deletedIdsDone) {
    const result = await runDeletedIdsPhase({
      xmlUrl,
      apiKey,
      accessToken,
      sppType: tableConfig.sppType,
      watermark,
      state: backfill,
      context,
      connection,
      company,
      integrationKey,
      localTable,
    });
    backfill.deletedIdsOffset = result.offset;
    backfill.deletedIdsDone = result.done;

    if (!result.done) {
      await saveBackfillProgress(integrationKey, localTable, backfill);
      return { status: "partial", phase: "deletedIds", rowsThisRun: 0 };
    }
  }

  const deletedIds = new Set(
    await loadDeletedIdsFromS3(connection, deletedIdsS3Path(company, integrationKey, localTable)),
  );
  const fieldResult = await runFieldDataPhase({
    xmlUrl,
    apiKey,
    accessToken,
    sppType: tableConfig.sppType,
    fields: tableConfig.fields,
    watermark,
    deletedIds,
    state: backfill,
    context,
    connection,
    company,
    localTable,
  });
  backfill.fieldOffset = fieldResult.offset;

  if (!fieldResult.done) {
    await saveBackfillProgress(integrationKey, localTable, backfill);
    return {
      status: "partial",
      phase: "fieldData",
      rowsThisRun: fieldResult.totalMerged,
    };
  }

  await completeBackfill(integrationKey, localTable, backfill.commitWatermark);
  return {
    status: "complete",
    rowsThisRun: fieldResult.totalMerged,
    rowsWritten: fieldResult.rowsWritten,
  };
}

// --- Merge into S3 (DuckDB-based upsert by id) -----------------------------

async function mergeIntoS3Csv(
  connection,
  company,
  localTable,
  fields,
  newRows,
) {
  const outputPath = s3Path(company, "sync", `${localTable}.csv`);

  if (newRows.length === 0) {
    // Nothing changed -- leave the file untouched rather than doing a
    // pointless read/rewrite. Still report its real row count so callers
    // don't read "rowsWritten: 0" as "the file is now empty". sample_size=-1
    // for the same reason as the reads below -- see that comment.
    let rowsWritten = 0;
    try {
      const reader = await connection.runAndReadAll(
        `SELECT COUNT(*) AS n FROM read_csv_auto('${outputPath}', header=true, sample_size=-1);`,
      );
      rowsWritten = Number((await reader.getRowObjects())[0].n);
    } catch {
      // No existing file yet -- genuinely 0 rows.
    }
    return { rowsWritten, wasFirstLoad: false };
  }

  // fields lists only real SPP-requestable fields -- "deleted" is synthetic
  // (populated by runFieldDataPhase via a separate deleted-ids query, see
  // DELETED_CSV_FIELD's comment) and isn't in that list, so it's added here.
  const columns = [...fields.map((f) => f.csvField), DELETED_CSV_FIELD];
  // Everything cast to VARCHAR at this layer -- existing_data (read via
  // read_csv_auto) and new_batch (read via read_json_auto) can each infer
  // different types for the same column (e.g. INTEGER vs DOUBLE), which
  // would break the UNION ALL/anti-join below. Storing as text and letting
  // aiQueryReports' own read_csv_auto (sample_size=-1) do type inference on
  // the READ side keeps this consistent with how every other CSV in this
  // pipeline is already handled.
  const columnList = columns
    .map((c) => `CAST("${c}" AS VARCHAR) AS "${c}"`)
    .join(", ");

  // Stage the new batch as its own table via a local temp file + DuckDB's
  // JSON ingestion -- avoids hand-writing CSV-escaping logic ourselves.
  // (DuckDB's httpfs extension doesn't support data: URIs, so this can't
  // be inlined without a real file.)
  //
  // read_json_auto (even with sample_size=-1) threw a JSON transform error
  // on a MERGE_BATCH_SIZE-sized (25,000-row) production batch -- and it
  // wasn't consistently reproducible against the same real data locally,
  // suggesting it depends on subtle shape variance the auto-detector
  // doesn't always resolve the same way, not just sample coverage. Since
  // every value in newRows is already guaranteed a scalar (string/null) by
  // flattenFieldValue/extractSubFieldValue before it ever gets here,
  // sidestep type/shape inference entirely: tell read_json every column IS
  // VARCHAR up front via the explicit `columns` map, rather than asking
  // DuckDB to guess. The throw used to happen before fieldOffset gets
  // checkpointed, so every retry re-fetched the identical batch and failed
  // the identical way -- wedging the table permanently.
  const jsonColumns = columns.map((c) => `"${c}": 'VARCHAR'`).join(", ");
  const batchFile = `/tmp/new_batch_${localTable}_${Date.now()}.json`;
  fs.writeFileSync(batchFile, JSON.stringify(newRows));
  await connection.run(
    `CREATE OR REPLACE TABLE new_batch AS SELECT ${columnList} FROM read_json('${batchFile}', columns={${jsonColumns}});`,
  );
  fs.unlinkSync(batchFile);

  // Master.csv can gain new columns over time (e.g. adding an addr.email
  // row to an already-synced table) -- the existing S3 file won't have
  // that column yet. Inspect its ACTUAL schema first via DESCRIBE rather
  // than assuming it matches the current column list: reading it with a
  // column list that references a column it doesn't have throws a Binder
  // Error, and treating that the same as "file doesn't exist" (as this
  // used to) silently discards every previously-synced row the very first
  // time a field gets added -- confirmed happening in production. A column
  // present in the current schema but missing from the old file gets
  // NULL-filled here instead, so old rows survive and self-heal the next
  // time each one is re-synced for real.
  //
  // sample_size=-1 on BOTH reads below is not optional: without it,
  // read_csv_auto infers each column's type from only its default
  // 20,480-row sample, and a value elsewhere in a large file that doesn't
  // fit that inferred type (e.g. an empty string for a column the sample
  // looked all-numeric) throws a Conversion Error reading the REST of the
  // file. That exception used to land in the catch below, which is
  // EXACTLY the "file doesn't exist" path -- confirmed happening in
  // production on a 288k-row table, silently overwriting the entire file
  // with just the current incremental batch. aiQueryReports/reportEngine.js
  // already carries this exact lesson in its own comments; this file's
  // own reads of its own previously-written CSV just hadn't gotten it yet.
  let existingExists = true;
  try {
    const describeReader = await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_csv_auto('${outputPath}', header=true, sample_size=-1);`,
    );
    const existingColumns = new Set(
      (await describeReader.getRowObjects()).map((r) => r.column_name),
    );
    const existingColumnList = columns
      .map((c) =>
        existingColumns.has(c)
          ? `CAST("${c}" AS VARCHAR) AS "${c}"`
          : `NULL AS "${c}"`,
      )
      .join(", ");
    await connection.run(
      `CREATE OR REPLACE TABLE existing_data AS SELECT ${existingColumnList} FROM read_csv_auto('${outputPath}', header=true, sample_size=-1);`,
    );
  } catch (error) {
    // Only a genuinely missing file (confirmed: DuckDB/httpfs surfaces
    // this as an HTTP 404 in the error message) means "no existing data,
    // safe to treat this as a first load." Anything else -- a transient
    // S3/network error, a real parsing problem sample_size=-1 didn't fix,
    // anything -- must NOT fall into that same branch: doing so is
    // exactly how a 288k-row table's entire file got silently replaced by
    // one incremental batch in production. Let it propagate instead; the
    // per-table try/catch in the handler reports it as a real failure
    // (watermark left untouched, safe to retry) rather than data loss.
    if (!/HTTP 404/.test(error.message)) {
      throw error;
    }
    existingExists = false;
  }

  if (existingExists) {
    // New batch always wins for any id it contains -- it's a fresher pull
    // than whatever's already on disk for that id. Anti-join rather than
    // "id NOT IN (...)" so a stray NULL id in either table can't collapse
    // the whole filter to empty via SQL's three-valued NOT IN semantics.
    await connection.run(`
      CREATE OR REPLACE TABLE merged AS
      SELECT existing_data.* FROM existing_data
      LEFT JOIN new_batch ON existing_data.id = new_batch.id
      WHERE new_batch.id IS NULL
      UNION ALL
      SELECT * FROM new_batch;
    `);
  } else {
    await connection.run(
      `CREATE OR REPLACE TABLE merged AS SELECT * FROM new_batch;`,
    );
  }

  await connection.run(`COPY merged TO '${outputPath}' (FORMAT CSV, HEADER);`);

  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) AS n FROM merged;`,
  );
  const rows = await reader.getRowObjects();

  return { rowsWritten: Number(rows[0].n), wasFirstLoad: !existingExists };
}

// --- Handler ----------------------------------------------------------

exports.handler = async (event, context) => {
  const {
    integrationKey, // e.g. "spp-top step-prod" -- picks the exact oauth_config/oauth_tokens row. Not derived from `company` -- see the README note on why.
    instance, // "sandbox" | "production" | "demo" -- picks which SPP XML endpoint/API key to use
    company, // which spp-data/{company}/_config/stepwise_mapping.csv to read
    table, // optional -- sync just this one localTable instead of every table in the master config
  } = event;

  if (!integrationKey || !instance || !company) {
    return {
      statusCode: 400,
      body: { error: "integrationKey, instance, and company are required" },
    };
  }

  // Explicit allow-list rather than an `instance === "sandbox" ? sandbox :
  // production` binary ternary -- that older form silently mapped ANY
  // unrecognized instance value (e.g. a demo account) onto production's SSM
  // params instead of erroring, which for a multi-customer stack sharing
  // this SSM prefix is a real cross-tenant-credential risk, not just a typo
  // waiting to happen.
  const KNOWN_INSTANCES = ["sandbox", "production", "demo"];
  if (!KNOWN_INSTANCES.includes(instance)) {
    return {
      statusCode: 400,
      body: {
        error: `Unknown instance "${instance}" -- expected one of ${KNOWN_INSTANCES.join(", ")}`,
      },
    };
  }

  // Required, no default -- one dedicated sppDataSync deployment per
  // customer (see the infra template), each pointed at that customer's own
  // SSM parameters via this prefix. A fallback default here would mean a
  // deployment that's missing this env var silently reads WHOEVER the
  // default pointed at's SPP credentials instead of erroring -- for a
  // multi-customer setup that's a silent cross-tenant credential leak, not
  // a convenience worth having.
  const ssmParamPrefix = process.env.SSM_PARAM_PREFIX;
  if (!ssmParamPrefix) {
    return {
      statusCode: 500,
      body: {
        error:
          "SSM_PARAM_PREFIX environment variable is not set on this Lambda",
      },
    };
  }

  const region = process.env.AWS_REGION || "us-east-2";

  const [apiKey, xmlUrl, { getValidAccessToken }] = await Promise.all([
    getSsmParam(`${ssmParamPrefix}/${instance}Key`),
    getSsmParam(`${ssmParamPrefix}/${instance}XMLURL`),
    import("./oauthUtils.mjs"),
  ]);
  const accessToken = await getValidAccessToken(integrationKey);

  const connection = await setupDuckDB(region);
  const masterConfig = await readMasterConfig(connection, company);

  const tablesToRun = table ? [table] : Object.keys(masterConfig);
  const succeeded = [];
  const partial = [];
  const failed = [];

  for (const localTable of tablesToRun) {
    const tableConfig = masterConfig[localTable];
    if (!tableConfig) {
      failed.push({ table: localTable, error: "Not found in master config" });
      continue;
    }

    try {
      const result = await runTableSync({
        xmlUrl,
        apiKey,
        accessToken,
        integrationKey,
        company,
        localTable,
        tableConfig,
        connection,
        context,
      });

      if (result.status === "complete") {
        succeeded.push({
          table: localTable,
          newOrChangedRows: result.rowsThisRun,
          totalRowsAfterMerge: result.rowsWritten,
        });
        console.log(
          `[sppDataSync] "${localTable}": complete -- ${result.rowsThisRun} new/changed rows this run, ${result.rowsWritten} total after merge`,
        );
      } else {
        partial.push({
          table: localTable,
          phase: result.phase,
          rowsMergedThisRun: result.rowsThisRun,
        });
        console.log(
          `[sppDataSync] "${localTable}": partial (ran out of time during ${result.phase}) -- ${result.rowsThisRun} rows merged this run; re-invoke the same request to continue`,
        );
        // Out of time for this table means there's essentially no time
        // left for any remaining tables in this invocation either --
        // stop here rather than let every subsequent table fail the same
        // way for the same reason. Whatever's left in tablesToRun just
        // gets picked up on the next invocation.
        break;
      }
    } catch (error) {
      console.error(`[sppDataSync] "${localTable}" failed:`, error);
      failed.push({ table: localTable, error: error.message });
      // Deliberately not re-thrown -- one bad table shouldn't abort the
      // rest of the run. Any backfill progress already checkpointed for
      // this table is untouched by this catch, so the next attempt
      // resumes from there rather than restarting from scratch.
    }
  }

  return {
    statusCode:
      failed.length > 0 && succeeded.length === 0 && partial.length === 0
        ? 500
        : 200,
    body: { succeeded, partial, failed },
  };
};

// Exposed only for local/manual test scripts to exercise individual pieces
// against real SPP data without going through the full handler (which
// requires the watermarks table and a real S3 master config to exist).
// Lambda only ever invokes exports.handler -- this is inert in production.
exports._internal = {
  buildReadXml,
  flattenFieldValue,
  extractSubFieldValue,
  fetchOnePage,
  runDeletedIdsPhase,
  runFieldDataPhase,
  runTableSync,
  deletedIdsS3Path,
  saveDeletedIdsToS3,
  loadDeletedIdsFromS3,
  mergeIntoS3Csv,
  readMasterConfig,
  getSyncState,
  saveBackfillProgress,
  completeBackfill,
  epochToDateParts,
  setupDuckDB,
};
