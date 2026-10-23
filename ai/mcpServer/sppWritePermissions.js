// Orchestrates the three independent permission layers a write must pass,
// all required, none sufficient alone -- see the write-feature design
// discussion for why each exists separately:
//   (a) row-visibility -- can this person even reference/see the record at
//       all, reusing the SAME row scoping filterScope.js already built this
//       request (via rowScopedSource -- "_raw" only for a table with no row
//       scoping of its own)
//   (b) role-based CRUD -- does their SPP role (users.role_id) permit
//       reading this table AND this action on it, per the hand-curated
//       rolePermissions data
//   (c) global platform capability -- is this action even possible on this
//       table via SPP's API at all, regardless of role (sppWriteClient.js)
//
// This runs FIRST and is a real decision-maker, not a formality ahead of
// SPP's own server-side enforcement -- SPP's enforcement is the second,
// independent "guardian." If this layer approves something SPP then
// rejects, that's a distinct, actionable case (see writeTools.js's
// markRejectedBySpp/driftSuspected handling), not just an ordinary failure.

const reportEngine = require("./reportEngine.js");
const filterScope = require("./filterScope.js");
const sppWriteClient = require("./sppWriteClient.js");

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Row visibility only -- reads the caller's row-scoped data directly rather
// than the public "<table>" view, which doesn't exist at all when the
// caller's role can't read that table. Table-level read access is checked
// separately (checkAllLayers, for the table being written); a referenced
// table only needs its row to be in scope, not the table itself readable.
async function isVisibleInScopedView(connection, table, id) {
  try {
    const reader = await connection.runAndReadAll(
      `SELECT 1 AS found FROM "${filterScope.rowScopedSource(table)}" WHERE CAST(id AS VARCHAR) = ${sqlQuote(String(id))} LIMIT 1`,
    );
    const rows = await reader.getRowObjects();
    return rows.length > 0;
  } catch (error) {
    console.log(`Visibility check failed for ${table}=${id}: ${error.message}`);
    return false; // fail closed, same philosophy as every other "not sure" case in this pipeline
  }
}

// Create-time visibility: there's no target row yet, so this validates what
// the NEW row would REFERENCE instead. Generic across every table -- walks
// this table's own outgoing FK relationships (the same RELATIONSHIPS data
// getScopingPlan already uses for read-side cascade scoping, via
// reportEngine.getRelationshipsForTable) and, for every FK column actually
// present in `fields`, checks that the referenced record is visible in the
// caller's own scoped view. Every one of them must pass.
//
// A table with no outgoing relationships (e.g. customers -- nothing else's
// RELATIONSHIPS entries reference it FROM customers) simply has nothing to
// check here; role permission alone gates its creation, which is the
// correct outcome, not a gap -- there's no existing related record to hide
// behind. Likewise, an FK column the caller didn't set on this create is
// skipped, not treated as a failure -- nothing to validate if it's absent.
async function checkCreateVisibility(connection, table, fields) {
  const relationships = reportEngine.getRelationshipsForTable(table);
  for (const { column, referencesTable } of relationships) {
    const value = fields?.[column];
    if (value === undefined || value === null || value === "") continue;
    const visible = await isVisibleInScopedView(connection, referencesTable, value);
    if (!visible) return false;
  }
  return true;
}

// Returns { allowed, reason, roleId }. `reason` is a short, human-readable
// denial explanation (used both in the tool's response and the audit row);
// `roleId` is returned even on success so the caller can record
// roleIdAtProposal for later drift analysis, without a second lookup.
async function checkAllLayers({ connection, email, table, action, recordId, fields }) {
  if (!sppWriteClient.isGloballyPermitted(table, action)) {
    return {
      allowed: false,
      reason: `"${action}" on "${table}" is not available through this integration.`,
      roleId: null,
    };
  }

  const roleId = await filterScope.getUserRoleId(connection, email);
  // Writing requires reading -- a role that can't see a table can't change
  // it, whatever its create/update/delete flags say.
  if (!reportEngine.resolveRolePermission(roleId, table, "read")) {
    return {
      allowed: false,
      reason: `Your SPP role does not permit access to "${table}".`,
      roleId,
    };
  }
  if (!reportEngine.resolveRolePermission(roleId, table, action)) {
    return {
      allowed: false,
      reason: `Your SPP role does not permit "${action}" on "${table}".`,
      roleId,
    };
  }

  if (action === "create") {
    const visible = await checkCreateVisibility(connection, table, fields);
    if (!visible) {
      return {
        allowed: false,
        reason: "The record(s) this would reference are not visible to you.",
        roleId,
      };
    }
  } else {
    const visible = await isVisibleInScopedView(connection, table, recordId);
    if (!visible) {
      return {
        allowed: false,
        reason: `Record ${recordId} in "${table}" is not visible to you (or does not exist).`,
        roleId,
      };
    }
  }

  return { allowed: true, reason: null, roleId };
}

module.exports = { checkAllLayers };
