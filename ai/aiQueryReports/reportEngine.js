// The DuckDB-based SPP reporting engine: materializes the S3-synced CSVs
// (see sppDataSync.js) into in-memory tables per this company's
// stepwise_config.json (renamed from report_config.json -- same file, same
// shape; see loadReportConfig below), and answers schema/
// query/field-value requests against them. Deployed both as its own
// Lambda (aiQueryReports) and reused as-is (via ai/mcpServer/Dockerfile's
// COPY, and tools.js's require("./reportEngine.js")) inside sppMcpServer,
// the Lambda the Claude connector actually talks to -- the two always need
// redeploying together, since sppMcpServer bakes in its own copy of this
// exact file rather than calling the other Lambda.
//
// Docker deployment:
// Open Docker Desktop
// In PowerShell, Login:  aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 776528084998.dkr.ecr.us-east-2.amazonaws.com
// In PowerShell, Deploy: .\deploy.ps1

// deploy.ps1, buildspec.yml, and Dockerfile are included at the bottom of this file for reference.

// To redeploy sppMcpServer:
//docker buildx build --platform linux/amd64 --provenance=false --output=type=docker -f ai/mcpServer/Dockerfile -t spp-mcp-server . 2>&1 | tail -10 && \
// docker tag spp-mcp-server:latest 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest && \
// docker push 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest 2>&1 | tail -5 && \
// aws lambda update-function-code --function-name sppMcpServer --image-uri 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest --region us-east-2 --query "LastUpdateStatus" --output text && \
// aws lambda wait function-updated --function-name sppMcpServer --region us-east-2 && echo "sppMcpServer updated"

const { DuckDBInstance } = require("@duckdb/node-api");
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const instanceName = process.env.SPP_INSTANCE_NAME || "top-step-sandbox";
const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";
const basePath = `s3://${BUCKET}/${DATA_PREFIX}/${instanceName}`;
console.log("basePath: " + basePath);

// REPORT_VIEWS/DATE_COLUMNS/RELATIONSHIPS/FIELD_VALUES used to be hardcoded
// directly in this file -- one table -> S3 sync file mapping, one table ->
// date-column list, one column -> foreign-table join hint, one table's
// coded field values -> what they mean, all customer-specific. That meant
// a new customer needed their own COPY of this whole file, and every bug
// fix or improvement had to be applied N times across N copies. They're
// loaded at runtime instead, from this company's own S3 config file (see
// loadReportConfig below) -- this file is now identical across every
// customer; only spp-data/{company}/_config/stepwise_config.json differs.
// FIELD_VALUES used to be its own folder (_field-values/{viewName}.json,
// one lazily-fetched-and-cached S3 object per table) -- folded in here
// instead, since it's exactly the same kind of small, per-customer,
// hand-edited config as the other three, and didn't need its own S3
// round-trip mechanism separate from the config file that's already
// loaded once at cold start.
let REPORT_VIEWS = {};
let DATE_COLUMNS = {};
let RELATIONSHIPS = {};
let FIELD_VALUES = {};
// filterSets: static, hand-curated filter-set -> permitted-values gating
// for small reference tables the SPP REST API doesn't expose with
// filter-set enforcement (booking type, project stage, category, item,
// etc.) -- unlike projects/users/customers, which are scoped live per
// request via a cached per-user REST fetch (see ai/mcpServer/filterScope.js
// and sppRestClient.js), these tables are static enough that a hand-
// reviewed config is the right source of truth instead of a live SPP call.
// Missing/empty (section not present yet, or stepwise_config.json itself
// not loaded) is treated as "nothing curated yet", not an error -- every
// static-scoped table just fails closed (permits nothing) until real data
// exists here, rather than this Lambda refusing to start.
let FILTER_SETS = {};

// Per-role CRUD permissions (read gates table visibility on the MCP path;
// create/update/delete gate writes), keyed by role id (string) -- see
// resolveRolePermission below. Same "missing means fail closed" philosophy
// as FILTER_SETS: an un-curated role or table permits nothing rather than
// this Lambda refusing to start or silently allowing access.
let ROLE_PERMISSIONS = {};

// reportViews' raw pre-transform mapping (viewName -> bare SPP-side source
// file name, e.g. "timeEntries" -> "task"), kept alongside REPORT_VIEWS
// (which rewrites those same values into full S3 paths) since the write
// path needs the bare name to look up stepwise_mapping.csv's field mapping
// and the SPP XML recordType, not an S3 path.
let SOURCE_FILES = {};

const REPORT_CONFIG_PATH = `${basePath}/_config/stepwise_config.json`;

// --- Connection + materialization caching ---------------------------------
//
// Views were replaced with materialized tables: a view re-reads and
// re-parses every underlying CSV from S3 on every single query, which was
// almost certainly the single biggest contributor to per-query latency.
// A table is loaded into memory once (on a cold start / new connection)
// and every query after that runs against in-memory data.
//
// Trade-off: a warm container's data can go stale if the CSVs are
// refreshed in S3. STALENESS_CHECK_INTERVAL_MS below bounds how long a
// warm container can serve stale data before re-checking -- it does a
// cheap HeadObject (not a re-download) against each CSV and only
// re-materializes tables whose LastModified actually changed.

let cachedConnection = null;
let lastManifest = {}; // viewName -> ISO LastModified string, as of last (re)materialization
let lastStalenessCheckAt = 0;

const STALENESS_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let cachedSchema = null; // computed once per materialization, reused by getSchemas

const s3Client = new S3Client({});

const TYPE_MAP = [
  "Invalid",
  "Boolean",
  "TinyInt",
  "SmallInt",
  "Integer",
  "BigInt",
  "UnsignedTinyInt",
  "UnsignedSmallInt",
  "UnsignedInteger",
  "UnsignedBigInt",
  "Float",
  "Double",
  "Timestamp",
  "Date",
  "Time",
  "Interval",
  "HugeInt",
  "String",
  "Blob",
  "Decimal",
  "TimestampSeconds",
  "TimestampMilliseconds",
  "TimestampNanoseconds",
  "Enumeration",
  "List",
  "Struct",
  "Map",
  "UUID",
  "Union",
  "Bit",
  "TimeZone",
  "TimestampTimeZone",
  "UnsignedHugeInt",
  "Array",
];

// --- Mojibake repair for historical SPP data -------------------------------
//
// Confirmed via direct testing against real SPP notes data: years of free
// text in fields like charges.notes, tasks.name, and invoices.notes contain
// genuine mojibake -- UTF-8 bytes that got misread as Latin-1/cp1252 at some
// point in SPP's history (or an export/import step) and were permanently
// written back as the wrong characters (e.g. an accented "a" stored as two
// garbled characters instead of one accented character). That's data
// corruption baked into the source, not something we can fix by reading it
// differently now -- but it can often be reversed: re-encoding the (wrongly
// decoded) text as Latin-1 bytes and decoding those bytes as UTF-8
// frequently recovers the original text. This only works for genuine
// single-round Latin-1-as-UTF-8 corruption; text that doesn't match that
// pattern (or shows signs of multiple corruption passes) is returned
// unchanged rather than mangled further.

