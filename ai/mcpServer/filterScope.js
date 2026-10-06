// Enforces filter-set access at the query layer: replaces every scoped
// table -- "projects"/"users"/"customers" (live, per-user REST access),
// the static reference tables like "projectStages" (hand-curated config),
// and every OTHER table that transitively references one of those via a
// foreign key (a time entry whose project's stage is hidden, a booking on
// a project the caller can't see, ...) -- with views scoped to the current
// caller, so the agent's arbitrary SQL (execute_spp_query) is automatically
// scoped no matter how it's written -- the agent never sees a row it
// shouldn't, directly OR by way of something it references. Downstream
// only: hiding a project hides things that reference the project, never
// the (upstream) customer it belongs to. See reportEngine.js's
// getScopingPlan for how the downstream table set and build order are
// computed from RELATIONSHIPS.
//
// Why the raw materialized tables get renamed to "*_raw" rather than
// building the view directly as "CREATE OR REPLACE VIEW projects AS SELECT
// * FROM projects WHERE ...": this Lambda's DuckDB connection is cached and
// reused across warm-container invocations, potentially for different
// people. A self-referential CREATE OR REPLACE (view named "projects"
// selecting FROM "projects") would bind to whatever currently answers to
// that name -- on the second caller in the same container, that's the
// FIRST caller's already-filtered view, not the raw table, silently
// intersecting two different people's access instead of scoping each
// person's request independently. Renaming the raw table once (idempotent,
// self-healing after reportEngine.js re-materializes it) gives the view a stable,
// unshadowed source to always select from.
//
// Role-based table visibility (stepwise_config.json's rolePermissions
// "read" flag) is layered on top of all of the above: EVERY table -- not
// just the scoped ones -- gets its raw table renamed to "<name>_raw", and
// the public "<name>" view only exists for this request if the caller's
// role has an explicit read:1 for that table. Anything else (no role, role
// not in rolePermissions, table not listed for the role, read != 1) hides
// the table entirely -- fail closed, per the user's requirement that every
// (role, table) pair be deliberately curated. Row scoping for a scoped
// table is built under an internal "<name>_scoped" view that cascade
// conditions reference, so a downstream table the caller CAN read (e.g.
// tasks) is still restricted to permitted projects even when the caller's
// role can't read the projects table itself -- each table's visibility is
// decided independently.

const { getCachedPermittedIds } = require("./filterCache.js");
const {
  resolveFilterSetPermittedValues,
  getScopingPlan,
  getAllViewNames,
  resolveRolePermission,
  performExecuteQuery,
  ToolInputError,
} = require("./reportEngine.js");

const SCOPED_RECORD_TYPES = ["projects", "users", "customers"];

// Small SPP reference tables the REST API doesn't expose with filter-set
// enforcement (unlike SCOPED_RECORD_TYPES above), so they're scoped from a
// hand-curated static config instead of a live per-user REST fetch -- see
// reportEngine.js's resolveFilterSetPermittedValues/stepwise_config.json's
// filterSets section. Extend this once a table is both synced (present in
// REPORT_VIEWS) AND curated in filterSets -- payroll type is known to be
// coming but isn't curated yet.
const STATIC_SCOPED_RECORD_TYPES = [
  "bookingTypes",
  "projectStages",
  "categories",
  "items",
  "chargeStages",
  "timeTypes",
];

// Every table that needs enforcement, in the order it must be built: the
// roots above, PLUS every table reportEngine.js's getScopingPlan finds
// transitively downstream of one of them (e.g. a time entry whose project's
// stage is hidden, per RELATIONSHIPS) -- see getScopingPlan's own comment
// for the full reasoning. Confirmed with the user this is downstream-only:
// hiding a project must not hide its (upstream) customer, only things that
// reference the project. Recomputed fresh per request (cheap -- confirmed
// via direct timing against the real relationships graph, single-digit
// milliseconds even for the deepest/largest tables) rather than cached, so
// it never needs separate invalidation when stepwise_config.json changes.
function computeScopingPlan() {
  return getScopingPlan([...SCOPED_RECORD_TYPES, ...STATIC_SCOPED_RECORD_TYPES]);
}

