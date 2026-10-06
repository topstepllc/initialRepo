// The XML API transport for AI-initiated SPP writes. Deliberately new code,
// NOT a reuse of tslib/tslib-putRecords or tslib/tslib-deleteRecords -- those
// Lambdas serve other, unrelated production automations (invoicing,
// timesheet-send) on a company-level service-account token, and are left
// untouched to avoid any risk to their existing consumers. This module
// reuses their CONFIRMED-WORKING XML envelope shape, but authenticates as
// the calling person's own per-user SPP access token instead (see
// sppUserAuth.js's getSppAccessTokenForUser) -- see the write-feature design
// discussion for why that distinction matters for role enforcement.

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { XMLParser } = require("fast-xml-parser");

const ssm = new SSMClient({});
const lambdaClient = new LambdaClient({});

// Small, hardcoded, GLOBAL (not per-company) platform-capability
// EXCEPTIONS -- a table SPP's own API restricts regardless of role, a
// platform constraint rather than something that varies by customer, so
// hardcoded here rather than curated per-company in stepwise_config.json.
// Every table defaults to fully permitted (create/update/delete); an entry
// here overrides just the actions it explicitly sets to false. Confirmed
// with the user (2026-09-27): revenueRecognitionTransactions is the only
// known exception so far -- SPP's API doesn't expose a delete for that
// record type at all (modify is fine). Add further exceptions here as
// they're discovered; this is expected to stay a short list.
const GLOBAL_WRITE_RESTRICTIONS = {
  revenueRecognitionTransactions: { delete: false },
};