function repairMojibake(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  // Only attempt this if every character is in the Latin-1 range (0-255).
  // That's the actual signature of this corruption pattern; genuine other-
  // script text (CJK, emoji, etc.) would get mangled by this same trick, so
  // leave those alone.
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) {
      return text;
    }
  }

  try {
    const repaired = Buffer.from(text, "latin1").toString("utf8");
    // Node's utf8 decoder substitutes U+FFFD for invalid byte sequences
    // instead of throwing -- if that happened, the repair attempt produced
    // garbage, not real text, so don't trust it.
    return repaired.includes("\uFFFD") ? text : repaired;
  } catch {
    return text;
  }
}

function parseS3Path(s3Path) {
  // s3://bucket/key/with/slashes.csv -> { bucket, key }
  const withoutScheme = s3Path.replace(/^s3:\/\//, "");
  const firstSlash = withoutScheme.indexOf("/");
  return {
    bucket: withoutScheme.slice(0, firstSlash),
    key: withoutScheme.slice(firstSlash + 1),
  };
}

// (Re)loads REPORT_VIEWS/DATE_COLUMNS/RELATIONSHIPS from this company's S3
// config file -- called once at cold start, and again whenever the config
// file's own S3 timestamp changes (see setupConnection's staleness check),
// so a config edit rolls out the same way a data change already does,
// without needing a manual redeploy.
//
// Deliberately throws rather than leaving REPORT_VIEWS empty/stale on a
// missing or malformed file: a Lambda that silently starts up with zero
// tables looks exactly like "no data available" to whoever's asking, with
// nothing in the logs pointing at the real cause -- an obvious startup
// error is a much better failure mode than that.
async function loadReportConfig(connection) {
  const reader = await connection.runAndReadAll(
    `SELECT content FROM read_text('${REPORT_CONFIG_PATH}');`,
  );
  const rows = await reader.getRowObjects();
  if (!rows.length || !rows[0].content) {
    throw new Error(
      `stepwise_config.json not found or empty at ${REPORT_CONFIG_PATH}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rows[0].content);
  } catch (error) {
    throw new Error(
      `stepwise_config.json at ${REPORT_CONFIG_PATH} is not valid JSON: ${error.message}`,
    );
  }

  if (
    !parsed.reportViews ||
    typeof parsed.reportViews !== "object" ||
    Object.keys(parsed.reportViews).length === 0
  ) {
    throw new Error(
      `stepwise_config.json at ${REPORT_CONFIG_PATH} is missing a non-empty "reportViews" section`,
    );
  }

  // reportViews maps viewName -> bare sync filename (e.g. "slip", not a
  // full path) -- basePath is reconstructed here rather than stored in the
  // config file, so the same config still works if this company's data
  // ever moves to a different bucket/prefix.
  REPORT_VIEWS = Object.fromEntries(
    Object.entries(parsed.reportViews).map(([viewName, sourceFile]) => [
      viewName,
      `${basePath}/sync/${sourceFile}.csv`,
    ]),
  );
  SOURCE_FILES = { ...parsed.reportViews };
  DATE_COLUMNS = parsed.dateColumns ?? {};
  RELATIONSHIPS = parsed.relationships ?? {};
  FIELD_VALUES = parsed.fieldValues ?? {};
  FILTER_SETS = parsed.filterSets ?? {};
  ROLE_PERMISSIONS = parsed.rolePermissions ?? {};

  console.log(
    `Loaded stepwise_config.json: ${Object.keys(REPORT_VIEWS).length} views, ${Object.keys(FILTER_SETS).length} filter set(s), ${Object.keys(ROLE_PERMISSIONS).length} role(s) in rolePermissions`,
  );
}

async function getConfigLastModified() {
  const { bucket, key } = parseS3Path(REPORT_CONFIG_PATH);
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return head.LastModified ? head.LastModified.toISOString() : "unknown";
  } catch (error) {
    console.log(
      `HeadObject failed for stepwise_config.json (${REPORT_CONFIG_PATH}): ${error.message}`,
    );
    return null;
  }
}

let lastConfigModified = null;

// Resolves what a given filter set may see of one static-scoped table's
// values, from the already-loaded FILTER_SETS. Returns:
//   "all"        -- unrestricted, caller should apply no WHERE filtering
//   a Set<string> of permitted ids -- caller should filter to just these
//   null         -- fail closed (no filter set, unknown filter set, table
//                    not curated for this filter set, or explicit "none")
// The exhaustiveness the config format requires (every table listed for
// every filter set, per stepwise_config.json's filterSets section design)
// means a missing table key here is itself a sign the config is incomplete
// or hasn't caught up to a newly-added table yet -- null/fail-closed is the
// only safe response, same as every other "not sure" case in this function.
function resolveFilterSetPermittedValues(filterSetId, table) {
  if (filterSetId === null || filterSetId === undefined || filterSetId === "") {
    return null;
  }
  const filterSet = FILTER_SETS[String(filterSetId)];
  if (!filterSet || !filterSet.permittedValues) {
    return null;
  }
  const value = filterSet.permittedValues[table];
  if (value === "all") {
    return "all";
  }
  if (value === "none" || value === undefined || value === null) {
    return null;
  }
  if (typeof value === "object") {
    const permitted = new Set(
      Object.entries(value)
        .filter(([, setting]) => Number(setting) === 1)
        .map(([id]) => id),
    );
    return permitted;
  }
  return null;
}

// Resolves whether a given SPP role may perform a given action (read/
// create/update/delete) on a given table, from the already-loaded
// ROLE_PERMISSIONS. "read" gates table visibility on the MCP path
// (ai/mcpServer/filterScope.js hides any table the role can't read, on top
// of filter-set row scoping) and is also required for every write; this
// Lambda's own direct path doesn't consult it. Same fail-closed philosophy
// as resolveFilterSetPermittedValues: no role id, an unknown role, a table
// not curated for that role, or anything other than a literal 1 all deny --
// an incomplete or stale rolePermissions section must never silently grant
// access.
function resolveRolePermission(roleId, table, action) {
  if (roleId === null || roleId === undefined || roleId === "") {
    return false;
  }
  const role = ROLE_PERMISSIONS[String(roleId)];
  if (!role || !role.permissions) {
    return false;
  }
  const permission = role.permissions[table];
  if (!permission) {
    return false;
  }
  return Number(permission[action]) === 1;
}

// Bare SPP-side source file/table name for a view (e.g. "task" for
// "timeEntries") -- the write path needs this to look up
// stepwise_mapping.csv's field mapping and the SPP XML recordType;
// REPORT_VIEWS itself only holds the already-expanded S3 path. Returns null
// for an unknown view.
function getSourceFile(viewName) {
  return SOURCE_FILES[viewName] ?? null;
}

// Date-typed column names for a view, as curated in stepwise_config.json's
// dateColumns section -- the write path uses this to decide which fields
// need SPP's nested <Date><year>/<month>/<day></Date> XML wrapping instead
// of a plain text value. Always an array, never undefined.
function getDateColumns(viewName) {
  return DATE_COLUMNS[viewName] ?? [];
}

// Every view this company's stepwise_config.json declares -- the write path
// uses this to build its table enum dynamically per company/request rather
// than hardcoding a table list in code, so a company's actual synced table
// set is always the authority on what's writable-by-name, with no code
// change needed when it changes.
function getAllViewNames() {
  return Object.keys(REPORT_VIEWS);
}

// Every outgoing FK relationship declared FOR this table (i.e. every
// RELATIONSHIPS key of the form "table.column"), as [{column,
// referencesTable}]. Used by the write path's generic create-time
// visibility check: rather than a hand-maintained per-table function map,
// it walks whatever this table actually references (per the SAME
// relationships data getScopingPlan already uses for read-side cascade
// scoping) and checks each one against the caller's own scoped view. A
// table with no outgoing relationships (e.g. customers, which nothing
// else's RELATIONSHIPS entries have it referencing FROM) simply gets no
// create-time visibility check -- role permission alone gates it, which is
// the correct outcome: there's no existing related record to hide behind.
function getRelationshipsForTable(table) {
  const prefix = `${table}.`;
  return Object.entries(RELATIONSHIPS)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({
      column: key.slice(prefix.length),
      referencesTable: value.table,
    }));
}

// Computes the cascade plan for downstream filter-set enforcement: given a
// set of "root" scoped tables (each already restricted some other way --
// either live per-user REST access, or the static filter_sets config), finds
// every OTHER table that transitively references one of them via a foreign
// key (per RELATIONSHIPS) and therefore must ALSO exclude rows pointing at
// now-invisible parent records -- e.g. a project whose stage is hidden
// hides the project, which then hides every time entry/booking/charge that
// references THAT project, and so on. Requirement (confirmed with the
// user): downstream-only -- hiding a project must not hide its (upstream)
// customer, only things that reference the project.
//
// Returns an array, in dependency order (a table's prerequisites always
// come before it), of { table, cascadeConditions }, where cascadeConditions
// is [{ column, referencesTable }] -- every FK column on that table
// pointing at another table THIS SAME PLAN also scopes. The caller ANDs
// each condition (as "<column> IS NULL OR <column> IN (SELECT id FROM
// <referencesTable>)", referencing that table's ALREADY-BUILT scoped view)
// together with the table's own base restriction, if it has one (roots do;
// purely-cascaded tables don't and get no base restriction beyond this).
//
// Defensive by design, since this walks hand-edited config data across a
// warm container's whole lifetime: a relationship pointing at a table
// that's not in REPORT_VIEWS at all (typo, or a table dropped since) is
// silently skipped rather than crashing table materialization. Confirmed
// via direct testing that the real relationships graph has no cycles, but
// that's not something to trust blindly forever as stepwise_config.json
// keeps changing -- a genuine cycle among the remaining tables breaks it by
// placing them with no cascade conditions (their own base restriction, if
// any, still applies) and logging a warning, rather than looping forever.
function getScopingPlan(rootTables) {
  const rootSet = new Set(rootTables);
  const knownTables = new Set(Object.keys(REPORT_VIEWS));

  // sourceTable -> [{ column, targetTable }] -- only relationships between
  // two tables this Lambda actually has materialized.
  const outgoing = {};
  for (const [key, ref] of Object.entries(RELATIONSHIPS)) {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) continue;
    const sourceTable = key.slice(0, dotIndex);
    const column = key.slice(dotIndex + 1);
    if (!knownTables.has(sourceTable) || !ref?.table || !knownTables.has(ref.table)) {
      continue;
    }
    outgoing[sourceTable] = outgoing[sourceTable] || [];
    outgoing[sourceTable].push({ column, targetTable: ref.table });
  }

  // targetTable -> Set(sourceTable) that reference it -- the reverse index,
  // used to walk downstream from each root.
  const dependents = {};
  for (const [source, refs] of Object.entries(outgoing)) {
    for (const { targetTable } of refs) {
      dependents[targetTable] = dependents[targetTable] || new Set();
      dependents[targetTable].add(source);
    }
  }

  // Every table transitively downstream of a root, roots included.
  const affected = new Set(rootSet);
  const queue = [...rootSet];
  while (queue.length > 0) {
    const table = queue.shift();
    for (const dep of dependents[table] ?? []) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  // Topological order via Kahn's algorithm: a table is "ready" to place
  // once every affected table it references is already placed.
  const remaining = new Set(affected);
  const placed = new Set();
  const plan = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const table of [...remaining]) {
      const refs = (outgoing[table] ?? []).filter((r) => affected.has(r.targetTable));
      if (refs.every((r) => placed.has(r.targetTable))) {
        plan.push({
          table,
          cascadeConditions: refs.map((r) => ({
            column: r.column,
            referencesTable: r.targetTable,
          })),
        });
        placed.add(table);
        remaining.delete(table);
        progressed = true;
      }
    }
    if (!progressed) {
      console.error(
        `getScopingPlan: cycle detected among [${[...remaining].join(", ")}] -- placing them with no cascade conditions applied (their own base restriction, if any, still applies).`,
      );
      for (const table of remaining) {
        plan.push({ table, cascadeConditions: [] });
        placed.add(table);
      }
      remaining.clear();
    }
  }

  return plan;
}

async function getCurrentManifest() {
  const manifest = {};

  await Promise.all(
    Object.entries(REPORT_VIEWS).map(async ([viewName, s3PathOrPaths]) => {
      // Same "one path or many" handling as materializeTables -- a table
      // backed by multiple S3 files (e.g. charges: recent + historical)
      // needs every file checked; the table is treated as changed if ANY
      // of them have a newer LastModified than what's on record.
      const paths = Array.isArray(s3PathOrPaths)
        ? s3PathOrPaths
        : [s3PathOrPaths];

      try {
        const timestamps = await Promise.all(
          paths.map(async (s3Path) => {
            const { bucket, key } = parseS3Path(s3Path);
            const head = await s3Client.send(
              new HeadObjectCommand({ Bucket: bucket, Key: key }),
            );
            return head.LastModified
              ? head.LastModified.toISOString()
              : "unknown";
          }),
        );
        // Joined into one string so manifestsMatch's simple equality check
        // still works unchanged -- a single-path table just gets a
        // one-element join, identical to its old behavior.
        manifest[viewName] = timestamps.join("|");
      } catch (error) {
        // If we can't HEAD any one of them, don't block startup on this --
        // surface as unknown so a subsequent check will retry.
        console.log(
          `HeadObject failed for ${viewName} (${paths.join(", ")}): ${error.message}`,
        );
        manifest[viewName] = null;
      }
    }),
  );

  return manifest;
}

function manifestsMatch(a, b) {
  const keys = Object.keys(REPORT_VIEWS);
  return keys.every((key) => a[key] && a[key] === b[key]);
}

async function getNonEmptyPaths(paths) {
  // A source CSV that's genuinely 0 bytes (no header, no rows) makes
  // read_csv_auto fail outright -- it has nothing to sniff a schema from,
  // so the whole UNION ALL for that table blows up even though the sibling
  // file (historical or recent) has perfectly good data. Filter those out
  // before building the query. A HeadObject failure here (permissions,
  // transient network) is different from "confirmed empty" -- keep the
  // path in that case and let read_csv_auto surface the real problem,
  // rather than silently dropping a file we just couldn't check.
  const checked = await Promise.all(
    paths.map(async (path) => {
      try {
        const { bucket, key } = parseS3Path(path);
        const head = await s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { path, isEmpty: head.ContentLength === 0 };
      } catch (error) {
        console.log(
          `HeadObject failed for ${path} while checking for empty file (keeping it): ${error.message}`,
        );
        return { path, isEmpty: false };
      }
    }),
  );

  const nonEmpty = checked.filter((c) => !c.isEmpty).map((c) => c.path);
  const emptyPaths = checked.filter((c) => c.isEmpty).map((c) => c.path);

  if (emptyPaths.length > 0) {
    console.log(`Skipping empty source file(s): ${emptyPaths.join(", ")}`);
  }

  // If every path came back empty, fall back to the original list so the
  // table still gets created (empty, but with a real schema) rather than
  // handing materializeTables a zero-length union.
  return nonEmpty.length > 0 ? nonEmpty : paths;
}

// Returns the list of viewNames that failed to materialize (empty if all
// succeeded). Each table is isolated in its own try/catch -- one missing or
// malformed S3 file must not take down every OTHER table along with it.
// Confirmed happening in production: referencing a not-yet-synced table's
// file in REPORT_VIEWS threw on the very first table processed, aborting
// the whole loop and breaking every table, including 20+ that were working
// fine moments earlier. A failed table is simply never CREATEd (or, on a
// warm re-materialize, keeps whatever it had before -- CREATE OR REPLACE
// never runs, so the prior version isn't touched) -- getSchema separately
// skips any view that isn't actually queryable, so a broken table doesn't
// show up as available either.
async function materializeTables(connection, viewNames) {
  const failedViewNames = [];

  for (const viewName of viewNames) {
    try {
      await materializeOneTable(connection, viewName);
    } catch (error) {
      failedViewNames.push(viewName);
      console.error(
        `Failed to materialize "${viewName}" -- skipping it, other tables are unaffected: ${error.message}`,
      );
    }
  }

  if (failedViewNames.length > 0) {
    console.error(
      `materializeTables: ${failedViewNames.length} of ${viewNames.length} table(s) failed: ${failedViewNames.join(", ")}`,
    );
  }

  return failedViewNames;
}

async function materializeOneTable(connection, viewName) {
  {
    const s3Paths = REPORT_VIEWS[viewName];
    const allPaths = Array.isArray(s3Paths) ? s3Paths : [s3Paths];
    const paths = await getNonEmptyPaths(allPaths);
    const dateCols = DATE_COLUMNS[viewName] ?? [];

    // sample_size=-1 makes DuckDB scan the ENTIRE file to decide each
    // column's type, instead of just a sample (20480 rows by default).
    // Without this, a column can get auto-detected based on what LOOKS
    // like a consistent type in the sample (e.g. all-numeric), then blow
    // up later when a rare value outside that sample doesn't fit -- e.g.
    // a "*_filter" column that holds mostly single numeric IDs but
    // occasionally a comma-separated list like "124,67", which only
    // appeared beyond the default sample window. This is a different
    // failure class from the DATE_COLUMNS sentinel-value problem below:
    // that's a value that's genuinely incompatible with its real type no
    // matter how much you sample; this is auto-detection guessing the
    // wrong type in the first place. sample_size=-1 fixes the latter
    // category generally, for every column on every table, rather than
    // needing an explicit override added one crash at a time.
    const csvOptions = ["sample_size=-1"];

    if (dateCols.length > 0) {
      // read_csv_auto does its own type detection and casting DURING the
      // scan itself, before any outer SELECT runs -- so if it auto-detects
      // a column as DATE, it tries to parse every value into a real DATE
      // while reading the file, and "0000-00-00" fails right there. Our
      // NULLIF in the outer query never gets a chance to run on a column
      // that already blew up upstream. Fix: force these specific columns
      // to be read as plain VARCHAR (skipping DATE auto-detection
      // entirely), then NULLIF the sentinel on the safe string value and
      // cast to DATE ourselves only afterward, once it's gone. (This is
      // NOT something sample_size=-1 fixes on its own -- "0000-00-00" is a
      // real value that exists in a full scan too, and will still break a
      // DATE auto-detection/cast regardless of how much of the file is
      // sampled.)
      const typesOverride = dateCols
        .map((col) => `'${col}': 'VARCHAR'`)
        .join(", ");
      csvOptions.push(`types={${typesOverride}}`);
    }

    // Split tables (historical.csv + recent.csv) get UNION ALL'd here into
    // one logical source. Everything downstream of this -- date casting,
    // the materialized table name, and every query the AI agent writes --
    // stays completely unaware the underlying data ever lived in more than
    // one S3 file. Non-split tables (a single path) just get a one-branch
    // union, which is a no-op performance-wise.
    const unionedSource = paths
      .map(
        (path) =>
          `SELECT * FROM read_csv_auto('${path}', ${csvOptions.join(", ")})`,
      )
      .join(" UNION ALL ");

    // Different SPP tenants export dates in different formats depending on
    // regional/locale settings -- ISO (YYYY-MM-DD) in some datasets, US
    // style (M/D/YYYY) in others, sometimes even mixed within the same
    // column. A plain CAST(... AS DATE) only accepts ISO and fails hard on
    // anything else. try_strptime tries each format in the list in turn
    // and returns NULL (rather than erroring) if none match -- confirmed
    // via direct testing against ISO dates, US-style dates, the
    // "0000-00-00" sentinel, real NULLs, and genuinely invalid values, all
    // in the same column. Add more formats here if a future dataset uses
    // something else (e.g. "%d/%m/%Y" for day-first locales).
    //
    // '%Y-%m-%d %H:%M:%S' is required for sppDataSync's audit columns --
    // flattenFieldValue deliberately keeps full time-of-day precision for
    // created/updated (e.g. "2026-09-15 12:31:07"), unlike plain "date"
    // business fields, which stay date-only. Without this format,
    // try_strptime matches neither of the other two and CAST(NULL AS DATE)
    // silently succeeds -- confirmed live: 0 of 2310 projects had a
    // non-null "created" before this was added, despite every row having a
    // real value in the raw S3 file. The CAST to DATE below still drops
    // the time component on purpose, same as it always has -- this format
    // just lets a real value get through try_strptime in the first place.
    const DATE_FORMATS = ["'%Y-%m-%d %H:%M:%S'", "'%Y-%m-%d'", "'%m/%d/%Y'"];

    // Every sync file carries a synthetic "deleted" column (see
    // sppDataSync.js) that the old Celigo recent/historical files never
    // had -- EXCLUDE drops it from the materialized schema entirely (the
    // AI agent never sees or has to reason about it), and the WHERE below
    // drops the rows themselves, matching the old files' behavior of never
    // containing deleted records in the first place.
    const selectClause =
      dateCols.length > 0
        ? `SELECT * EXCLUDE (deleted) REPLACE (${dateCols
            .map(
              (col) =>
                `CAST(try_strptime(NULLIF("${col}", '0000-00-00'), [${DATE_FORMATS.join(", ")}]) AS DATE) AS "${col}"`,
            )
            .join(", ")})`
        : "SELECT * EXCLUDE (deleted)";

    const t0 = Date.now();
    // filterScope.js (ai/mcpServer/) renames a scoped table (projects,
    // users, customers, bookingTypes, projectStages, categories, items) to
    // "<name>_raw" and replaces "<name>" itself with a filtered VIEW, on
    // every authenticated request against a warm container. Once that's
    // happened even once, a plain `CREATE OR REPLACE TABLE <name>` here
    // throws ("Existing object <name> is of type View, trying to replace
    // with type Table") -- DuckDB's OR REPLACE won't swap object kinds --
    // and materializeTables' per-table try/catch swallows that silently, so
    // re-materialization quietly stops working for that table for the rest
    // of that container's lifetime. Confirmed happening in production: a
    // changed primary_filter_set on the users table never took effect on an
    // already-warm container no matter how long the staleness check had to
    // pick it up.
    //
    // Fix: unconditionally clear BOTH "<name>" and "<name>_raw", as
    // whichever object kind each currently is (at most one kind per name
    // ever actually exists; the other three attempts just get a "wrong
    // type" or "doesn't exist" error, safe to swallow). Clearing only
    // "<name>" is NOT enough on its own -- confirmed by testing -- it
    // leaves the OLD "<name>_raw" from the prior scoping pass behind, which
    // then collides with filterScope.js's next rename attempt ("Could not
    // rename... another entry with this name already exists"), and that
    // rename isn't wrapped in any try/catch, so it crashes the ENTIRE next
    // request instead of just leaving this one table stale. Dropping both
    // names' leftovers up front is what keeps filterScope.js's rename step
    // always landing on a genuinely empty "<name>_raw" slot.
    for (const candidate of [viewName, `${viewName}_raw`]) {
      try {
        await connection.run(`DROP TABLE IF EXISTS "${candidate}"`);
      } catch {}
      try {
        await connection.run(`DROP VIEW IF EXISTS "${candidate}"`);
      } catch {}
    }
    await connection.run(
      `CREATE TABLE ${viewName} AS ${selectClause} FROM (${unionedSource}) AS combined WHERE COALESCE(deleted, '0') != '1';`,
    );
    console.log(`Materialized "${viewName}" in ${Date.now() - t0}ms`);
  }
}

async function setupConnection(region, timings, { forceStalenessCheck = false } = {}) {
  const now = Date.now();

  if (cachedConnection) {
    const dueForStalenessCheck =
      forceStalenessCheck || now - lastStalenessCheckAt >= STALENESS_CHECK_INTERVAL_MS;

    if (!dueForStalenessCheck) {
      timings.connectionSource = "cached (no staleness check due)";
      return cachedConnection;
    }

    const t0 = Date.now();
    const currentConfigModified = await getConfigLastModified();
    timings.configCheckMs = Date.now() - t0;
    lastStalenessCheckAt = now;

    if (currentConfigModified !== null && currentConfigModified !== lastConfigModified) {
      // The company's stepwise_config.json itself changed -- the SET of
      // tables could be different now (one added, one removed), not just
      // individual CSVs, so this reloads the config and re-materializes
      // everything currently in it, same as a cold start does, rather
      // than trying to diff the old table set against the new one.
      console.log(
        "stepwise_config.json changed in S3 -- reloading config and re-materializing everything",
      );
      const tReload0 = Date.now();
      await loadReportConfig(cachedConnection);
      lastConfigModified = currentConfigModified;
      const failedViewNames = await materializeTables(
        cachedConnection,
        Object.keys(REPORT_VIEWS),
      );
      timings.rematerializeMs = Date.now() - tReload0;
      if (failedViewNames.length > 0) {
        timings.materializeFailures = failedViewNames;
      }

      lastManifest = await getCurrentManifest();
      cachedSchema = null;
      timings.connectionSource = "cached (config changed, full re-materialize)";
      return cachedConnection;
    }

    const t1 = Date.now();
    const currentManifest = await getCurrentManifest();
    timings.stalenessCheckMs = Date.now() - t1;

    if (manifestsMatch(currentManifest, lastManifest)) {
      timings.connectionSource = "cached (staleness check passed)";
      return cachedConnection;
    }

    console.log(
      "Source data changed in S3 -- re-materializing affected tables",
    );
    const changedTables = Object.keys(REPORT_VIEWS).filter(
      (viewName) => currentManifest[viewName] !== lastManifest[viewName],
    );

    const t2 = Date.now();
    const failedViewNames = await materializeTables(
      cachedConnection,
      changedTables,
    );
    timings.rematerializeMs = Date.now() - t2;
    if (failedViewNames.length > 0) {
      timings.materializeFailures = failedViewNames;
    }

    lastManifest = currentManifest;
    cachedSchema = null; // invalidate -- recomputed lazily on next getSchemas call
    timings.connectionSource = "cached (re-materialized stale tables)";
    return cachedConnection;
  }

  // Cold start: build everything from scratch.
  timings.connectionSource = "cold start";

  const t0 = Date.now();
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  timings.instanceCreateMs = Date.now() - t0;

  const t1 = Date.now();
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
  timings.extensionSetupMs = Date.now() - t1;
  // If this number is consistently large, the httpfs/aws extensions are
  // likely being fetched over the network on every cold start rather than
  // bundled in the image -- worth vendoring them into the Docker image.

  const tConfig = Date.now();
  await loadReportConfig(connection);
  lastConfigModified = await getConfigLastModified();
  timings.configLoadMs = Date.now() - tConfig;

  const t2 = Date.now();
  const failedViewNames = await materializeTables(
    connection,
    Object.keys(REPORT_VIEWS),
  );
  timings.materializeAllMs = Date.now() - t2;
  if (failedViewNames.length > 0) {
    timings.materializeFailures = failedViewNames;
  }

  lastManifest = await getCurrentManifest();
  lastStalenessCheckAt = Date.now();

  cachedConnection = connection;
  return cachedConnection;
}

async function getSchema(connection, timings) {
  if (cachedSchema) {
    timings.schemaSource = "cached";
    return cachedSchema;
  }

  const t0 = Date.now();
  const schema = {};
  for (const viewName of Object.keys(REPORT_VIEWS)) {
    try {
      schema[viewName] = await getTableSchema(connection, viewName);
    } catch (error) {
      // A view that failed to materialize (see materializeTables) was
      // never actually CREATEd, so introspecting it throws -- omit it from
      // the schema entirely rather than letting one broken table crash
      // getSchemas for every OTHER table too. The agent simply won't know
      // this table exists, same as if it weren't in REPORT_VIEWS at all.
      console.error(
        `Omitting "${viewName}" from schema -- not queryable: ${error.message}`,
      );
    }
  }
  timings.schemaComputeMs = Date.now() - t0;
  timings.schemaSource = "computed";

  cachedSchema = schema;
  return schema;
}

// Finds the first balanced {...} object in a string and returns it as a
// substring, ignoring anything before the opening brace or after its
// matching closing brace (e.g. a leaked "</invoke>" tag). Tracks whether
// we're inside a JSON string literal (and handles escaped quotes) so that
// braces appearing inside a SQL string value don't throw off the brace
// count. Returns null if no balanced object is found.
function extractJsonObject(str) {
  const start = str.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }

  return null; // never found a matching close brace
}

// Thrown for a bad tool call (missing/unknown parameter, invalid SQL shape,
// etc.) as opposed to a real server error -- callers turn this into a 400
// over HTTP, or feed .message straight back to the agent as a tool_result
// over the direct runAgent path, since these messages are already written
// as "fix and retry" instructions aimed at the model.
class ToolInputError extends Error {}

async function performGetSchemas(connection, timings) {
  const schema = await getSchema(connection, timings);
  return { schema };
}

// connection is unused here now -- field values come straight out of the
// already-loaded FIELD_VALUES (see loadReportConfig), no separate S3 read.
// Left in the signature to match performGetSchemas/performExecuteQuery's
// calling convention, since callers pass connection to all three uniformly.
async function performGetFieldValues(connection, table) {
  if (!table) {
    throw new ToolInputError("table parameter is required for getFieldValues");
  }
  if (!REPORT_VIEWS[table]) {
    throw new ToolInputError(
      `Unknown table "${table}". Must be one of: ${Object.keys(REPORT_VIEWS).join(", ")}`,
    );
  }

  const fieldValues = FIELD_VALUES[table] ?? {};
  return { table, fieldValues };
}

async function performExecuteQuery(connection, sqlQuery, timings) {
  if (!sqlQuery) {
    throw new ToolInputError("sql parameter is required for executeQuery");
  }
  // TODO: read-only guard belongs here - reject anything that isn't SELECT

  // Deterministic backstop against a recurring agent mistake: even with
  // explicit instructions (including a literal WRONG/RIGHT example), the
  // agent has repeatedly tried to "reconstruct" a column that's already
  // typed DATE by casting it to some other type and adding it to the Unix
  // epoch anchor (e.g. DATE '1970-01-01' + (col::INTEGER || ' days')::
  // INTERVAL). The agent varied the intermediate cast type across attempts
  // (INTEGER, then TEXT) while keeping the same fundamentally wrong shape --
  // a guard checking for one specific cast type only catches that one
  // variant and misses the next. Checking for the epoch anchor literal
  // itself is far more robust: no legitimate SPP business question has any
  // reason to reference 1970-01-01, so this one check catches every
  // cast-type variant of the same mistake without needing to enumerate them.
  if (/1970-01-01/.test(sqlQuery)) {
    console.log(
      `Rejected query: epoch-anchor date reconstruction attempted. SQL: ${sqlQuery}`,
    );
    throw new ToolInputError(
      `INVALID QUERY -- DO NOT SHOW THIS ERROR TO THE USER. Fix and ` +
        `re-run the query now -- this is a mistake you can correct ` +
        `immediately, not something to report. This query attempts to ` +
        `reconstruct a date value using the 1970-01-01 epoch anchor plus ` +
        `interval arithmetic. This is never correct in this data: every ` +
        `column reported as type Date or Timestamp by getSchemas is ` +
        `already a real date value and needs no such reconstruction, ` +
        `regardless of what type you cast it to first (INTEGER, TEXT, or ` +
        `anything else). Remove the epoch-arithmetic entirely and select ` +
        `the date column directly, e.g. "start_date" AS start_date, with ` +
        `no CAST at all. Retry the corrected query now before responding ` +
        `to the user.`,
    );
  }

  const queryStart = Date.now();
  let reader;
  try {
    reader = await connection.runAndReadAll(sqlQuery);
  } catch (queryError) {
    // The agent has occasionally fabricated a column/table name that was
    // never real in this schema (not a type-confusion or data-quirk issue --
    // just an invented name, e.g. "state_region" when the actual column is
    // "state"). DuckDB's own binder error is already quite good here -- it
    // typically suggests the real column name via "Candidate bindings" --
    // but left as a plain error, that hint has nowhere useful to go; it
    // just surfaces as a confusing failure instead of the agent silently
    // correcting itself. Same "fix and retry now" framing as the
    // epoch-anchor guard above, applied here to any "doesn't exist" binder
    // error instead of one specific bad column name.
    const isMissingColumnOrTable =
      /binder error/i.test(queryError.message) &&
      (/does not have a column named/i.test(queryError.message) ||
        /does not exist/i.test(queryError.message) ||
        /candidate bindings/i.test(queryError.message));

    if (isMissingColumnOrTable) {
      console.log(
        `Rejected query: referenced a column/table that does not exist. SQL: ${sqlQuery} -- Error: ${queryError.message}`,
      );
      throw new ToolInputError(
        `INVALID QUERY -- DO NOT SHOW THIS ERROR TO THE USER. This query ` +
          `referenced a column or table name that does not actually exist ` +
          `in this schema -- do not guess or assume a name based on what ` +
          `seems plausible. Call action="getSchemas" again to confirm the ` +
          `exact real column/table names (the error below may already ` +
          `suggest the correct one), then rewrite and retry the query now, ` +
          `before responding to the user. Original error: ${queryError.message}`,
      );
    }

    throw queryError;
  }
  timings.queryExecMs = Date.now() - queryStart;

  const rows = await reader.getRowObjects();
  const cleanedRows = cleanRows(rows);
  console.log(
    `Query executed: ${sqlQuery} -- timings: ${JSON.stringify(timings)}`,
  );
  return { rows: cleanedRows };
}

// --- Agent (Claude) configuration ------------------------------------------
//
// Runs the tool-calling loop directly against the Anthropic API -- this
// Lambda used to be a pure DuckDB tool called by a Celigo-hosted agent flow;
// it now also IS the agent, since Celigo has been removed from the
// pipeline. aiProcessQuestions.mjs still builds the augmented prompt (today's
// date, terminology definitions, conversation history) and hands it off here
// via an async Lambda invoke; this file owns the model calls, the tool loop,
// and reporting the outcome back over HTTP.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const CALLBACK_URL = process.env.CALLBACK_URL;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const MAX_AGENT_ITERATIONS = 25;
const AGENT_MAX_TOKENS = 8192;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const AGENT_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "agent-instructions.txt"),
  "utf8",
);
const AGENT_TOOL_DESCRIPTION = fs.readFileSync(
  path.join(__dirname, "tool-description.txt"),
  "utf8",
);

const AGENT_TOOL_DEFINITION = {
  name: "query_spp_data",
  description: AGENT_TOOL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["getSchemas", "getFieldValues", "executeQuery"],
        description: "Which step to perform.",
      },
      table: {
        type: "string",
        description: 'Table name -- required when action is "getFieldValues".',
      },
      sql: {
        type: "string",
        description:
          'A single read-only SELECT statement -- required when action is "executeQuery".',
      },
    },
    required: ["action"],
  },
};

async function executeAgentTool(connection, input, timings) {
  try {
    const action = input?.action;

    if (action === "getSchemas") {
      return JSON.stringify(await performGetSchemas(connection, timings));
    }
    if (action === "getFieldValues") {
      return JSON.stringify(
        await performGetFieldValues(connection, input.table),
      );
    }
    if (action === "executeQuery") {
      return JSON.stringify(
        await performExecuteQuery(connection, input.sql, timings),
        (k, v) => (typeof v === "bigint" ? v.toString() : v),
      );
    }

    return JSON.stringify({
      error: `Unknown action "${action}". Must be "getSchemas", "getFieldValues", or "executeQuery".`,
    });
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

async function runAgent(payload, timings) {
  const region = payload.region || process.env.AWS_REGION || "us-east-2";
  const connection = await setupConnection(region, timings);

  const messages = [{ role: "user", content: payload.question }];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      system: AGENT_SYSTEM_PROMPT,
      tools: [AGENT_TOOL_DEFINITION],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const resultText = await executeAgentTool(
        connection,
        block.input,
        timings,
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultText,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(
    `Agent exceeded ${MAX_AGENT_ITERATIONS} tool-call iterations without producing a final answer.`,
  );
}

async function reportOutcome(payload) {
  try {
    const response = await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, callbackSecret: CALLBACK_SECRET }),
    });
    if (!response.ok) {
      console.error(
        `Callback POST failed with HTTP ${response.status}:`,
        await response.text(),
      );
    }
  } catch (error) {
    console.error("Could not POST outcome back to the callback URL:", error);
  }
}

// Invoked asynchronously (InvocationType "Event") by aiProcessQuestions.mjs,
// so the payload arrives as the raw `event` object directly -- no
// requestContext/body wrapper like the HTTP actions below get. Never lets an
// error escape this function: an uncaught throw here would make Lambda retry
// the async invocation automatically (up to twice more), which would re-run
// the whole agent loop and could double-answer or double-bill. Failures are
// instead reported to aiProcessQuestions.mjs via the "fail" callback action.
async function handleRunAgent(payload, timings, handlerStart) {
  const { requestId } = payload;

  try {
    const answer = await runAgent(payload, timings);
    await reportOutcome({ action: "complete", requestId, answer });
  } catch (error) {
    console.error(`runAgent failed for requestId ${requestId}:`, error);
    await reportOutcome({ action: "fail", requestId, error: error.message });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      requestId,
      timingsMs: finalizeTimings(timings, handlerStart),
    }),
  };
}

exports.handler = async (event) => {
  const handlerStart = Date.now();
  const timings = {};

  console.log("Received event (v22):", JSON.stringify(event, null, 2));

  if (event.action === "runAgent") {
    return await handleRunAgent(event, timings, handlerStart);
  }

  const rawBody = JSON.parse(event.body);

  // This HTTP entry point (getQuestion/getSchemas/getFieldValues/
  // executeQuery) is no longer used by the normal question-answering flow --
  // the runAgent path above calls performGetSchemas/performGetFieldValues/
  // performExecuteQuery directly, in-process. It's kept as a plain HTTP
  // interface for manual testing/debugging. The shape-normalization below
  // was originally a workaround for Celigo's own tool-call relay mangling
  // its payloads (stringified "input", leaked "</invoke>" tags); it's
  // vestigial now that nothing calls this over HTTP with that shape, but
  // it's harmless to leave in place as a tolerant parser. Observed shapes:
  //   1. { input: { action, sql, ... } }        -- the normal, correct shape
  //   2. { action, sql, ... }                    -- "input" wrapper dropped entirely
  //   3. { input: "{\"action\":...,\"sql\":...}" } -- "input" present but stringified
  //      instead of a real nested object
  //   4. { input: "{\"action\":...,\"sql\":...}\n</invoke>" } -- stringified JSON
  //      PLUS leaked internal formatting (an XML-style tool-call closing tag)
  //      appended after it, making the whole string invalid JSON on its own
  // Normalize all of these to a plain object rather than failing the
  // request.
  let eventBody;
  let normalizedShape = null;

  if (rawBody.input && typeof rawBody.input === "object") {
    eventBody = rawBody.input;
  } else if (typeof rawBody.input === "string") {
    try {
      eventBody = JSON.parse(rawBody.input);
      normalizedShape = "input was a JSON string, parsed it";
    } catch (firstError) {
      // The plain string wasn't valid JSON on its own -- try extracting a
      // balanced {...} object from within it and ignoring anything (like a
      // leaked closing tag) trailing after that object.
      const extracted = extractJsonObject(rawBody.input);
      if (extracted !== null) {
        try {
          eventBody = JSON.parse(extracted);
          normalizedShape =
            "input was a JSON string with trailing garbage after it, extracted the object";
        } catch (secondError) {
          console.error(
            'Tool call had a string "input"; extracted a {...} substring but it still failed to parse:',
            rawBody.input,
            secondError.message,
          );
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: `"input" was a string that could not be parsed as JSON, even after extracting what looked like a JSON object: ${secondError.message}`,
            }),
          };
        }
      } else {
        console.error(
          'Tool call had a string "input" that failed to parse as JSON:',
          rawBody.input,
          firstError.message,
        );
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `"input" was a string that could not be parsed as JSON: ${firstError.message}`,
          }),
        };
      }
    }
  } else if (rawBody.action || rawBody.sql || rawBody.table) {
    eventBody = rawBody;
    normalizedShape = 'no "input" wrapper, used top-level fields';
  } else {
    eventBody = rawBody;
  }

  if (normalizedShape) {
    console.log(
      `Normalized malformed tool call (${normalizedShape}). Raw body:`,
      JSON.stringify(rawBody),
    );
  }

  const region = eventBody.region || process.env.AWS_REGION || "us-east-2";
  const action = eventBody.action;

  try {
    const connectionStart = Date.now();
    const connection = await setupConnection(region, timings);
    timings.setupConnectionMs = Date.now() - connectionStart;

    if (action === "getQuestion") {
      try {
        const questionId = eventBody.questionId;
        const question = testQuestions.find((q) => q.id === questionId);
        console.log(
          `getQuestion for id ${questionId}: ${JSON.stringify(question)}`,
        );
        return {
          statusCode: 200,
          body: JSON.stringify({
            ...question,
            timingsMs: finalizeTimings(timings, handlerStart),
          }),
        };
      } catch (error) {
        console.error("getQuestion error:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: error.message }),
        };
      }
    }

    if (action === "getSchemas") {
      const result = await performGetSchemas(connection, timings);
      return {
        statusCode: 200,
        body: JSON.stringify({
          ...result,
          timingsMs: finalizeTimings(timings, handlerStart),
        }),
      };
    }

    if (action === "getFieldValues") {
      try {
        const result = await performGetFieldValues(connection, eventBody.table);
        return {
          statusCode: 200,
          body: JSON.stringify({
            ...result,
            timingsMs: finalizeTimings(timings, handlerStart),
          }),
        };
      } catch (error) {
        if (error instanceof ToolInputError) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: error.message }),
          };
        }
        throw error;
      }
    }

    if (action === "executeQuery") {
      try {
        const result = await performExecuteQuery(
          connection,
          eventBody.sql,
          timings,
        );
        return {
          statusCode: 200,
          body: JSON.stringify(
            {
              ...result,
              timingsMs: finalizeTimings(timings, handlerStart),
            },
            (k, v) => (typeof v === "bigint" ? v.toString() : v),
          ),
        };
      } catch (error) {
        if (error instanceof ToolInputError) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: error.message }),
          };
        }
        throw error;
      }
    }

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Unknown action "${action}". Must be "getSchemas", "getFieldValues", or "executeQuery".`,
      }),
    };
  } catch (error) {
    console.error("Handler error:", error, "timings so far:", timings);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timingsMs: finalizeTimings(timings, handlerStart),
      }),
    };
  }
};

