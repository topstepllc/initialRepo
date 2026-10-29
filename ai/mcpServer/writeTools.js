// Registers the two AI-initiated-write MCP tools: propose_spp_write (all
// validation, no SPP call yet) and execute_spp_write (performs the write a
// prior proposal already validated). The split IS the safety mechanism --
// see sppWritePermissions.js/sppWriteClient.js/sppWriteStore.js for the
// pieces this wires together, and the write-feature design discussion for
// why confirmation is structural rather than left to the model's judgment.

const { z } = require("zod");
const reportEngine = require("./reportEngine.js");
const { ToolInputError } = reportEngine;
const sppUserAuth = require("./sppUserAuth.js");
const sppWritePermissions = require("./sppWritePermissions.js");
const sppWriteClient = require("./sppWriteClient.js");
const sppWriteStore = require("./sppWriteStore.js");
const masterConfig = require("./masterConfig.js");
const filterScope = require("./filterScope.js");

// Covers every table this company's stepwise_config.json declares (via
// reportEngine.getAllViewNames(), read fresh per request in
// registerWriteTools below) -- not a hardcoded list. Role permission +
// row-visibility + the small global restriction list in sppWriteClient.js
// are what actually gate any given write; this is just "does this table
// name mean anything at all."
//
// Required-create-field validation is deliberately NOT generalized beyond
// timeEntries -- "light touch" was a deliberate choice (see the write-
// feature design discussion): SPP's own validation is the real authority
// for every other table, rather than us guessing/maintaining a required-
// field list for 30+ tables. Extend this only for a table where skipping
// it has caused real, confusing SPP-side rejections worth pre-empting.
const REQUIRED_CREATE_FIELDS = {
  timeEntries: ["project_id", "project_task_id", "date", "decimal_hours", "time_type_id"],
};

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// propose_spp_write/execute_spp_write previously logged nothing beyond the
// bare tool name (from mcp-handler.js's generic "MCP method: tools/call"
// line) -- every other tool logs its actual outcome (see reportEngine.js's
// "Query executed: ..." line for execute_spp_query), so this was a real gap:
// tracing what happened to a real write required falling back to scanning
// the sppWriteAudit DynamoDB table directly instead of just reading
// CloudWatch. One line per outcome, matching that same style.
function logWriteOutcome(tool, status, { email, table, action, recordId, detail }) {
  const recordPart = recordId !== undefined && recordId !== null ? ` recordId=${recordId}` : "";
  const detailPart = detail ? ` -- ${detail}` : "";
  console.log(`${tool}: ${status} -- table=${table} action=${action}${recordPart} email=${email}${detailPart}`);
}

async function resolveCallerUserId(connection, email) {
  try {
    const reader = await connection.runAndReadAll(`
      SELECT CAST(id AS VARCHAR) AS id FROM users_raw
      WHERE lower(CAST(email AS VARCHAR)) = lower(${sqlQuote(email)})
      LIMIT 1
    `);
    const rows = await reader.getRowObjects();
    return rows.length ? rows[0].id : null;
  } catch (error) {
    console.log(`Could not resolve caller's own user id for ${email}: ${error.message}`);
    return null;
  }
}

async function tryResolveName(connection, table, id) {
  if (id === undefined || id === null) return null;
  try {
    const reader = await connection.runAndReadAll(
      `SELECT name FROM "${table}" WHERE CAST(id AS VARCHAR) = ${sqlQuote(String(id))} LIMIT 1`,
    );
    const rows = await reader.getRowObjects();
    return rows.length ? rows[0].name : null;
  } catch {
    return null; // cosmetic only -- never blocks the proposal over a failed name lookup
  }
}

// Best-effort human-readable description of the proposed change, shown to
// the user before they confirm. Resolves a couple of the most useful names
// (project, in particular) where cheap; falls back to raw ids otherwise.
async function describeChange(connection, table, action, recordId, fields) {
  if (table !== "timeEntries") {
    return `${action} on "${table}"${recordId ? ` (record ${recordId})` : ""}.`;
  }

  const verb = action === "create" ? "Create a new" : action === "update" ? `Update` : `Delete`;
  const subject = action === "create" ? "time entry" : `time entry #${recordId}`;
  let text = `${verb} ${subject}`;

  if (action !== "delete" && fields && Object.keys(fields).length) {
    const projectName = await tryResolveName(connection, "projects", fields.project_id);
    const parts = [];
    if (fields.project_id !== undefined) {
      parts.push(projectName ? `project "${projectName}" (id ${fields.project_id})` : `project id ${fields.project_id}`);
    }
    if (fields.project_task_id !== undefined) parts.push(`task id ${fields.project_task_id}`);
    if (fields.date !== undefined) parts.push(`date ${fields.date}`);
    if (fields.decimal_hours !== undefined) parts.push(`${fields.decimal_hours} hours`);
    if (fields.time_type_id !== undefined) parts.push(`time type id ${fields.time_type_id}`);
    if (parts.length) text += ` -- ${parts.join(", ")}`;
  }

  return `${text}.`;
}

