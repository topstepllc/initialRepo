// Reads and caches spp-data/{company}/_config/stepwise_mapping.csv inside
// the MCP Lambda -- the same file ai/sppDataSync/sppDataSync.js's
// readMasterConfig already reads (renamed from master.csv -- same file,
// same shape), but that function lives in a separate Lambda/image and
// can't be required here. This mirrors its grouping logic (byTable, keyed
// on localTable) rather than importing it, matching this repo's existing
// precedent of small, deliberately duplicated per-Lambda config readers
// (BUCKET/DATA_PREFIX are duplicated the same way between sppDataSync.js
// and reportEngine.js already).
//
// The write path needs this for two things: SPP's own XML recordType
// string for a table (sppType, e.g. "Task" for timeEntries), and the
// translation between our internal snake_case column names (csvField, the
// same names used everywhere else in this pipeline -- stepwise_config.json's
// relationships/dateColumns, execute_spp_query's results) and SPP's own raw
// XML field names (sppField, e.g. "projectid" for project_id).
//
// Cached per warm container after first read, same pattern as
// sppUserAuth.js's cachedBaseConfig -- this file changes rarely, and unlike
// stepwise_config.json there's no staleness recheck here yet (a real, known
// gap: an edit needs a redeploy/cold-start to take effect, acceptable for
// phase 1 of the write feature).

const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";

let cachedByLocalTable = null;

function masterConfigPath(company) {
  return `s3://${BUCKET}/${DATA_PREFIX}/${company}/_config/stepwise_mapping.csv`;
}

async function loadMasterConfig(connection, company) {
  if (cachedByLocalTable) return cachedByLocalTable;

  const path = masterConfigPath(company);
  const reader = await connection.runAndReadAll(
    `SELECT company, localTable, sppType, sppField, csvField FROM read_csv_auto('${path}', header=true);`,
  );
  const rows = await reader.getRowObjects();

  const byLocalTable = {};
  for (const row of rows) {
    if (!byLocalTable[row.localTable]) {
      byLocalTable[row.localTable] = { sppType: row.sppType, fields: [] };
    }
    byLocalTable[row.localTable].fields.push({
      sppField: row.sppField,
      csvField: row.csvField,
    });
  }

  cachedByLocalTable = byLocalTable;
  return byLocalTable;
}

// Resolves the write-relevant config for a report view (e.g. "timeEntries"),
// via reportEngine's getSourceFile to find the bare SPP-side source name
// (e.g. "task") that stepwise_mapping.csv's localTable column actually uses
// -- viewName itself is never a localTable key in that file. Returns null if
// the view has no source file mapping, or there's no matching localTable
// group (both are config-completeness problems the caller should fail
// closed on, not guess past).
async function getMasterFieldMapForView(connection, company, viewName, getSourceFile) {
  const sourceFile = getSourceFile(viewName);
  if (!sourceFile) return null;

  const byLocalTable = await loadMasterConfig(connection, company);
  const group = byLocalTable[sourceFile];
  if (!group) return null;

  const csvFieldToSppField = {};
  const sppFieldToCsvField = {};
  for (const { sppField, csvField } of group.fields) {
    csvFieldToSppField[csvField] = sppField;
    sppFieldToCsvField[sppField] = csvField;
  }

  return { sppType: group.sppType, sourceFile, csvFieldToSppField, sppFieldToCsvField };
}

module.exports = { getMasterFieldMapForView };