function finalizeTimings(timings, handlerStart) {
  timings.totalHandlerMs = Date.now() - handlerStart;
  return timings;
}

// Additive export, purely for reuse by ai/mcpServer -- nothing above this
// line changes behavior for the existing Lambda entry point (exports.handler).
Object.assign(exports, {
  setupConnection,
  performGetSchemas,
  performGetFieldValues,
  performExecuteQuery,
  ToolInputError,
  // Consumed by ai/mcpServer/filterScope.js for static-reference-table
  // filter-set scoping (booking type, project stage, category, item, ...).
  // Exported as a function, not the raw FILTER_SETS object, since FILTER_SETS
  // is a reassigned `let` -- a destructured reference to the object itself
  // would go stale the moment loadReportConfig() reloads it (same class of
  // bug as destructuring a live-reassigned export anywhere else in this
  // codebase; this function always reads the current value instead).
  resolveFilterSetPermittedValues,
  // Same reasoning as resolveFilterSetPermittedValues above -- reads
  // RELATIONSHIPS/REPORT_VIEWS live rather than being handed a
  // point-in-time copy, so it stays correct across a stepwise_config.json
  // reload without filterScope.js needing to know or care.
  getScopingPlan,
  // Consumed by ai/mcpServer/sppWritePermissions.js (role-based write
  // gating) and ai/mcpServer/sppWriteClient.js (source-file/date-column
  // lookups for building SPP XML write requests) -- same live-read
  // reasoning as the two exports above.
  resolveRolePermission,
  getSourceFile,
  getDateColumns,
  getAllViewNames,
  getRelationshipsForTable,
});