function isGloballyPermitted(table, action) {
  const restriction = GLOBAL_WRITE_RESTRICTIONS[table];
  return restriction?.[action] !== false;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// SPP's compound date field shape, confirmed working in
// tslib-putRecords.mjs's own date-handling block -- expects our fields'
// values as plain "YYYY-MM-DD" strings (matching how they come back out of
// execute_spp_query already).
function dateFieldXml(sppField, isoDateStr) {
  const [year, month, day] = String(isoDateStr).split("-");
  return `<${sppField}><Date><year>${escapeXml(year)}</year><month>${pad2(Number(month))}</month><day>${pad2(Number(day))}</day></Date></${sppField}>`;
}

function plainFieldXml(sppField, value) {
  return `<${sppField}>${escapeXml(value)}</${sppField}>`;
}

// Translates the caller's internal snake_case field names into SPP's own
// XML field names via csvFieldToSppField (from masterConfig.js), wrapping
// date-typed fields per dateColumns. Throws on any field name not present
// in that mapping -- silently dropping an unrecognized field would risk a
// write that looks complete but is silently missing data SPP never saw;
// the caller should have already validated against known fields before
// reaching here, so this is a last-resort safety net, not the primary check.
function buildFieldsXml(fields, csvFieldToSppField, dateColumns) {
  const dateSet = new Set(dateColumns);
  let xml = "";
  for (const [csvField, value] of Object.entries(fields)) {
    const sppField = csvFieldToSppField[csvField];
    if (!sppField) {
      throw new Error(`"${csvField}" is not a known field for this table.`);
    }
    xml += dateSet.has(csvField)
      ? dateFieldXml(sppField, value)
      : plainFieldXml(sppField, value);
  }
  return xml;
}

function wrapEnvelope(apiKey, accessToken, actionXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${escapeXml(apiKey)}">
  <Auth>
    <Login>
      <access_token>${escapeXml(accessToken)}</access_token>
    </Login>
  </Auth>
  ${actionXml}
</request>`;
}

function buildAddXml({ apiKey, accessToken, sppType, fields, csvFieldToSppField, dateColumns }) {
  const fieldsXml = buildFieldsXml(fields, csvFieldToSppField, dateColumns);
  const action = `<Add type="${sppType}" enable_custom="1"><${sppType}>${fieldsXml}</${sppType}></Add>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

function buildModifyXml({ apiKey, accessToken, sppType, recordId, fields, csvFieldToSppField, dateColumns }) {
  const fieldsXml = `<id>${escapeXml(recordId)}</id>${buildFieldsXml(fields, csvFieldToSppField, dateColumns)}`;
  const action = `<Modify type="${sppType}" enable_custom="1"><${sppType}>${fieldsXml}</${sppType}></Modify>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

// One request carrying one <Modify> command per record, all setting the
// same field values -- the same multi-command envelope shape
// tslib-putRecords already sends in production for its array writeObj.
function buildBatchModifyXml({ apiKey, accessToken, sppType, recordIds, fields, csvFieldToSppField, dateColumns }) {
  const sharedFieldsXml = buildFieldsXml(fields, csvFieldToSppField, dateColumns);
  const commands = recordIds
    .map(
      (recordId) =>
        `<Modify type="${sppType}" enable_custom="1"><${sppType}><id>${escapeXml(recordId)}</id>${sharedFieldsXml}</${sppType}></Modify>`,
    )
    .join("\n  ");
  return wrapEnvelope(apiKey, accessToken, commands);
}

function buildDeleteXml({ apiKey, accessToken, sppType, recordId }) {
  const action = `<Delete type="${sppType}"><${sppType}><id>${escapeXml(recordId)}</id></${sppType}></Delete>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

class SppWriteRejectedError extends Error {
  constructor(message, rawResponse) {
    super(message);
    this.name = "SppWriteRejectedError";
    this.rawResponse = rawResponse;
  }
}

// Redacts the two credential values that appear in every write XML request
// (the company-level API key in <request key="...">, and the caller's own
// per-user OAuth access_token) to a partial, comparable form -- enough to
// tell "is this the same key as last time" or "is this empty" while
// debugging, without putting a usable secret into CloudWatch. Neither
// value is sensitive-shaped enough to need full redaction-with-no-info, but
// there's no reason to log either one in full either.
function redactSecret(value) {
  if (!value) return "(empty)";
  if (value.length <= 8) return `[REDACTED len=${value.length}]`;
  return `${value.slice(0, 4)}...${value.slice(-4)} [REDACTED len=${value.length}]`;
}

function redactXmlForLogging(xml) {
  return xml
    .replace(/key="[^"]*"/, (m) => `key="${redactSecret(m.slice(5, -1))}"`)
    .replace(/<access_token>[^<]*<\/access_token>/, (m) => `<access_token>${redactSecret(m.slice(14, -15))}</access_token>`);
}

// Sends the built XML request and returns SPP's parsed response node on
// success.
//
// CONFIRMED in production (2026-09-28): SPP embeds its OWN error codes
// inside an HTTP 200 response rather than using a non-2xx status --
// observed a genuine rejection ("The namespace and key do not match",
// SPP's own @_status="505") come back as a normal 200. The original
// version of this function only checked response.ok and "does a <response>
// element exist at all," so that error passed both checks and was reported
// to the caller as a successful write. Fixed by requiring the SPECIFIC
// success shape for the action actually requested (response.Add[sppType],
// response.Modify[sppType], or response.Delete) -- anything else, success
// HTTP status or not, is now treated as a rejection and its actual error
// text is surfaced rather than silently passed through.
//
// The full request (credentials redacted) and raw response are logged
// unconditionally, not just on error -- added specifically to debug a
// reproducible "namespace and key do not match" failure (2026-09-28) that
// the person reported was NOT happening with other writes (a projects
// update) shortly before, so seeing the exact request shape/timing across
// both a working and a failing call is the point, not just capturing
// failures after the fact.
//
// Retries a specific, CONFIRMED-transient failure shape (2026-09-28): a
// bare <response status="505">The namespace and key do not match</response>
// with no <Auth>/<Add>/<Modify>/<Delete> child at all -- proven transient by
// sending the exact same (byte-for-byte identical, same credentials) request
// four times in under a minute: 3 succeeded, 1 failed this way. That shape
// specifically means SPP rejected the request at its own auth/session layer
// BEFORE any write processing happened -- nothing was created, so retrying
// is safe, unlike a genuine validation rejection (which comes back as a
// real <Add status="1">...</Add> with no nested record, a DIFFERENT shape,
// deliberately NOT retried below since retrying can't fix bad data and
// would just delay surfacing the real problem). Not a generalized "retry
// anything" -- only this exact "no action node at all" shape qualifies.
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Posts one XML request and returns { responseNode, text }, retrying only
// the bare auth-layer failure shape described above (no Add/Modify/Delete
// child at all). Throws SppWriteRejectedError for a non-2xx, an unparseable
// body, or a missing <response>; a bare auth-layer failure that's still
// failing on the last attempt is returned as-is for the caller to reject.
async function postXml(xmlUrl, xml, label) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    console.log(
      `SPP XML write request (attempt ${attempt}/${TRANSIENT_RETRY_ATTEMPTS}, ${label}, url=${xmlUrl}): ${redactXmlForLogging(xml)}`,
    );

    const response = await fetch(xmlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    const text = await response.text();

    console.log(
      `SPP XML write response (attempt ${attempt}/${TRANSIENT_RETRY_ATTEMPTS}, ${label}, httpStatus=${response.status}): ${text}`,
    );

    if (!response.ok) {
      throw new SppWriteRejectedError(`SPP request failed [${response.status}]: ${text}`, text);
    }

    let parsed;
    try {
      parsed = parser.parse(text);
    } catch (error) {
      throw new SppWriteRejectedError(`Could not parse SPP's response: ${error.message}`, text);
    }

    const responseNode = parsed?.response;
    if (!responseNode) {
      throw new SppWriteRejectedError(`Unexpected SPP response shape: ${text}`, text);
    }

    const isBareAuthLayerFailure =
      responseNode.Add === undefined && responseNode.Modify === undefined && responseNode.Delete === undefined;

    if (isBareAuthLayerFailure && attempt < TRANSIENT_RETRY_ATTEMPTS) {
      console.log(`Transient-shaped SPP rejection on attempt ${attempt} -- retrying after ${TRANSIENT_RETRY_DELAY_MS}ms.`);
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      continue;
    }

    return { responseNode, text };
  }
}

function describeResponseError(responseNode) {
  return responseNode["#text"] ?? responseNode["@_status"] ?? JSON.stringify(responseNode);
}

async function sendXmlRequest(xmlUrl, xml, { action, sppType }) {
  const { responseNode, text } = await postXml(xmlUrl, xml, `action=${action}, sppType=${sppType}`);

  const successNode =
    action === "create" ? responseNode.Add?.[sppType] : action === "update" ? responseNode.Modify?.[sppType] : responseNode.Delete;

  if (successNode !== undefined) {
    return successNode;
  }

  throw new SppWriteRejectedError(`SPP rejected the request: ${describeResponseError(responseNode)}`, text);
}

// Sends a buildBatchModifyXml request and returns one outcome per record,
// in the same order as recordIds: { recordId, ok: true } or
// { recordId, ok: false, error }. SPP answers a multi-command request with
// one <Modify> element per command, in command order, each carrying its own
// status -- a record SPP rejects (bad value, locked record) doesn't affect
// the others. Throws SppWriteRejectedError when the response as a whole
// can't be trusted (auth-layer failure, or a Modify count that doesn't
// match what was sent) -- in that case NOTHING about which records applied
// is knowable from the response, so the caller must stop rather than guess.
async function sendBatchModifyRequest(xmlUrl, xml, { sppType, recordIds }) {
  const { responseNode, text } = await postXml(
    xmlUrl,
    xml,
    `action=batch-update, sppType=${sppType}, records=${recordIds.length}`,
  );

  if (responseNode.Modify === undefined) {
    throw new SppWriteRejectedError(`SPP rejected the request: ${describeResponseError(responseNode)}`, text);
  }

  const modifyNodes = Array.isArray(responseNode.Modify) ? responseNode.Modify : [responseNode.Modify];
  if (modifyNodes.length !== recordIds.length) {
    throw new SppWriteRejectedError(
      `SPP returned ${modifyNodes.length} result(s) for ${recordIds.length} record(s) -- cannot tell which applied.`,
      text,
    );
  }

  return modifyNodes.map((node, index) => {
    const recordId = recordIds[index];
    const status = typeof node === "object" && node !== null ? node["@_status"] : undefined;
    const record = typeof node === "object" && node !== null ? node[sppType] : undefined;
    if (record !== undefined && (status === undefined || String(status) === "0")) {
      return { recordId, ok: true };
    }
    return { recordId, ok: false, error: `SPP status ${status ?? "unknown"}: ${typeof node === "object" ? JSON.stringify(node) : String(node)}`.slice(0, 300) };
  });
}

let cachedCredentials = null;

// Company-level XML API key + endpoint URL (distinct from the caller's own
// per-user OAuth access token above) -- same SSM naming convention
// sppDataSync.js already established: ${SSM_PARAM_PREFIX}/${instance}Key
// and .../${instance}XMLURL. Cached per warm container; these only change
// via a deploy-time config change.
async function getSppCredentials(instance) {
  if (cachedCredentials) return cachedCredentials;

  const prefix = process.env.SSM_PARAM_PREFIX;
  if (!prefix) {
    throw new Error("SSM_PARAM_PREFIX environment variable is not set on this Lambda");
  }

  const [apiKeyResult, xmlUrlResult] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: `${prefix}/${instance}Key`, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: `${prefix}/${instance}XMLURL`, WithDecryption: true })),
  ]);

  cachedCredentials = {
    apiKey: apiKeyResult.Parameter.Value,
    xmlUrl: xmlUrlResult.Parameter.Value,
  };
  return cachedCredentials;
}

// Fire-and-forget: asks sppDataSync to re-pull just this one table sooner
// than its next scheduled cycle, using the company-level sync credential
// (NOT the caller's own token -- decoupling "who wrote this" from "which
// credential re-confirms it" was a deliberate design choice). Never awaited
// to completion and never throws past this function -- a failure here must
// not fail the write response the user is waiting on; the existing 5-minute
// staleness check in reportEngine.js will pick up the change regardless,
// just later, once the scheduled sync eventually runs.
async function triggerResync(localTable) {
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.SPP_DATA_SYNC_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            integrationKey: process.env.SPP_SYNC_INTEGRATION_KEY,
            instance: process.env.SPP_INSTANCE,
            company: process.env.SPP_INSTANCE_NAME,
            table: localTable,
          }),
        ),
      }),
    );
  } catch (error) {
    console.log(`Failed to trigger post-write resync for "${localTable}": ${error.message}`);
  }
}

module.exports = {
  isGloballyPermitted,
  buildAddXml,
  buildModifyXml,
  buildDeleteXml,
  buildBatchModifyXml,
  sendXmlRequest,
  sendBatchModifyRequest,
  SppWriteRejectedError,
  getSppCredentials,
  triggerResync,
};