async function doProposeSppWrite(connection, email, writableTables, { table, action, recordId, fields }) {
  if (!email) throw new ToolInputError("Could not determine the caller's identity.");
  if (!writableTables.includes(table)) {
    throw new ToolInputError(`"${table}" is not a known table for this SPP instance.`);
  }

  if (action === "create") {
    if (recordId !== undefined) {
      throw new ToolInputError("recordId must not be provided for a create action.");
    }
    if (!fields) {
      throw new ToolInputError("fields is required for a create action.");
    }
  } else {
    if (recordId === undefined) {
      throw new ToolInputError(`recordId is required for a(n) ${action} action.`);
    }
    if (action === "update" && !fields) {
      throw new ToolInputError("fields is required for an update action.");
    }
  }

  const workingFields = { ...(fields ?? {}) };

  // Ownership forcing is specific to timeEntries -- a time entry inherently
  // belongs to a specific person, so it's always the caller's own SPP
  // identity, never a model-supplied user_id (silently dropped, not
  // rejected -- a model might reasonably include it when told to log the
  // CALLER's own time). Stripped on update too, not just create:
  // reassigning an existing entry's owner via a stray field was never an
  // approved capability. This does NOT generalize to other tables -- many
  // (booking's owner_id, projectTaskAssignments' user_id, ...) have a
  // user_id-shaped field that legitimately means something other than "the
  // caller," e.g. assigning someone ELSE to a task. Role permission + the
  // create-time visibility check are what gate those, same as any other
  // field.
  if (table === "timeEntries" && (action === "create" || action === "update")) {
    delete workingFields.user_id;
  }
  if (table === "timeEntries" && action === "create") {
    const callerUserId = await resolveCallerUserId(connection, email);
    if (!callerUserId) {
      throw new ToolInputError(
        "Could not resolve your own SPP user record -- make sure your SPP account is connected and synced.",
      );
    }
    workingFields.user_id = callerUserId;
  }
  if (action === "create") {
    const required = REQUIRED_CREATE_FIELDS[table] ?? [];
    const missing = required.filter(
      (field) => workingFields[field] === undefined || workingFields[field] === null || workingFields[field] === "",
    );
    if (missing.length) {
      throw new ToolInputError(
        `Missing required field(s) for creating a ${table} record: ${missing.join(", ")}.`,
      );
    }
  }

  const permission = await sppWritePermissions.checkAllLayers({
    connection,
    email,
    table,
    action,
    recordId,
    fields: workingFields,
  });

  if (!permission.allowed) {
    await sppWriteStore.createTerminalRecord({
      email,
      table,
      action,
      recordId,
      fields: workingFields,
      reason: permission.reason,
      roleId: permission.roleId,
    });
    logWriteOutcome("propose_spp_write", "rejected", { email, table, action, recordId, detail: permission.reason });
    return { status: "rejected", proposalToken: null, description: null, reason: permission.reason, expiresAt: null };
  }

  const description = await describeChange(connection, table, action, recordId, workingFields);
  const proposalId = await sppWriteStore.createProposal({
    email,
    table,
    action,
    recordId,
    fields: workingFields,
    description,
    roleId: permission.roleId,
  });
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + sppWriteStore.PROPOSAL_TTL_SECONDS) * 1000,
  ).toISOString();

  logWriteOutcome("propose_spp_write", "proposed", { email, table, action, recordId, detail: `proposalToken=${proposalId}` });
  return { status: "proposed", proposalToken: proposalId, description, reason: null, expiresAt };
}

