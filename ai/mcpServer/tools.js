const { z } = require("zod");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

// Reused as-is from aiQueryReports/reportEngine.js -- see the additive
// Object.assign(exports, ...) at the bottom of that file. This file is
// COPY'd alongside reportEngine.js into the same Lambda image (see
// Dockerfile), so this relative require resolves within one deployment
// package even though the two Lambdas are deployed separately.
const {
  setupConnection,
  performGetSchemas,
  performGetFieldValues,
  performExecuteQuery,
  ToolInputError,
  getAllViewNames,
} = require("./reportEngine.js");

const sppUserAuth = require("./sppUserAuth.js");
const sppRestClient = require("./sppRestClient.js");
const filterCache = require("./filterCache.js");
// registerWriteTools takes wrapToolHandler as a parameter rather than
// requiring this file back (writeTools.js needing textResult/errorResult/
// wrapToolHandler, all defined below) -- this file already requires
// writeTools.js, so a require in the other direction would be circular and
// resolve to an incomplete module.exports (this file's own exports aren't
// populated until the very bottom of this file).
const { registerWriteTools } = require("./writeTools.js");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TERMS_TABLE = process.env.TERMS_TABLE;

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        // DuckDB returns BigInt for COUNT()/SUM() etc. on integer columns --
        // plain JSON.stringify throws on those, so it needs the same
        // BigInt-safe replacer reportEngine.js's own callers use.
        text: JSON.stringify(value, (k, v) => (typeof v === "bigint" ? v.toString() : v)),
      },
    ],
  };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wraps a tool handler so a ToolInputError (a deliberate "fix and retry"
// message aimed at the model -- see reportEngine.js) comes back as a normal tool
// result with isError:true, exactly like the runAgent path already does via
// executeAgentTool. Any other, unexpected error also becomes an isError
// result rather than a JSON-RPC-level failure, so the model sees it and can
// react instead of the whole tool call just breaking.
function wrapToolHandler(handler) {
  return async (args) => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      if (error instanceof ToolInputError) {
        return errorResult(error.message);
      }
      console.error("Tool handler error:", error);
      return errorResult(error.message || "Unexpected error");
    }
  };
}

async function listTerminology() {
  const result = await dynamo.send(new ScanCommand({ TableName: TERMS_TABLE }));
  const definitions = (result.Items ?? []).sort((a, b) =>
    a.term.localeCompare(b.term),
  );
  return { definitions };
}

async function saveTerminology(term, definition) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new PutCommand({
      TableName: TERMS_TABLE,
      Item: { term, definition, updatedAt: now },
    }),
  );
  return { term, definition };
}

async function deleteTerminology(term) {
  await dynamo.send(new DeleteCommand({ TableName: TERMS_TABLE, Key: { term } }));
  return { term, deleted: true };
}

// Registers every tool on a fresh McpServer instance. connection/timings are
// created once per Lambda invocation in mcp-handler.js and threaded through
// here so every tool call in that request shares the same warm DuckDB
// connection (setupConnection caches it across invocations too, same as the
// existing runAgent path in reportEngine.js). email identifies the authenticated
// caller (from the JWT claims API Gateway validated) -- used to scope their
// SPP connection and, indirectly via the "projects"/"users" views
// filterScope.js already rebuilt for this request, their query results.
// Shared with mcp-handler.js's fast path (see there for why): these two
// tools never touch DuckDB/materialized SPP data at all -- only the OAuth
// token store, the filter cache, and (sync_spp_access only) a live SPP
// REST call -- so their actual logic lives here as plain functions taking
// just `email`, callable identically whether or not a `connection` exists
// yet. registerTools below still wraps them for the normal path (which is
// what answers tools/list either way), but the fast path in mcp-handler.js
// calls these directly, skipping setupConnection/applyFilterScope entirely.
//
// permittedProjectCount/permittedUserCount here are the raw REST-cache
// counts (what SPP's own filter-set-scoped REST API grants), NOT the
// further-locally-restricted count a scoped DuckDB view would show (e.g.
// after project-stage cascading) -- deliberately, so this stays fast and
// connection-independent. A previous version queried the scoped view for
// a more accurate number; reverted after confirming in production that
// doing so required full table materialization, which is exactly the
// multi-second cold-start cost this whole fast path exists to avoid.
async function doCheckSppAccessStatus(email) {
  if (!email) {
    throw new ToolInputError("Could not determine the caller's identity.");
  }
  const [accessToken, cached] = await Promise.all([
    sppUserAuth.getSppAccessTokenForUser(email),
    filterCache.getCachedPermittedIds(email),
  ]);
  return {
    connected: accessToken !== null,
    synced: cached !== null,
    permittedProjectCount: cached?.projects?.length ?? 0,
    permittedUserCount: cached?.users?.length ?? 0,
    lastSyncedAt: cached?.updatedAt
      ? new Date(cached.updatedAt * 1000).toISOString()
      : null,
  };
}