async function ensureRawTablesRenamed(connection, allScoped) {
  const reader = await connection.runAndReadAll(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('${allScoped.join("', '")}') AND table_type = 'BASE TABLE'
  `);
  const rows = await reader.getRowObjects();
  for (const row of rows) {
    await connection.run(`ALTER TABLE "${row.table_name}" RENAME TO "${row.table_name}_raw"`);
  }
}

function idsListSql(ids) {
  const safeIds = (ids ?? []).filter((id) => Number.isInteger(id) && id > 0);
  if (safeIds.length === 0) {
    return null;
  }
  return `SELECT UNNEST([${safeIds.join(", ")}]) AS id`;
}

// filter_sets.json permitted-id keys are hand-typed strings, not
// necessarily positive integers (SPP reference-table ids are usually small
// positive ints, but nothing guarantees that) -- quoted-string comparison
// via CAST(id AS VARCHAR) handles that generally, same reasoning as
// mergeIntoS3Csv's VARCHAR-everywhere approach elsewhere in this project.
function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Builds the WHERE clause for one static-scoped table from what
// resolveFilterSetPermittedValues returned for it: "all" -> unrestricted,
// a Set -> restricted to those ids, anything else (null -- no filter set,
// unknown filter set, or table not yet curated) -> fail closed.
function staticWhereClause(permitted) {
  if (permitted === "all") {
    return "TRUE";
  }
  if (permitted instanceof Set) {
    if (permitted.size === 0) {
      return "FALSE";
    }
    return `CAST(id AS VARCHAR) IN (${[...permitted].map(sqlQuote).join(", ")})`;
  }
  return "FALSE";
}

// Same lookup as getPrimaryFilterSetId below, for the caller's role_id
// instead of their primary_filter_set -- used by applyFilterScope (table
// read visibility) and sppWritePermissions.js (write actions), both via
// reportEngine.resolveRolePermission. Same fail-closed-to-null reasoning:
// an unresolved role is exactly the case resolveRolePermission already
// treats as "deny".
async function getUserRoleId(connection, email) {
  try {
    const reader = await connection.runAndReadAll(`
      SELECT CAST(role_id AS VARCHAR) AS role_id
      FROM users_raw
      WHERE lower(CAST(email AS VARCHAR)) = lower(${sqlQuote(email)})
      LIMIT 1
    `);
    const rows = await reader.getRowObjects();
    return rows.length ? rows[0].role_id : null;
  } catch (error) {
    console.log(`Could not resolve role_id for ${email}: ${error.message}`);
    return null;
  }
}

// Looks up the caller's own primary_filter_set from the just-renamed
// users_raw table (not the "users" view -- scoping it comes later in
// applyFilterScope, and self-referencing it would hit the exact same
// warm-container staleness problem the module comment at the top of this
// file describes). Case-insensitive match on email, matching filterCache.js's
// own normalization. Returns null -- not found, no users_raw yet (e.g.
// nothing materialized this container), or any query error -- rather than
// throwing; an unresolved filter set is exactly the fail-closed case
// resolveFilterSetPermittedValues already handles, and a query error here
// must not take down every OTHER tool in the request over one lookup.
async function getPrimaryFilterSetId(connection, email) {
  try {
    const reader = await connection.runAndReadAll(`
      SELECT CAST(primary_filter_set AS VARCHAR) AS pfs
      FROM users_raw
      WHERE lower(CAST(email AS VARCHAR)) = lower(${sqlQuote(email)})
      LIMIT 1
    `);
    const rows = await reader.getRowObjects();
    return rows.length ? rows[0].pfs : null;
  } catch (error) {
    console.log(`Could not resolve primary_filter_set for ${email}: ${error.message}`);
    return null;
  }
}

// A table's own restriction, independent of anything it references: the
// REST-cache-based clause for projects/users/customers, the static-config
// clause for the hand-curated reference tables, or "TRUE" (no restriction
// of its own) for a table that's only here because something ELSE cascades
// into it.
function baseWhereClause(table, cached, filterSetId) {
  if (SCOPED_RECORD_TYPES.includes(table)) {
    const idsSql = idsListSql(cached?.[table]);
    const permittedClause = idsSql ? `id IN (${idsSql})` : "FALSE";
    // Generic/service SPP user accounts (templates like "NewHire1-June",
    // not real people) are unconditionally excluded from SPP's own
    // filter-set-scoped REST API response, regardless of whose filter set
    // is applied -- confirmed empirically (0 of 36 generic users ever
    // appear, for every account checked), so fetchPermittedIds can never
    // include them no matter how broad someone's access is. There's no
    // real access-control reason to hide them (they're not anyone's
    // private data), so "users" always shows them alongside whatever's
    // permitted, bypassing the fail-closed permitted-IDs check just for
    // this flag.
    return table === "users"
      ? `(${permittedClause} OR CAST(generic AS VARCHAR) = '1')`
      : permittedClause;
  }
  if (STATIC_SCOPED_RECORD_TYPES.includes(table)) {
    return staticWhereClause(resolveFilterSetPermittedValues(filterSetId, table));
  }
  return "TRUE";
}

// Rebuilds every scoped view for the current request: the "projects"/
// "users"/"customers" views (live, REST-cache-based), the static
// reference-table views (booking type, project stage, category, item,
// charge stage, time type -- hand-curated-config-based), AND every table
// reportEngine.js's getScopingPlan finds transitively downstream of one of
// those (e.g. a time entry whose project's stage is hidden) -- built in
// dependency order so each table's cascade conditions can reference its
// prerequisites' ALREADY-scoped views. Not connected yet (or no cache
// entry) -> the REST-scoped views resolve to zero rows. No resolvable
// filter set, or that table not yet curated -> the static-scoped views (and
// anything cascading from them) resolve to zero rows. Fail closed
// everywhere, never fail open.
//
// Returns { hasSyncedAccess, readableTables }. readableTables is every
// table whose public view was actually created for this caller (role
// permits read AND the view built successfully) -- callers use it to hide
// everything else from get_spp_schemas/get_spp_field_values/the write
// tools' table list, so a hidden table's name never reaches the model.
//
// hasSyncedAccess: whether a REST filter cache entry exists at
// all for this email. This matters because an empty result set looks
// identical to the agent whether the person isn't connected/synced yet or
// is connected with genuinely zero permitted rows -- there is no way to
// tell those apart from query results alone. Callers use this to make that
// distinction explicit rather than leaving the agent to guess (which it
// will get wrong). Reflects REST-cache status only, not static-table or
// cascaded scoping -- someone can be fully connected while their
// primary_filter_set still isn't curated, which correctly fails closed on
// just the affected tables without affecting this flag.
async function applyFilterScope(connection, email) {
  const plan = computeScopingPlan();
  const allTables = getAllViewNames();
  await ensureRawTablesRenamed(connection, allTables);

  const cached = email ? await getCachedPermittedIds(email) : null;
  const filterSetId = email
    ? await getPrimaryFilterSetId(connection, email)
    : null;
  const roleId = email ? await getUserRoleId(connection, email) : null;

  for (const { table, cascadeConditions } of plan) {
    // Isolated per table on purpose -- applyFilterScope runs unconditionally
    // on every request with no surrounding try/catch in mcp-handler.js, so
    // one missing/not-yet-materialized table (e.g. a newly-added table
    // before it's synced) throwing here would otherwise break every tool
    // call for every table, not just this one. Fail this table closed and
    // move on -- it's built in dependency order, so a table that failed
    // here simply won't exist for anything further downstream to reference,
    // which itself then fails closed the same way (no silent pass-through).
    try {
      const base = baseWhereClause(table, cached, filterSetId);
      // CAST both sides to VARCHAR -- an FK column and the "id" column it
      // references aren't guaranteed to share the same DuckDB-inferred
      // type. Confirmed happening for real: several *_id columns come back
      // VARCHAR (DuckDB's auto-detection falls back to it the moment a
      // column has even one non-numeric value, e.g. an empty-string
      // sentinel among mostly-numeric ids -- the same class of thing
      // documented at mergeIntoS3Csv/sample_size=-1 elsewhere in this
      // project), while the referenced table's own "id" is a clean BIGINT,
      // and DuckDB refuses to compare them without an explicit cast.
      //
      // "0" is treated as a second "not set" sentinel alongside real NULL --
      // confirmed happening in production (2026-09-27): SPP represents an
      // unset FK on some records as a literal 0 rather than NULL (e.g. a
      // charge that hasn't been invoiced yet has invoice_id=0, not NULL --
      // confirmed against real data, 265 of 6515 charges on one account).
      // Without this, those charges vanished entirely: the cascade condition
      // required invoice_id to either be NULL or match a real invoice's id,
      // and no invoice has id 0, so "not yet invoiced" was indistinguishable
      // from "invoiced by a since-deleted/invisible invoice" and failed
      // closed. Every table's real ids observed so far start at 1, never 0,
      // so this is a safe platform-wide convention to special-case, not
      // something that risks hiding a legitimately-zero-id row.
      const cascadeClauses = cascadeConditions.map(
        ({ column, referencesTable }) =>
          `(CAST("${column}" AS VARCHAR) IS NULL OR CAST("${column}" AS VARCHAR) = '0' OR CAST("${column}" AS VARCHAR) IN (SELECT CAST(id AS VARCHAR) FROM "${referencesTable}_scoped"))`,
      );
      const whereClause = [base, ...cascadeClauses].join(" AND ");
      await connection.run(
        `CREATE OR REPLACE VIEW "${table}_scoped" AS SELECT * FROM "${table}_raw" WHERE ${whereClause}`,
      );
    } catch (error) {
      console.log(`Could not scope "${table}" -- failing it closed (empty), so anything that references it downstream fails closed too instead of hitting a "table does not exist" error: ${error.message}`);
      // Best-effort fallback: an empty view under the expected name, so a
      // broken table degrades to "shows nothing" for itself AND for
      // whatever's built after it in the plan, rather than the primary
      // failure above cascading into a SECOND, more confusing failure
      // class downstream (confirmed happening: one bad relationship broke
      // materialization for it, which then broke every table built after
      // it in the plan with "Table with name X does not exist", instead of
      // each one failing closed independently and visibly).
      try {
        await connection.run(`CREATE OR REPLACE VIEW "${table}_scoped" AS SELECT * FROM "${table}_raw" WHERE FALSE`);
      } catch (fallbackError) {
        console.log(`Could not even build a fail-closed empty view for "${table}": ${fallbackError.message}`);
      }
    }
  }

  // Public views: one per table the caller's role can read, selecting from
  // the row-scoped view if the table has one, or straight from the raw
  // table if it has no row scoping of its own. Every other table's public
  // name is dropped -- this connection is reused across callers in a warm
  // container, so the previous caller's view must not survive.
  const scopedTables = new Set(plan.map((step) => step.table));
  const readableTables = [];
  for (const table of allTables) {
    const source = scopedTables.has(table) ? `${table}_scoped` : `${table}_raw`;
    try {
      if (resolveRolePermission(roleId, table, "read")) {
        await connection.run(`CREATE OR REPLACE VIEW "${table}" AS SELECT * FROM "${source}"`);
        readableTables.push(table);
      } else {
        await connection.run(`DROP VIEW IF EXISTS "${table}"`);
      }
    } catch (error) {
      console.log(`Could not build public view for "${table}" -- hiding it: ${error.message}`);
      try {
        await connection.run(`DROP VIEW IF EXISTS "${table}"`);
      } catch {}
    }
  }
  console.log(
    `Role-based visibility for ${email} (role ${roleId ?? "unresolved"}): ${readableTables.length} of ${allTables.length} table(s) readable`,
  );

  return { hasSyncedAccess: cached !== null, readableTables };
}

// The internal object holding a table's row-scoped rows for the current
// caller, regardless of whether their role can read the table itself --
// "<name>_scoped" if the table has row scoping, "<name>_raw" if it doesn't.
// For sppWritePermissions.js's record-visibility checks, which are about
// row access, not table visibility (that's checked separately, via role).
function rowScopedSource(table) {
  return computeScopingPlan().some((step) => step.table === table)
    ? `${table}_scoped`
    : `${table}_raw`;
}

// Every table's real data lives under "<name>_raw" (and row-scoped data
// under "<name>_scoped"), with only "<name>" exposed -- and only for tables
// the caller's role can read. Those internal names live in the same DuckDB
// connection the model's SQL runs against, so without this a query could
// name them directly and bypass both role visibility and row scoping.
// DuckDB also volunteers them unprompted: a query against a hidden table
// fails with "did you mean <name>_raw?", which performExecuteQuery's own
// error handling tells the model to act on. So: reject any SQL that names
// one, and scrub them from any error text passed back. Every model-supplied
// SQL statement (execute_spp_query, propose_spp_batch_write's sql) goes
// through this, never performExecuteQuery directly.
function internalNamePattern() {
  const names = getAllViewNames().flatMap((name) => [`${name}_raw`, `${name}_scoped`]);
  if (names.length === 0) return null;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
}

async function executeScopedQuery(connection, sql, timings) {
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

module.exports = {
  applyFilterScope,
  rowScopedSource,
  executeScopedQuery,
  SCOPED_RECORD_TYPES,
  STATIC_SCOPED_RECORD_TYPES,
  // Consumed by ai/mcpServer/sppWritePermissions.js for role-based write
  // gating -- exported directly (unlike getPrimaryFilterSetId, which is
  // only ever needed internally by applyFilterScope itself) since the write
  // path needs it independently, outside the normal scoping pass.
  getUserRoleId,
};
