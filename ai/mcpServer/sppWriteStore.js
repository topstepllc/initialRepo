// All reads/writes against sppWriteAudit -- the single DynamoDB table that
// serves as BOTH the short-lived proposal store (propose_spp_write ->
// execute_spp_write) AND the permanent write-audit log, per the write-
// feature design decision to combine them rather than keep two tables in
// sync. One row per attempt; `status` moves proposed -> executed /
// rejected_by_us / rejected_by_spp. See the TTL design below for how a row
// converts from ephemeral to permanent the moment it stops being "pending."

const { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const crypto = require("crypto");

const dynamo = new DynamoDBClient({});

function tableName() {
  return process.env.WRITE_AUDIT_TABLE;
}

// 20 minutes: comfortably covers a real conversational back-and-forth
// (agent shows the proposal, user asks a clarifying question or two, then
// confirms) without leaving a stale-but-still-valid-looking token around
// long after an abandoned conversation.
const PROPOSAL_TTL_SECONDS = 20 * 60;

// A row this creates is EPHEMERAL (carries a ttl) -- it only becomes a
// permanent audit record once execute_spp_write reaches a terminal status
// and explicitly removes the ttl (see markExecuted/markRejectedByUs/
// markRejectedBySpp below). A proposal nobody ever confirms is genuinely
// not audit-worthy on its own -- nothing happened -- so letting DynamoDB's
// background TTL sweep it is correct, not a data-loss risk.
async function createProposal({ email, table, action, recordId, fields, description, roleId }) {
  const proposalId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const item = {
    proposalId,
    email: email.toLowerCase().trim(),
    table,
    action,
    recordId: recordId ?? undefined,
    fields: fields ?? {},
    description,
    roleIdAtProposal: roleId === null || roleId === undefined ? undefined : String(roleId),
    status: "proposed",
    createdAt: now,
    ttl: now + PROPOSAL_TTL_SECONDS,
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
  return proposalId;
}

// A row this creates is PERMANENT from the moment it's written -- no ttl at
// all. An attempted-but-denied write is itself audit-worthy immediately, not
// just once "confirmed" -- there's no "proposed" state to expire here.
async function createTerminalRecord({ email, table, action, recordId, fields, reason, roleId }) {
  const proposalId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const item = {
    proposalId,
    email: email.toLowerCase().trim(),
    table,
    action,
    recordId: recordId ?? undefined,
    fields: fields ?? {},
    roleIdAtProposal: roleId === null || roleId === undefined ? undefined : String(roleId),
    status: "rejected_by_us",
    rejectionReason: reason,
    createdAt: now,
    executedAt: now,
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
  return proposalId;
}

async function getProposal(proposalId) {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
    }),
  );
  return result.Item ? unmarshall(result.Item) : null;
}

// The three functions below all share one shape: set a terminal status +
// executedAt + whatever result data, and REMOVE ttl in the SAME update --
// the row becomes a permanent audit record at exactly the instant it stops
// being a live proposal, never as a separate step that could be skipped.

async function markExecuted(proposalId, { recordId, sppResponse }) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression:
        "SET #status = :status, executedAt = :executedAt, recordId = :recordId, sppResponse = :sppResponse REMOVE #ttl",
      ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: marshall(
        {
          ":status": "executed",
          ":executedAt": now,
          ":recordId": recordId ?? null,
          ":sppResponse": sppResponse ?? {},
        },
        { removeUndefinedValues: true },
      ),
    }),
  );
}

async function markRejectedByUs(proposalId, reason) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression:
        "SET #status = :status, executedAt = :executedAt, rejectionReason = :reason REMOVE #ttl",
      ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({
        ":status": "rejected_by_us",
        ":executedAt": now,
        ":reason": reason,
      }),
    }),
  );
}