async function doSyncSppAccess(email) {
  if (!email) {
    throw new ToolInputError(
      "Could not determine the caller's identity -- cannot sync SPP access.",
    );
  }
  const ids = await sppRestClient.fetchPermittedIdsForUser(email);
  if (!ids) {
    throw new ToolInputError(
      "This user hasn't connected their SPP account yet -- call connect_spp_account first.",
    );
  }
  await filterCache.savePermittedIds(email, ids);
  return { projects: ids.projects.length, users: ids.users.length };
}

// filterScope.js keeps every table's real data under "<name>_raw" (and
// row-scoped data under "<name>_scoped"), exposing only "<name>" -- and
// only for tables the caller's role can read. Those internal names live in
// the same DuckDB connection the model's SQL runs against, so without this
// a query could name them directly and bypass both role visibility and row
// scoping. DuckDB also volunteers them unprompted: a query against a hidden
// table fails with "did you mean <name>_raw?", which performExecuteQuery's
// own error handling tells the model to act on. So: reject any SQL that
// names one, and scrub them from any error text passed back.
function internalNamePattern() {
  const names = getAllViewNames().flatMap((name) => [`${name}_raw`, `${name}_scoped`]);
  if (names.length === 0) return null;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
}

async function executeCallerQuery(connection, sql, timings) {
  const pattern = internalNamePattern();
  if (pattern && pattern.test(sql)) {
    console.log(`Rejected query: referenced an internal table name. SQL: ${sql}`);
    throw new ToolInputError(
      "That table is not available. Use only the table names returned by get_spp_schemas.",
    );
  }
  try {
    return await performExecuteQuery(connection, sql, timings);
  } catch (error) {
    if (pattern) {
      pattern.lastIndex = 0;
      error.message = error.message.replace(pattern, "[unavailable]");
    }
    throw error;
  }
}

// get_spp_schemas' cached schema covers every table, for every caller --
// trimmed here to just this caller's readable tables, with any "references"
// pointing at a hidden table dropped too, so a hidden table's name never
// reaches the model even indirectly.
function schemaForCaller({ schema }, readableTables) {
  const readable = new Set(readableTables);
  const filtered = {};
  for (const [table, columns] of Object.entries(schema)) {
    if (!readable.has(table)) continue;
    filtered[table] = columns.map((column) => {
      if (column.references && !readable.has(column.references.table)) {
        const { references, ...rest } = column;
        return rest;
      }
      return column;
    });
  }
  return { schema: filtered };
}