async function doExecuteSppWrite(connection, email, { proposalToken }) {
  if (!email) throw new ToolInputError("Could not determine the caller's identity.");

  const proposal = await sppWriteStore.getProposal(proposalToken);
  if (!proposal) {
    console.log(`execute_spp_write: expired -- proposalToken=${proposalToken} email=${email} -- not found`);
    return {
      status: "expired",
      recordId: null,
      sppResponse: null,
      message: "This proposal was not found or has expired -- call propose_spp_write again.",
    };
  }

  // Idempotency guard: a non-"proposed" status means this token was already
  // resolved one way or another -- return that outcome directly rather than
  // re-running (and potentially re-executing) anything.
  if (proposal.status !== "proposed") {
    logWriteOutcome("execute_spp_write", `${proposal.status} (replay)`, {
      email,
      table: proposal.table,
      action: proposal.action,
      recordId: proposal.recordId,
      detail: `proposalToken=${proposalToken}`,
    });
    return {
      status: proposal.status,
      recordId: proposal.recordId ?? null,
      sppResponse: proposal.sppResponse ?? null,
      message:
        proposal.status === "executed"
          ? "This write was already executed."
          : proposal.rejectionReason || "This proposal was already resolved.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (proposal.ttl && now > proposal.ttl) {
    // Safety net ahead of DynamoDB's own (not-instant) TTL sweep.
    logWriteOutcome("execute_spp_write", "expired", {
      email,
      table: proposal.table,
      action: proposal.action,
      recordId: proposal.recordId,
      detail: `proposalToken=${proposalToken}`,
    });
    return {
      status: "expired",
      recordId: null,
      sppResponse: null,
      message: "This proposal has expired -- call propose_spp_write again.",
    };
  }

  const { table, action, recordId, fields } = proposal;

  // Re-run all three permission layers fresh -- defense in depth against
  // anything changing between propose and execute (a role change, a record
  // becoming invisible), not just trusting the propose-time decision.
  const permission = await sppWritePermissions.checkAllLayers({ connection, email, table, action, recordId, fields });
  if (!permission.allowed) {
    await sppWriteStore.markRejectedByUs(proposalToken, permission.reason);
    logWriteOutcome("execute_spp_write", "rejected_by_us", { email, table, action, recordId, detail: permission.reason });
    return { status: "rejected_by_us", recordId: null, sppResponse: null, message: permission.reason };
  }

  const company = process.env.SPP_INSTANCE_NAME;
  const fieldMap = await masterConfig.getMasterFieldMapForView(connection, company, table, reportEngine.getSourceFile);
  if (!fieldMap) {
    const reason = `No SPP field mapping found for "${table}" -- check stepwise_mapping.csv/stepwise_config.json.`;
    await sppWriteStore.markRejectedByUs(proposalToken, reason);
    logWriteOutcome("execute_spp_write", "rejected_by_us", { email, table, action, recordId, detail: reason });
    return { status: "rejected_by_us", recordId: null, sppResponse: null, message: reason };
  }

  const accessToken = await sppUserAuth.getSppAccessTokenForUser(email);
  if (!accessToken) {
    const reason = "Your SPP account isn't connected -- connect your SPP account and call sync_spp_access first.";
    await sppWriteStore.markRejectedByUs(proposalToken, reason);
    logWriteOutcome("execute_spp_write", "rejected_by_us", { email, table, action, recordId, detail: reason });
    return { status: "rejected_by_us", recordId: null, sppResponse: null, message: reason };
  }

  let credentials;
  try {
    credentials = await sppWriteClient.getSppCredentials(process.env.SPP_INSTANCE);
  } catch (error) {
    const reason = `Could not load SPP write credentials: ${error.message}`;
    await sppWriteStore.markRejectedByUs(proposalToken, reason);
    logWriteOutcome("execute_spp_write", "rejected_by_us", { email, table, action, recordId, detail: reason });
    return { status: "rejected_by_us", recordId: null, sppResponse: null, message: reason };
  }

  const dateColumns = reportEngine.getDateColumns(table);

  let xml;
  try {
    if (action === "create") {
      xml = sppWriteClient.buildAddXml({
        apiKey: credentials.apiKey,
        accessToken,
        sppType: fieldMap.sppType,
        fields,
        csvFieldToSppField: fieldMap.csvFieldToSppField,
        dateColumns,
      });
    } else if (action === "update") {
      xml = sppWriteClient.buildModifyXml({
        apiKey: credentials.apiKey,
        accessToken,
        sppType: fieldMap.sppType,
        recordId,
        fields,
        csvFieldToSppField: fieldMap.csvFieldToSppField,
        dateColumns,
      });
    } else {
      xml = sppWriteClient.buildDeleteXml({
        apiKey: credentials.apiKey,
        accessToken,
        sppType: fieldMap.sppType,
        recordId,
      });
    }
  } catch (error) {
    const reason = `Could not build the SPP request: ${error.message}`;
    await sppWriteStore.markRejectedByUs(proposalToken, reason);
    logWriteOutcome("execute_spp_write", "rejected_by_us", { email, table, action, recordId, detail: reason });
    return { status: "rejected_by_us", recordId: null, sppResponse: null, message: reason };
  }

  let resultNode;
  try {
    // sendXmlRequest requires the exact success shape for this action
    // (response.Add[sppType] / .Modify[sppType] / .Delete) and throws
    // SppWriteRejectedError for anything else, success-looking HTTP status
    // or not -- see its own comment for the real SPP behavior that made
    // this necessary (a 200 response carrying SPP's own embedded error).
    resultNode = await sppWriteClient.sendXmlRequest(credentials.xmlUrl, xml, { action, sppType: fieldMap.sppType });
  } catch (error) {
    await sppWriteStore.markRejectedBySpp(proposalToken, error.rawResponse ?? error.message);
    // Distinctly named for log-search visibility -- this is the "two
    // guardians disagreed" case, a signal the rolePermissions data may have
    // drifted from SPP's real role config, not an ordinary failure.
    console.error(
      `APPROVED_BY_US_BUT_SPP_REJECTED table=${table} action=${action} email=${email} roleId=${proposal.roleIdAtProposal}: ${error.message}`,
    );
    return { status: "rejected_by_spp", recordId: null, sppResponse: null, message: error.message };
  }

  const resultRecordId = action === "create" ? (resultNode?.id ?? null) : recordId;

  await sppWriteStore.markExecuted(proposalToken, { recordId: resultRecordId, sppResponse: resultNode });
  await sppWriteClient.triggerResync(fieldMap.sourceFile);

  logWriteOutcome("execute_spp_write", "executed", { email, table, action, recordId: resultRecordId });
  return { status: "executed", recordId: resultRecordId, sppResponse: resultNode, message: `${action} succeeded.` };
}

// --- Batch updates -----------------------------------------------------------
//
// One proposal + one confirmation for setting the SAME field values on many
// records of one table, instead of a propose/execute pair per record. The
// record set is frozen to an exact id list at propose time (a sql source is
// run once, then never again) -- what the user confirms is exactly what gets
// written. Execution runs across as many execute_spp_batch_write calls as it
// takes: each call sends chunks until its time budget runs out (one SPP
// Modify round trip measured ~0.5s, and API Gateway cuts every request off
// at 30s, so a few hundred records can never finish in one call), saving
// each record's outcome as it goes so the next call picks up where the last
// stopped and nothing is ever sent twice.
const MAX_BATCH_RECORDS = 500;
const BATCH_CHUNK_SIZE = 25;
// Checked before each chunk, so a call's worst case is this plus one chunk's
// round trip -- kept well inside API Gateway's 30s.
const BATCH_TIME_BUDGET_MS = 15000;
// Longer than the Lambda's own 60s timeout, so a lease can only lapse once
// the call holding it is certainly dead -- never while it might still be
// sending.
const BATCH_LEASE_SECONDS = 65;

function idListSql(ids) {
  return ids.map((id) => sqlQuote(String(id))).join(", ");
}

function normalizeRecordIds(rawIds) {
  const ids = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ToolInputError(`"${raw}" is not a valid record id -- every id must be a positive integer.`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// Every id the caller can see in this table's row-scoped data (independent
// of table-level read access, which is checked separately via role).
async function visibleIds(connection, table, ids) {
  const visible = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const reader = await connection.runAndReadAll(
      `SELECT CAST(id AS VARCHAR) AS id FROM "${filterScope.rowScopedSource(table)}" WHERE CAST(id AS VARCHAR) IN (${idListSql(slice)})`,
    );
    for (const row of await reader.getRowObjects()) visible.add(Number(row.id));
  }
  return visible;
}

// Best-effort preview from the synced copy: how many records already hold
// the new values (so the user isn't surprised by a no-op), and current vs.
// new values for a few samples. Cosmetic -- never blocks the proposal.
async function previewBatch(connection, table, ids, fields) {
  const source = filterScope.rowScopedSource(table);
  const columns = Object.keys(fields);
  const preview = { alreadyAtNewValues: null, sample: [] };
  try {
    const matches = columns
      .map((col) => `CAST("${col}" AS VARCHAR) IS NOT DISTINCT FROM ${sqlQuote(String(fields[col]))}`)
      .join(" AND ");
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) AS n FROM "${source}" WHERE CAST(id AS VARCHAR) IN (${idListSql(ids)}) AND ${matches}`,
    );
    preview.alreadyAtNewValues = Number((await reader.getRowObjects())[0].n);
  } catch (error) {
    console.log(`Batch preview (unchanged count) skipped for ${table}: ${error.message}`);
  }
  try {
    const select = columns.map((col) => `CAST("${col}" AS VARCHAR) AS "${col}"`).join(", ");
    const reader = await connection.runAndReadAll(
      `SELECT CAST(id AS VARCHAR) AS id, ${select} FROM "${source}" WHERE CAST(id AS VARCHAR) IN (${idListSql(ids.slice(0, 5))})`,
    );
    preview.sample = (await reader.getRowObjects()).map(({ id, ...current }) => ({
      id: Number(id),
      current,
      new: fields,
    }));
  } catch (error) {
    console.log(`Batch preview (sample) skipped for ${table}: ${error.message}`);
  }
  return preview;
}

async function doProposeSppBatchWrite(connection, email, writableTables, { table, fields, recordIds, sql }) {
  if (!email) throw new ToolInputError("Could not determine the caller's identity.");
  if (!writableTables.includes(table)) {
    throw new ToolInputError(`"${table}" is not a known table for this SPP instance.`);
  }
  if (!fields || Object.keys(fields).length === 0) {
    throw new ToolInputError("fields is required -- the field values to set on every record.");
  }
  if ((recordIds === undefined) === (sql === undefined)) {
    throw new ToolInputError("Provide exactly one of recordIds or sql.");
  }

  const workingFields = { ...fields };
  // Same rule as single-record writes: a time entry's owner is never
  // reassigned through a write.
  if (table === "timeEntries") {
    delete workingFields.user_id;
    if (Object.keys(workingFields).length === 0) {
      throw new ToolInputError("user_id cannot be changed on time entries, and no other fields were given.");
    }
  }

  let rawIds = recordIds;
  if (sql !== undefined) {
    const { rows } = await filterScope.executeScopedQuery(connection, sql, {});
    if (rows.length > 0 && !Object.prototype.hasOwnProperty.call(rows[0], "id")) {
      throw new ToolInputError('The sql must return a column named "id" holding the record ids to update.');
    }
    rawIds = rows.map((row) => row.id);
  }
  const ids = normalizeRecordIds(rawIds);
  if (ids.length === 0) {
    throw new ToolInputError("No records matched -- nothing to update.");
  }
  if (ids.length > MAX_BATCH_RECORDS) {
    throw new ToolInputError(
      `${ids.length} records is over the ${MAX_BATCH_RECORDS}-record limit for one batch -- split it into smaller batches.`,
    );
  }

  const reject = async (reason) => {
    await sppWriteStore.createTerminalRecord({
      email,
      table,
      action: "update",
      fields: workingFields,
      reason: `Batch of ${ids.length} record(s): ${reason}`,
      roleId,
    });
    logWriteOutcome("propose_spp_batch_write", "rejected", { email, table, action: "update", detail: `${ids.length} records -- ${reason}` });
    return { status: "rejected", proposalToken: null, description: null, reason, expiresAt: null };
  };

  const roleId = await filterScope.getUserRoleId(connection, email);
  if (!sppWriteClient.isGloballyPermitted(table, "update")) {
    return reject(`"update" on "${table}" is not available through this integration.`);
  }
  if (!reportEngine.resolveRolePermission(roleId, table, "read")) {
    return reject(`Your SPP role does not permit access to "${table}".`);
  }
  if (!reportEngine.resolveRolePermission(roleId, table, "update")) {
    return reject(`Your SPP role does not permit "update" on "${table}".`);
  }

  // Unknown field names are caught here, before anyone confirms anything --
  // the single-record path only finds out at execute time.
  const fieldMap = await masterConfig.getMasterFieldMapForView(
    connection,
    process.env.SPP_INSTANCE_NAME,
    table,
    reportEngine.getSourceFile,
  );
  if (!fieldMap) {
    throw new ToolInputError(`No SPP field mapping found for "${table}" -- check stepwise_mapping.csv/stepwise_config.json.`);
  }
  const unknownFields = Object.keys(workingFields).filter((field) => !fieldMap.csvFieldToSppField[field]);
  if (unknownFields.length) {
    throw new ToolInputError(
      `Not a writable field on ${table}: ${unknownFields.join(", ")}. Use the column names get_spp_schemas returns.`,
    );
  }

  const visible = await visibleIds(connection, table, ids);
  const notVisible = ids.filter((id) => !visible.has(id));
  if (notVisible.length) {
    return reject(
      `${notVisible.length} of ${ids.length} record(s) are not visible to you (or do not exist), e.g. ${notVisible.slice(0, 10).join(", ")} -- remove them and propose again.`,
    );
  }

  const preview = await previewBatch(connection, table, ids, workingFields);
  const assignments = Object.entries(workingFields)
    .map(([field, value]) => `${field} = "${value}"`)
    .join(", ");
  const description = `Update ${ids.length} ${table} record(s): set ${assignments}.`;

  const proposalId = await sppWriteStore.createBatchProposal({
    email,
    table,
    fields: workingFields,
    recordIds: ids,
    description,
    roleId,
  });
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + sppWriteStore.PROPOSAL_TTL_SECONDS) * 1000,
  ).toISOString();

  logWriteOutcome("propose_spp_batch_write", "proposed", {
    email,
    table,
    action: "update",
    detail: `${ids.length} records, proposalToken=${proposalId}`,
  });
  return {
    status: "proposed",
    proposalToken: proposalId,
    description,
    recordCount: ids.length,
    alreadyAtNewValues: preview.alreadyAtNewValues,
    sample: preview.sample,
    reason: null,
    expiresAt,
  };
}

function batchSummary(status, batch, succeeded, failed, remainingCount, message) {
  return {
    status,
    total: batch.recordIds.length,
    succeeded: succeeded.length,
    failed: failed.length,
    remaining: remainingCount,
    failures: failed.slice(0, 10),
    message,
  };
}

async function doExecuteSppBatchWrite(connection, email, { proposalToken }) {
  if (!email) throw new ToolInputError("Could not determine the caller's identity.");

  const batch = await sppWriteStore.acquireBatchLease(proposalToken, email, BATCH_LEASE_SECONDS);
  if (!batch) {
    const row = await sppWriteStore.getProposal(proposalToken);
    const isMine = row && row.kind === "batch" && row.email === email.toLowerCase().trim();
    if (!isMine) {
      return { status: "not_found", message: "No batch proposal with this token -- call propose_spp_batch_write again." };
    }
    if (row.status === "executed" || row.status === "stopped") {
      const remaining = row.recordIds.length - row.succeeded.length - row.failed.length;
      return batchSummary(row.status, row, row.succeeded, row.failed, remaining, row.stopReason || "This batch already finished.");
    }
    if (row.status === "proposed") {
      return { status: "expired", message: "This proposal has expired -- call propose_spp_batch_write again." };
    }
    return {
      status: "busy",
      message: "Another call is already working on this batch. Wait a few seconds, then call execute_spp_batch_write again with the same proposalToken.",
    };
  }

  const { table, fields } = batch;
  const succeeded = [...batch.succeeded];
  const failed = [...batch.failed];
  const attempted = new Set([...succeeded, ...failed.map((f) => f.recordId)]);
  let remaining = batch.recordIds.filter((id) => !attempted.has(id));
  let resyncSource = null;

  const stop = async (reason) => {
    await sppWriteStore.saveBatchProgress(proposalToken, { succeeded, failed });
    await sppWriteStore.finishBatch(proposalToken, { status: "stopped", stopReason: reason });
    if (succeeded.length && resyncSource) await sppWriteClient.triggerResync(resyncSource);
    logWriteOutcome("execute_spp_batch_write", "stopped", {
      email,
      table,
      action: "update",
      detail: `${succeeded.length} ok, ${failed.length} failed, ${remaining.length} not sent -- ${reason}`,
    });
    return batchSummary("stopped", batch, succeeded, failed, remaining.length, reason);
  };

  // Re-check everything fresh, same as the single-record path -- a role or
  // a record's visibility may have changed since the proposal, or since the
  // previous execute call.
  const roleId = await filterScope.getUserRoleId(connection, email);
  if (
    !sppWriteClient.isGloballyPermitted(table, "update") ||
    !reportEngine.resolveRolePermission(roleId, table, "read") ||
    !reportEngine.resolveRolePermission(roleId, table, "update")
  ) {
    return stop(`Your SPP role no longer permits updating "${table}" -- nothing further was sent.`);
  }

  if (remaining.length) {
    const visible = await visibleIds(connection, table, remaining);
    for (const id of remaining) {
      if (!visible.has(id)) failed.push({ recordId: id, error: "No longer visible to you -- not sent." });
    }
    remaining = remaining.filter((id) => visible.has(id));
  }

  const fieldMap = await masterConfig.getMasterFieldMapForView(
    connection,
    process.env.SPP_INSTANCE_NAME,
    table,
    reportEngine.getSourceFile,
  );
  if (!fieldMap) {
    return stop(`No SPP field mapping found for "${table}" -- check stepwise_mapping.csv/stepwise_config.json.`);
  }
  resyncSource = fieldMap.sourceFile;

  // A missing connection or credentials can be fixed and retried, so these
  // leave the batch resumable rather than stopping it.
  const accessToken = await sppUserAuth.getSppAccessTokenForUser(email);
  if (!accessToken) {
    await sppWriteStore.saveBatchProgress(proposalToken, { succeeded, failed });
    await sppWriteStore.releaseBatchLease(proposalToken);
    return batchSummary(
      "blocked",
      batch,
      succeeded,
      failed,
      remaining.length,
      "Your SPP account isn't connected -- connect it, call sync_spp_access, then call execute_spp_batch_write again with the same proposalToken.",
    );
  }
  let credentials;
  try {
    credentials = await sppWriteClient.getSppCredentials(process.env.SPP_INSTANCE);
  } catch (error) {
    await sppWriteStore.saveBatchProgress(proposalToken, { succeeded, failed });
    await sppWriteStore.releaseBatchLease(proposalToken);
    return batchSummary("blocked", batch, succeeded, failed, remaining.length, `Could not load SPP write credentials: ${error.message}`);
  }

  const dateColumns = reportEngine.getDateColumns(table);
  const deadline = Date.now() + BATCH_TIME_BUDGET_MS;

  while (remaining.length && Date.now() < deadline) {
    const chunk = remaining.slice(0, BATCH_CHUNK_SIZE);

    let xml;
    try {
      xml = sppWriteClient.buildBatchModifyXml({
        apiKey: credentials.apiKey,
        accessToken,
        sppType: fieldMap.sppType,
        recordIds: chunk,
        fields,
        csvFieldToSppField: fieldMap.csvFieldToSppField,
        dateColumns,
      });
    } catch (error) {
      return stop(`Could not build the SPP request: ${error.message}`);
    }

    let outcomes;
    try {
      outcomes = await sppWriteClient.sendBatchModifyRequest(credentials.xmlUrl, xml, {
        sppType: fieldMap.sppType,
        recordIds: chunk,
      });
    } catch (error) {
      console.error(
        `APPROVED_BY_US_BUT_SPP_REJECTED table=${table} action=batch-update email=${email} roleId=${batch.roleIdAtProposal}: ${error.message}`,
      );
      // The response couldn't be matched to records, so this chunk's
      // outcome is unknown -- left out of both lists (it shows as
      // "remaining") rather than guessed at.
      return stop(
        `SPP rejected a request and its response couldn't be matched to records, so records ${chunk[0]}-${chunk[chunk.length - 1]} (${chunk.length}) may or may not have been updated; nothing after them was sent. ${error.message}`.slice(0, 1000),
      );
    }

    for (const outcome of outcomes) {
      if (outcome.ok) succeeded.push(outcome.recordId);
      else failed.push({ recordId: outcome.recordId, error: outcome.error });
    }
    remaining = remaining.slice(chunk.length);
    await sppWriteStore.saveBatchProgress(proposalToken, { succeeded, failed });

    // One bad record shouldn't halt the batch, but a whole chunk rejected
    // points at something systemic (wrong field value for every record,
    // revoked access) -- stop before repeating it for every chunk left.
    if (chunk.length >= 5 && outcomes.every((outcome) => !outcome.ok)) {
      return stop(`SPP rejected all ${chunk.length} records in a chunk -- stopped to avoid repeating the same failure. First error: ${outcomes[0].error}`);
    }
  }

  if (remaining.length) {
    await sppWriteStore.releaseBatchLease(proposalToken);
    logWriteOutcome("execute_spp_batch_write", "in_progress", {
      email,
      table,
      action: "update",
      detail: `${succeeded.length} ok, ${failed.length} failed, ${remaining.length} remaining`,
    });
    return batchSummary(
      "in_progress",
      batch,
      succeeded,
      failed,
      remaining.length,
      "Not finished yet -- call execute_spp_batch_write again now with the same proposalToken to continue. Do not ask the user again; they already confirmed this batch.",
    );
  }

  await sppWriteStore.finishBatch(proposalToken, { status: "executed" });
  await sppWriteClient.triggerResync(resyncSource);
  logWriteOutcome("execute_spp_batch_write", "executed", {
    email,
    table,
    action: "update",
    detail: `${succeeded.length} ok, ${failed.length} failed`,
  });
  return batchSummary(
    "executed",
    batch,
    succeeded,
    failed,
    0,
    failed.length ? `Finished: ${succeeded.length} updated, ${failed.length} failed (see failures).` : `Finished: all ${succeeded.length} records updated.`,
  );
}