// "We approved this, SPP declined it" -- flagged distinctly (driftSuspected)
// per the two-guardians design: it's a specific, actionable signal that the
// hand-curated rolePermissions data may have drifted from SPP's real role
// config, not just an ordinary write failure.
async function markRejectedBySpp(proposalId, rawSppResponse) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression:
        "SET #status = :status, executedAt = :executedAt, sppResponse = :sppResponse, driftSuspected = :drift REMOVE #ttl",
      ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({
        ":status": "rejected_by_spp",
        ":executedAt": now,
        ":sppResponse": { raw: String(rawSppResponse) },
        ":drift": true,
      }),
    }),
  );
}

// --- Batch proposals (propose_spp_batch_write / execute_spp_batch_write) --
//
// Same table, same proposed -> terminal lifecycle, one row per batch
// (kind: "batch"). The row carries the exact recordIds the user confirmed,
// plus per-record outcomes as execution progresses across however many
// execute calls it takes (each call is bounded well under API Gateway's
// 30-second limit). Status: proposed -> running -> executed | stopped.

async function createBatchProposal({ email, table, fields, recordIds, description, roleId }) {
  const proposalId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const item = {
    proposalId,
    kind: "batch",
    email: email.toLowerCase().trim(),
    table,
    action: "update",
    recordIds,
    fields: fields ?? {},
    description,
    roleIdAtProposal: roleId === null || roleId === undefined ? undefined : String(roleId),
    status: "proposed",
    succeeded: [],
    failed: [],
    createdAt: now,
    ttl: now + PROPOSAL_TTL_SECONDS,
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
  return proposalId;
}

// Claims the batch for one execute call: only one call may work a batch at
// a time (the model can fire the same tool call twice in parallel, and two
// workers on one batch would double-send records). Succeeds only if the
// row is this caller's batch, is still proposed-and-unexpired or already
// running, and has no live lease. On the first claim it also moves the row
// to "running" and removes its ttl -- from the moment anything may be sent
// to SPP, the row is a permanent audit record. Returns the updated item,
// or null if the claim was refused (caller re-reads the row to say why).
async function acquireBatchLease(proposalId, email, leaseSeconds) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: marshall({ proposalId }),
        UpdateExpression: "SET leaseUntil = :until, #status = :running REMOVE #ttl",
        ConditionExpression:
          "#kind = :batch AND #email = :email AND " +
          "(#status = :running OR (#status = :proposed AND #ttl > :now)) AND " +
          "(attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
        ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl", "#kind": "kind", "#email": "email" },
        ExpressionAttributeValues: marshall({
          ":until": now + leaseSeconds,
          ":running": "running",
          ":proposed": "proposed",
          ":batch": "batch",
          ":email": email.toLowerCase().trim(),
          ":now": now,
        }),
        ReturnValues: "ALL_NEW",
      }),
    );
    return unmarshall(result.Attributes);
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return null;
    throw error;
  }
}

async function saveBatchProgress(proposalId, { succeeded, failed }) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression: "SET succeeded = :succeeded, failed = :failed",
      ExpressionAttributeValues: marshall({ ":succeeded": succeeded, ":failed": failed }),
    }),
  );
}

async function releaseBatchLease(proposalId) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression: "REMOVE leaseUntil",
    }),
  );
}

// Terminal: "executed" (every record attempted) or "stopped" (halted on a
// failure that made continuing unsafe -- stopReason says which).
async function finishBatch(proposalId, { status, stopReason }) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ proposalId }),
      UpdateExpression: "SET #status = :status, executedAt = :executedAt, stopReason = :reason REMOVE leaseUntil",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":status": status,
        ":executedAt": now,
        ":reason": stopReason ?? null,
      }),
    }),
  );
}

module.exports = {
  createBatchProposal,
  acquireBatchLease,
  saveBatchProgress,
  releaseBatchLease,
  finishBatch,
  createProposal,
  createTerminalRecord,
  getProposal,
  markExecuted,
  markRejectedByUs,
  markRejectedBySpp,
  PROPOSAL_TTL_SECONDS,
};