function registerTools(server, connection, timings, email, hasSyncedAccess, readableTables) {
  server.registerTool(
    "check_spp_access_status",
    {
      title: "Check SPP access status",
      description:
        "Reports the ground truth of this user's SPP connection: whether " +
        "they've connected their account, and whether their Projects/Users " +
        "access has been synced yet. Call this BEFORE telling the user " +
        "their account is connected, and BEFORE concluding that empty " +
        "Projects/Users results indicate a bug or a restrictive filter " +
        "set -- the most common cause by far is simply that the account " +
        "isn't connected yet or hasn't synced. Never assert connection " +
        "status from a query result alone; a query returning zero rows " +
        "looks identical whether the account is connected with genuinely " +
        "no access or not connected at all -- this tool is the only way " +
        "to actually tell those apart. permittedProjectCount/" +
        "permittedUserCount reflect SPP's own filter-set-scoped REST " +
        "access -- a table like Projects can still show fewer rows than " +
        "this if an additional LOCAL restriction applies (e.g. a hidden " +
        "project stage) that SPP's own access model has no concept of; " +
        "that's expected, not a sync bug.",
      inputSchema: {},
    },
    wrapToolHandler(async () => doCheckSppAccessStatus(email)),
  );

  server.registerTool(
    "connect_spp_account",
    {
      title: "Connect SPP account",
      description:
        "Returns a link for the user to connect their own SuiteProjects " +
        "Pro (SPP) account. IMPORTANT: calling this tool does NOT connect " +
        "the account by itself -- it only generates a link. The account " +
        "is connected only once the user opens that link in a browser and " +
        "signs in to SPP themselves. You MUST display the exact URL text " +
        "from the response as a link the user can click, and you MUST NOT " +
        "tell the user their account is connected, is being connected, or " +
        "is in the process of connecting -- say only that you've generated " +
        "a link and they need to open it and sign in. Until they do that, " +
        "questions about Projects or Users will return no results, since " +
        "those two record types are scoped to whatever that specific " +
        "person is allowed to see in SPP (their filter set) -- there is " +
        "no default/shared access. Call this if the user asks to connect " +
        "their account, or if a Projects/Users query unexpectedly comes " +
        "back empty and they haven't connected yet.",
      inputSchema: {},
    },
    wrapToolHandler(async () => {
      if (!email) {
        throw new ToolInputError(
          "Could not determine the caller's identity -- cannot start an SPP connection.",
        );
      }
      const url = await sppUserAuth.getSppConnectionUrl(email);
      return {
        connectionUrl: url,
        instructionsForAssistant:
          "Display this exact URL to the user as a clickable link now. Do " +
          "not say their account is connected -- it isn't yet. Tell them " +
          "to open the link and sign in to SPP; only that step actually " +
          "connects it. After they confirm they've done that, call " +
          "sync_spp_access to pull in their access immediately.",
      };
    }),
  );

  server.registerTool(
    "sync_spp_access",
    {
      title: "Sync SPP access",
      description:
        "Immediately refreshes the user's Projects/Users access from SPP, " +
        "rather than waiting for the periodic background refresh. Call " +
        "this right after the user says they've connected their SPP " +
        "account (via connect_spp_account), or if they report their " +
        "access looks out of date.",
      inputSchema: {},
    },
    wrapToolHandler(async () => doSyncSppAccess(email)),
  );
  server.registerTool(
    "get_spp_schemas",
    {
      title: "Get SPP schemas",
      description:
        "Returns the available SuiteProjects Pro (SPP) tables and their " +
        "exact column names/types -- column names may include spaces or " +
        "special characters requiring double-quotes in SQL. A column with a " +
        "\"values\" property stores codes, not display text: \"values\" maps " +
        "each stored code to its meaning (e.g. {\"1\": \"Not Sent\"}) -- filter " +
        "on the code and translate it for the user; never guess what a code " +
        "means. Call this once " +
        "before writing any query in a conversation; you do not need to " +
        "call it again on later questions unless a query fails because it " +
        "references a table/column that doesn't exist.",
      inputSchema: {},
    },
    wrapToolHandler(async () =>
      schemaForCaller(await performGetSchemas(connection, timings), readableTables),
    ),
  );

  server.registerTool(
    "get_spp_field_values",
    {
      title: "Get SPP coded field values",
      description:
        "Before filtering or displaying any column whose values are not " +
        "obviously plain text (short codes, abbreviations, single " +
        "letters/numbers), call this with that table's name. Returns a map " +
        "of the table's coded fields to their meanings (e.g. a billing " +
        "rule \"type\" column where \"F\" means \"Fixed Fee\"). Use the " +
        "returned mapping to translate a natural-language value into the " +
        "correct stored code before filtering -- never guess at what a " +
        "code means. An empty fieldValues object means that table has no " +
        "coded-field mappings; filter using raw values as they appear.",
      inputSchema: { table: z.string().describe("The table name, as returned by get_spp_schemas.") },
    },
    wrapToolHandler(async ({ table }) => {
      // Checked here rather than left to performGetFieldValues, whose own
      // "unknown table" error lists every table in the config, hidden ones
      // included.
      if (!readableTables.includes(table)) {
        throw new ToolInputError(
          `Unknown table "${table}". Must be one of: ${readableTables.join(", ")}`,
        );
      }
      return performGetFieldValues(connection, table);
    }),
  );

  server.registerTool(
    "execute_spp_query",
    {
      title: "Execute SPP query",
      description:
        "Runs a single read-only SELECT statement against SPP data using " +
        "the table/column names confirmed by get_spp_schemas, and returns " +
        "the resulting rows. This runs on DuckDB, not Postgres/MySQL/SQL " +
        "Server -- notable dialect differences: quote column names with " +
        "spaces/special characters in double-quotes (single quotes are for " +
        "string literals only); add or subtract days from an existing date " +
        "column with `\"date_col\" + (n || ' days')::INTERVAL`, never by " +
        "casting a real Date/Timestamp column to an integer/epoch and " +
        "reconstructing it (a column already typed Date or Timestamp by " +
        "get_spp_schemas is already a real date -- select and compare it " +
        "directly); use SUBSTR() not SUBSTRING(). The users table's " +
        "\"name\" column is stored as \"Last, First\", not \"First Last\" " +
        "-- convert or use a pattern match accordingly. A column with a " +
        "\"references\" property from get_spp_schemas is a foreign key: " +
        "join to the referenced table/column to filter or display by name " +
        "rather than filtering the ID column against a text value. The " +
        "approvalLines table holds one row per EVENT in an approval " +
        "workflow, not one row per approved record -- which record a row " +
        "is about is given by whichever type-specific *_id column is " +
        "populated (e.g. envelope_id, invoice_id, timesheet_id, " +
        "schedule_request_id); exactly one of these is set per row, " +
        "matching that row's record type, and every other record-type id " +
        "column on that row is blank. Its \"action\" column marks the " +
        "event: \"S\" is the original submission, \"P\" is a pending " +
        "approval still owed by the user named in that row's userid, " +
        "\"A\" is a granted approval, \"R\" is a rejection. A \"P\" row is " +
        "never replaced once its approver acts -- it stays, with its " +
        "pending_done field set to \"1\"; the actual outcome is recorded " +
        "separately, as a new \"A\" or \"R\" row. So \"who still needs to " +
        "approve schedule request 1234\" means rows where " +
        "schedule_request_id = 1234, action = 'P', and pending_done is " +
        "not '1' -- each such row's userid is a still-outstanding " +
        "approver. Only SELECT statements are permitted.",
      inputSchema: { sql: z.string().describe("A single read-only SELECT statement.") },
    },
    wrapToolHandler(async ({ sql }) => {
      const result = await executeCallerQuery(connection, sql, timings);
      // Projects/users rows are scoped to the caller's own SPP access,
      // which looks identical to "no rows for other reasons" once you're
      // just looking at a result set -- so if they're not synced yet, say
      // so directly in the result the model is about to reason over,
      // rather than relying on it remembering to call
      // check_spp_access_status on its own.
      if (!hasSyncedAccess) {
        result.note =
          "This account's SPP connection isn't set up or hasn't synced yet " +
          "-- Projects and Users will show zero rows (by design, not a bug " +
          "or a restrictive filter set) until connect_spp_account and " +
          "sync_spp_access are completed. Other tables are unaffected.";
      }
      return result;
    }),
  );

  server.registerTool(
    "list_spp_terminology",
    {
      title: "List SPP terminology",
      description:
        "Lists the instance-wide term definitions configured for this SPP " +
        "instance. Use these definitions whenever a question uses one of " +
        "these terms, even if a different definition would otherwise seem " +
        "reasonable -- call this at the start of a conversation alongside " +
        "get_spp_schemas.",
      inputSchema: {},
    },
    wrapToolHandler(async () => listTerminology()),
  );

  server.registerTool(
    "save_spp_terminology",
    {
      title: "Save SPP terminology",
      description:
        "Creates or updates a term definition. This applies instance-wide, " +
        "for everyone asking questions against this SPP instance -- only " +
        "use this when the user is explicitly defining or correcting a " +
        "term, not as a side effect of answering a question.",
      inputSchema: {
        term: z.string().describe("The term being defined, e.g. \"utilization rate\"."),
        definition: z.string().describe("The definition to store."),
      },
    },
    wrapToolHandler(async ({ term, definition }) => saveTerminology(term, definition)),
  );

  server.registerTool(
    "delete_spp_terminology",
    {
      title: "Delete SPP terminology",
      description:
        "Deletes a term definition. This applies instance-wide -- only use " +
        "this when the user explicitly asks to remove a defined term.",
      inputSchema: { term: z.string().describe("The exact term to delete.") },
    },
    wrapToolHandler(async ({ term }) => deleteTerminology(term)),
  );

  registerWriteTools(server, connection, email, readableTables, wrapToolHandler);
}

module.exports = {
  registerTools,
  setupConnection,
  // Consumed by mcp-handler.js's fast path for sync_spp_access/
  // check_spp_access_status -- see the comment on doCheckSppAccessStatus
  // above for why these are plain functions rather than only living inside
  // registerTools's closures.
  doCheckSppAccessStatus,
  doSyncSppAccess,
  textResult,
  errorResult,
  ToolInputError,
};