function registerWriteTools(server, connection, email, readableTables, wrapToolHandler) {
  // Read fresh per request (this function runs once per MCP request, same
  // as every other tool registration) -- whatever this company's
  // stepwise_config.json currently declares as synced tables IS the writable
  // table list, no separate hardcoded list to keep in sync. Narrowed to the
  // tables this caller's role can read (see filterScope.js) so a hidden
  // table's name never shows up in this tool's input schema; a write still
  // has to pass checkAllLayers' own read + write checks either way.
  const writableTables = reportEngine
    .getAllViewNames()
    .filter((table) => readableTables.includes(table));

  // z.enum needs at least one value -- a caller who can't read anything
  // can't write anything either, so there's nothing to offer.
  if (writableTables.length === 0) {
    return;
  }

  server.registerTool(
    "propose_spp_write",
    {
      title: "Propose an SPP write",
      description:
        "Validates and proposes a create/update/delete against SPP, for ANY synced table -- does NOT " +
        "write anything yet. Returns a human-readable `description` of exactly what would happen and " +
        "a short-lived `proposalToken`. Show the description to the user and get their EXPLICIT " +
        'confirmation before ever calling execute_spp_write with this token. If `status` is "rejected", ' +
        "the write is not permitted at all -- do not attempt execute_spp_write with a null token. Every " +
        "write is still gated by the caller's own SPP role and by whether they can see the record(s) " +
        "involved, regardless of which table this is called for -- a \"rejected\" status commonly means " +
        "one of those, not a bug. To set the SAME field values on more than a few records, use " +
        "propose_spp_batch_write instead of calling this once per record.",
      inputSchema: {
        table: z.enum(writableTables).describe("Which SPP table to write to -- must be one of this instance's synced tables."),
        action: z.enum(["create", "update", "delete"]),
        recordId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The SPP record id being modified or deleted. Required for update/delete, must be omitted for create."),
        fields: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe(
            "Field values keyed by the SAME internal snake_case names get_spp_schemas/execute_spp_query " +
              "already use for this table (e.g. project_id, category_id, name) -- NOT SPP's raw XML field " +
              "names. Required for create/update, omitted for delete. For timeEntries specifically, at " +
              "minimum project_id, project_task_id, date, decimal_hours, and time_type_id must be provided " +
              "on create, and user_id must never be included -- it is always set to the caller's own " +
              "identity automatically for that table. For every other table, SPP itself is the authority " +
              "on required fields and will reject the request with its own message if something is " +
              "missing or invalid -- there is no client-side required-field check beyond timeEntries.",
          ),
      },
    },
    wrapToolHandler(({ table, action, recordId, fields }) =>
      doProposeSppWrite(connection, email, writableTables, { table, action, recordId, fields }),
    ),
  );

  server.registerTool(
    "execute_spp_write",
    {
      title: "Execute a proposed SPP write",
      description:
        "Actually performs a write previously validated by propose_spp_write. Only call this AFTER " +
        "the user has explicitly confirmed the change described in that proposal's `description` in " +
        "this conversation -- never call it proactively or speculatively.",
      inputSchema: {
        proposalToken: z.string().describe("The exact proposalToken returned by a prior propose_spp_write call."),
      },
    },
    wrapToolHandler(({ proposalToken }) => doExecuteSppWrite(connection, email, { proposalToken })),
  );

  server.registerTool(
    "propose_spp_batch_write",
    {
      title: "Propose an SPP batch update",
      description:
        "Validates and proposes setting the SAME field values on many records of one table at once " +
        `(up to ${MAX_BATCH_RECORDS}) -- does NOT write anything yet. Use this instead of propose_spp_write ` +
        "whenever more than a few records need the same change. Identify the records with EITHER recordIds " +
        'OR sql (a SELECT against get_spp_schemas tables returning an "id" column) -- not both; the result ' +
        "is frozen into an exact record list now, so what the user confirms is exactly what gets written. " +
        "Returns a `description`, `recordCount`, `alreadyAtNewValues` (records that already hold the new " +
        "values), a few `sample` records showing current vs. new values, and one `proposalToken`. Show the " +
        "user the description, count and samples and get their EXPLICIT confirmation before calling " +
        'execute_spp_batch_write. If `status` is "rejected", nothing is permitted -- report the reason.',
      inputSchema: {
        table: z.enum(writableTables).describe("Which SPP table to update."),
        fields: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .describe(
            "Field values to set on EVERY record, keyed by the same column names get_spp_schemas returns " +
              "for this table (e.g. status, notes) -- not SPP's raw XML field names.",
          ),
        recordIds: z
          .array(z.number().int().positive())
          .optional()
          .describe("The exact record ids to update. Omit if using sql."),
        sql: z
          .string()
          .optional()
          .describe('A single SELECT returning an "id" column of the records to update. Omit if using recordIds.'),
      },
    },
    wrapToolHandler(({ table, fields, recordIds, sql }) =>
      doProposeSppBatchWrite(connection, email, writableTables, { table, fields, recordIds, sql }),
    ),
  );

  server.registerTool(
    "execute_spp_batch_write",
    {
      title: "Execute a proposed SPP batch update",
      description:
        "Performs a batch update previously validated by propose_spp_batch_write. Only call this AFTER " +
        "the user has explicitly confirmed that proposal in this conversation. A large batch takes several " +
        'calls: while `status` is "in_progress", immediately call this again with the SAME proposalToken ' +
        "(no new confirmation needed) until it returns \"executed\" or \"stopped\". If it returns \"busy\", " +
        "wait a few seconds and call again. Report the final succeeded/failed counts and any failures to the " +
        'user. "stopped" means it halted early for the reason given -- report that reason and the counts; ' +
        "do not retry without asking the user.",
      inputSchema: {
        proposalToken: z.string().describe("The exact proposalToken returned by propose_spp_batch_write."),
      },
    },
    wrapToolHandler(({ proposalToken }) => doExecuteSppBatchWrite(connection, email, { proposalToken })),
  );
}

module.exports = { registerWriteTools };