function cleanRows(rows) {
  return rows.map((row) => {
    const cleaned = {};
    for (const [key, value] of Object.entries(row)) {
      if (value && typeof value === "object" && "micros" in value) {
        // convert DuckDB TIMESTAMP micros to an ISO string
        const micros =
          typeof value.micros === "bigint"
            ? value.micros
            : BigInt(value.micros);
        cleaned[key] = new Date(Number(micros / 1000n)).toISOString();
      } else if (value && typeof value === "object" && "days" in value) {
        // convert DuckDB DATE days-since-epoch to a plain "YYYY-MM-DD"
        // string -- every date-typed column in this schema is CAST to DATE
        // (see materializeOneTable), so this struct is common, not an edge
        // case. Confirmed reaching a client unconverted (as a raw
        // {"days": N} object) before this branch existed.
        const days =
          typeof value.days === "bigint" ? Number(value.days) : value.days;
        cleaned[key] = new Date(days * 86400000).toISOString().slice(0, 10);
      } else if (value === "0000-00-00") {
        cleaned[key] = null;
      } else if (typeof value === "string") {
        cleaned[key] = repairMojibake(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

async function getTableSchema(connection, viewName) {
  // Introspects "<name>_raw" when it exists (ai/mcpServer's filterScope.js
  // renames every table to that and only re-exposes "<name>" to callers
  // whose role can read it) -- the schema is cached across callers, so it
  // must not depend on whether the request that happened to compute it
  // could see the table. Same columns either way; falls back to the plain
  // name for this Lambda's own direct path, where nothing is ever renamed.
  let reader;
  try {
    reader = await connection.runAndReadAll(`SELECT * FROM "${viewName}_raw" LIMIT 0;`);
  } catch {
    reader = await connection.runAndReadAll(`SELECT * FROM ${viewName} LIMIT 0;`);
  }
  const rawColumns = reader.columnNameAndTypeObjectsJson();

  return rawColumns.map((col) => {
    const entry = {
      name: col.columnName,
      type: TYPE_MAP[col.columnType.typeId],
    };

    const relKey = `${viewName}.${col.columnName}`;
    if (RELATIONSHIPS[relKey]) {
      entry.references = RELATIONSHIPS[relKey];
    }

    return entry;
  });
}

const testQuestions = [
  { id: 1, text: "What is the name of project 11?" },
  {
    id: 2,
    text: "Please list all of the projects with project_stage_id of 6 that are owned by Tres Churchill that do not have any bookings in 2025, meaning projects where the record count for bookings is zero.  Include the customer name, the project name, and the project id so I can tell them apart.",
  },
  {
    id: 3,
    text: "I need to know all of the users that were overutilized or underutilized in March of 2025.  Over-utilized means they had over 100 hours of time on projects that did not have a stage of 'Internal'.  Under-utilized means they had less than 40 hours of time on projects that did not have a stage of 'Internal'.  Please show each over- or under-utilized user and the hours they had in March of 2025.",
  },
  {
    id: 4,
    text: "I'd like to know how many hours have been put against each BGB Group project (BGB Group is the customer), and how much we've charged for each one",
  },
];

/* deploy.ps1 batch file:
$ErrorActionPreference = "Stop"

$AccountId = "776528084998"
$Region = "us-east-2"
$RepoName = "node-duckdb-lambda"
$FunctionName = "aiQueryReports"
$ImageUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$RepoName`:latest"

Write-Host "Building image..." -ForegroundColor Cyan
docker buildx build --platform linux/amd64 --provenance=false --output=type=docker -t $RepoName .

Write-Host "Tagging image..." -ForegroundColor Cyan
docker tag "$RepoName`:latest" $ImageUri

Write-Host "Pushing to ECR..." -ForegroundColor Cyan
docker push $ImageUri

Write-Host "Updating Lambda function..." -ForegroundColor Cyan
$env:AWS_PAGER = ""
aws lambda update-function-code --function-name $FunctionName --image-uri $ImageUri --query "LastUpdateStatus" --output text

Write-Host "Done." -ForegroundColor Green
*/

/* buildspec.yml file:

version: 0.2

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI
  build:
    commands:
      - echo Build started on `date`
      - echo Building the Docker image...
      - docker build -t $REPOSITORY_URI:latest .
  post_build:
    commands:
      - echo Build completed on `date`
      - echo Pushing the Docker image...
      - docker push $REPOSITORY_URI:latest

*/

/* Dockerfile:

# Use the official AWS Lambda Node 24 image
FROM public.ecr.aws/lambda/nodejs:24

# Copy package.json over to the image
COPY package.json ${LAMBDA_TASK_ROOT}

# Install dependencies inside the Linux container so the binaries match AWS
RUN npm install

# Copy your actual code
COPY reportEngine.js ${LAMBDA_TASK_ROOT}

# Tell Lambda which function file and method to execute
CMD [ "reportEngine.handler" ]

*/
