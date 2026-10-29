/**
 * ============================================================================
 *  SPP → Jira Integration  (SR-2707)
 * ============================================================================
 *  File:        jira_integration.mjs
 *  Runtime:     AWS Lambda, Node.js 20.x (ESM)
 *  Trigger:     Pushed from SPP (Function URL / API Gateway), or direct invoke
 *  Owner:       Kim Ward (business)
 *  MLG Sub:     Impetus
 *  Spec:        Confluence > "SPP>Jira Integration" (page 3849814017)
 *
 *  WHAT IT DOES
 *  ------------
 *  One-way sync of project structure from SuiteProjects Pro (SPP) to Jira Cloud.
 *  SPP pushes project data in the request payload. The Lambda syncs it to
 *  Jira, then writes results back to SPP through the shared utils layer
 *  (tslib-putRecords), the same way the bid grid import updates projects.
 *
 *    1. Receives one or more SPP projects in the payload (see PAYLOAD below).
 *    2. Splits them into PARENT and CHILD projects (child = has parentId).
 *    3. PARENT project  → creates/updates a Jira project (space).
 *         - Project lead = Project Manager
 *         - Customer name written to the Jira project description
 *    3b. NEW parent space (or "applyBoardSettings": true) → board settings
 *         are copied from the template space's board
 *         (JIRA_BOARD_TEMPLATE_SPACE_KEY, e.g. GS1706). See BOARD SETTINGS.
 *    4. CHILD project   → creates/updates an Epic in its parent's Jira project.
 *         - Custom fields: Project Manager, Account Director, Budget,
 *           Customer, SPP Project ID
 *    5. Writes back to SPP for every result with writeBack: true:
 *         - CHILD: project name → "<Epic key> <name>" (e.g. "RG1719-2 Name")
 *         - Jira key → SPP_JIRA_KEY_FIELD, if that env var is set
 *       Parent project names are never changed (per spec).
 *
 *  PAYLOAD  (direct invoke: the event itself; HTTP: JSON request body)
 *  -------
 *    {
 *      "projects": [
 *        {
 *          "id": "1234",                      // required
 *          "name": "Website Redesign",        // required
 *          "active": true,                    // optional; false = skipped
 *          "parent_project": null,            // CHILD: parent's SPP internal ID
 *          "jiraKey": null,                   // existing Jira project/epic key
 *          "parentJiraKey": null,             // CHILD: parent's Jira key, if the
 *                                             //   parent isn't in this payload
 *          "clientName": "GSK US",            // customer name → Epic "Client Name"
 *          "userJiraId": "5b10ac8d82e05b22cc7d4ef5",  // PM's Jira accountId
 *          "adJiraId": "60a1b2c3d4e5f6a7b8c9d0e1",    // optional: AD's Jira accountId
 *          "budget": 25000,
 *          "applyBoardSettings": false        // PARENT: true = (re)apply the
 *                                             //   template board settings to an
 *                                             //   existing space
 *        }
 *      ]
 *    }
 *    userJiraId = Jira accountId of the PM, set by the SPP event handler.
 *      Used as the Jira project lead and the Epic "Project Manager" field.
 *      Required to create a parent project (Jira needs a lead).
 *    adJiraId = Jira accountId of the Account Director (Epic field; optional).
 *    No Jira user lookups are made - IDs are used exactly as sent.
 *    A single project object (without the "projects" wrapper) is also accepted.
 *
 *    Epic date changes → SPP (start_date, imp_due_date__c,
 *    imp_jira_dates_changed__c = 1):
 *      { "action": "jiraDatesChanged", "issueKey": "JJRIP5-1" }
 *        one Epic, e.g. from a Jira automation rule
 *      { "action": "pollJiraDates" }   (or any EventBridge scheduled event)
 *        finds Epics whose dates changed in the last POLL_LOOKBACK_MINUTES
 *        and updates each; optional "lookbackMinutes", "includeOwnChanges"
 *
 *    Template dump (read only, nothing is written):
 *      { "action": "dumpBoardTemplate", "spaceKey": "GS1706" }
 *      Returns the template board's filter, quick filters, working days,
 *      board admins and the raw internal edit model. spaceKey defaults to
 *      JIRA_BOARD_TEMPLATE_SPACE_KEY.
 *
 *  RESPONSE
 *  --------
 *    { dryRun, summary: {created, updated, skipped, errors, ...},
 *      results: [ { sppId, type, action, jiraKey, sppName?, writeBack,
 *                   board?, reason?, error? } ] }
 *    writeBack: true → the Lambda updated SPP (see step 5). sppWrite on each
 *      result says what happened: "ok", "nothing to write", or "failed: ...".
 *    board (parents only, when board settings ran):
 *      { status: "ok" | "partial" | "error" | "dry run",
 *        boardId, filterId, warnings: [...] }
 *    HTTP callers get this as the JSON body (200), or 400 / 401 / 500.
 *
 *  BOARD SETTINGS
 *  --------------
 *    Copied from the template space's board to each new parent space:
 *      Public API (supported):
 *        - Filter: one per space, named after the space, template JQL with
 *          the template space swapped for the new one (GS1706:
 *          "project = GS1706 ORDER BY Rank ASC"), same view/edit
 *          permissions (logged-in users view, jira-users edit)
 *        - Board: same type (GS1706: kanban), named after the space,
 *          location = the space
 *      Internal API (/rest/greenhopper/1.0 - undocumented, may change):
 *        - Columns (names/order/status mapping; statuses missing from the
 *          new space's workflow are left unmapped and reported)
 *        - Quick filters (GS1706: 6, none space-specific)
 *        - Working days (weekday flags; GS1706: all 7 days)
 *        - Board administrators (GS1706: 5 users)
 *        - Time zone (GS1706: system default)
 *        - Completed work items (GS1706: "Never mind, show all")
 *        - Card color method (GS1706: work type; colors stay Jira's defaults)
 *        - Card layout fields (GS1706: Due date) and Days in column (on)
 *        - Swimlane method (GS1706: Query; Jira then adds the default lanes
 *          Expedite / Everything Else, which match GS1706)
 *      Not written (new boards already match GS1706):
 *        - Kanban sub-filter
 *    Space configuration: new spaces are created with the template space's
 *      schemes (workflow, work types, screens, fields, permissions,
 *      notifications), so statuses, work types and card colors line up.
 *      JIRA_SHARE_TEMPLATE_SCHEMES=false uses JIRA_PROJECT_TEMPLATE_KEY instead.
 *    Verify: after applying, the board is read back and every setting that
 *      differs from the template is logged as "Mismatch - ...".
 *    Board problems never fail the parent sync: the space and the SPP
 *    write-back still go through, and issues are listed in board.warnings.
 *    Re-running is safe: the board and quick filters are matched by name.
 *
 *  OUT OF SCOPE (per spec)
 *  -----------------------
 *    - Jira → SPP data flow (TBD; possible status for revenue recognition)
 *    - Assigning Jira tasks from PM / AD values (expected to be Jira
 *      automation rules on the Jira side, not this script)
 *
 *  CONVENTIONS
 *  -----------
 *    // TODO(CLARIFY): needs a business / spec answer (Kim / client)
 *    // TODO(CONFIG):  needs an environment value, ID or field name
 *    // TODO(DEV):     technical decision or follow-up for the developer
 *    grep "TODO(" to see everything outstanding.
 *
 *  ENVIRONMENT VARIABLES
 *  ---------------------
 *    JIRA_BASE_URL               e.g. https://<site>.atlassian.net
 *                                (scoped API token: https://api.atlassian.com/ex/jira/<cloudId>)
 *    JIRA_EMAIL                  Email of the Atlassian account that created the token
 *    JIRA_API_TOKEN              Atlassian API token (Basic auth password)
 *    JIRA_PROJECT_TYPE_KEY       default "software"
 *    JIRA_PROJECT_TEMPLATE_KEY   e.g. com.pyxis.greenhopper.jira:gh-simplified-scrum-classic
 *    JIRA_CF_PROJECT_MANAGER     optional override; default customfield_11800
 *                                (Epic "DSS", user picker ← Project Manager)
 *    JIRA_CF_ACCOUNT_DIRECTOR    optional override; default customfield_11801
 *                                (Epic "Account Manager", user picker ← Account Director)
 *    JIRA_CF_BUDGET              e.g. customfield_10052  (number)
 *    JIRA_CF_CUSTOMER            optional override; default customfield_10802
 *                                (Epic "Client Name", short text)
 *    JIRA_CF_SPP_ID              optional override; default customfield_12732
 *                                (Epic "SPP Project ID", short text)
 *    JIRA_BOARD_TEMPLATE_SPACE_KEY  e.g. GS1706. Space whose board settings
 *                                are copied to new parent spaces. Unset =
 *                                board settings are skipped.
 *    JIRA_SHARE_TEMPLATE_SCHEMES    default "true": new spaces share the
 *                                template space's schemes (see BOARD SETTINGS)
 *    JIRA_BOARD_TEMPLATE_BOARD_ID   optional; only needed if the template
 *                                space has more than one board
 *    INBOUND_API_KEY             optional; if set, HTTP callers must send it in
 *                                the "x-api-key" header
 *    POLL_LOOKBACK_MINUTES       pollJiraDates window, default 20 (schedule
 *                                every 15 min so windows overlap)
 *    POLL_INCLUDE_OWN_CHANGES    "true" = pollJiraDates also picks up date
 *                                changes made by the token's own account
 *                                (testing only; see pollJiraDates)
 *    DRY_RUN                     "true" = log intended Jira writes, write nothing
 *                                (no SPP write-back either)
 *
 *    SPP write-back (same names as the bid grid import):
 *    COMPANY, USER, PASSWORD, INSTANCE   SPP API login for tslib-putRecords
 *    SPP_JIRA_KEY_FIELD          optional; SPP project custom field to store
 *                                the Jira key in (e.g. jira_key__c)
 *
 *  AWS
 *  ---
 *    Shared utils Lambda layer must be attached (/opt/nodejs/sharedUtils.js),
 *    used for the SPP write-back. No other dependencies.
 *
 *  ALPHA NOTE
 *  ----------
 *    Jira credentials are read from Lambda env vars for alpha testing. They
 *    are visible in plain text to anyone who can read the function config.
 *    Move them to Secrets Manager before go-live.
 * ============================================================================
 */

import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  jiraBaseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
  // TODO(DEV): ALPHA ONLY. Credentials come from env vars, which are visible
  //   in plain text to anyone who can read the Lambda config. Before go-live,
  //   move them to Secrets Manager (or switch to an Atlassian service account
  //   with OAuth 2.0 client credentials). Jira API tokens expire (max 1 year).
  jiraEmail: process.env.JIRA_EMAIL,
  jiraApiToken: process.env.JIRA_API_TOKEN,
  jiraProjectTypeKey: process.env.JIRA_PROJECT_TYPE_KEY || "software",
  // TODO(CLARIFY): Which Jira template / board type does the client want
  //   (scrum vs kanban, company-managed vs team-managed)? The REST create
  //   project endpoint only supports company-managed templates cleanly.
  jiraProjectTemplateKey: process.env.JIRA_PROJECT_TEMPLATE_KEY,
  // TODO(CLARIFY): Spec says "Custom Field – Name TBD" for PM and AD.
  // TODO(CONFIG):  Once named/created in Jira, put the customfield_xxxxx IDs here.
  cf: {
    // Epic user pickers (IDs from the client, 2026-10-16). Env vars only override.
    projectManager: process.env.JIRA_CF_PROJECT_MANAGER || "customfield_11800", // "DSS" ← Project Manager
    accountDirector:
      process.env.JIRA_CF_ACCOUNT_DIRECTOR || "customfield_11801", // "Account Manager" ← Account Director
    budget: process.env.JIRA_CF_BUDGET,
    // Epic "Touchpoint Details" tab fields (IDs from Jira admin, 2026-10-16).
    //   Env vars only override these.
    customer: process.env.JIRA_CF_CUSTOMER || "customfield_10802", // Client Name (short text)
    sppId: process.env.JIRA_CF_SPP_ID || "customfield_12732", // SPP Project ID (short text)
    // Epic dates (2026-10-20). Due date is Jira's built-in field.
    startDate: process.env.JIRA_CF_START_DATE || "customfield_11401", // Start Date ↔ SPP start_date
    dueDate: "duedate", // Due date ↔ SPP imp_due_date__c
    // SPP child project name, set when the Epic is created (2026-10-20).
    sppProjectName: process.env.JIRA_CF_SPP_PROJECT_NAME || "customfield_12734",
  },
  // Space whose board settings are copied to new parent spaces (e.g. GS1706).
  boardTemplateSpaceKey: (
    process.env.JIRA_BOARD_TEMPLATE_SPACE_KEY || ""
  ).trim(),
  boardTemplateBoardId: (process.env.JIRA_BOARD_TEMPLATE_BOARD_ID || "").trim(),
  // New spaces use the template space's schemes (workflow, work types,
  //   screens, fields, permissions, notifications) so statuses, work types
  //   and card colors match. "false" = use JIRA_PROJECT_TEMPLATE_KEY instead.
  shareTemplateSchemes:
    String(process.env.JIRA_SHARE_TEMPLATE_SCHEMES ?? "true").toLowerCase() !==
    "false",
  inboundApiKey: process.env.INBOUND_API_KEY,
  // Optional SPP project custom field to store the Jira key in. Without it,
  //   parents have no saved key and a re-pushed parent creates a new space.
  sppJiraKeyField: process.env.SPP_JIRA_KEY_FIELD,
  // SPP project field that holds a CHILD project's Epic key (e.g. "JJRIP5-1").
  //   Written after the Epic is created and read on later syncs.
  sppEpicKeyField: process.env.SPP_EPIC_KEY_FIELD || "project_code__c",
  dryRun: String(process.env.DRY_RUN).toLowerCase() === "true",
  // Who Epics may be assigned to (2026-10-22: testing emailed real users, so
  //   assignment is limited). Anyone else is replaced by assigneeDefault.
  //   Override with comma-separated account IDs in ASSIGNEE_ALLOWLIST.
  assigneeAllowlist: (
    process.env.ASSIGNEE_ALLOWLIST ||
    [
      "557058:73c9cac1-5a92-492c-86e8-838810ee0dde", // Dan Wells
      "557058:9827514e-9c5e-4d9d-af37-340b82b8423b", // Alyssia Grant
    ].join(",")
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  assigneeDefault:
    process.env.ASSIGNEE_DEFAULT ||
    "557058:73c9cac1-5a92-492c-86e8-838810ee0dde", // Dan Wells
  // pollJiraDates: how far back to look for Epic date changes. Keep it a bit
  //   longer than the schedule interval (e.g. 20 for a 15-minute schedule).
  pollLookbackMinutes: Number(process.env.POLL_LOOKBACK_MINUTES) || 20,
  // pollJiraDates: "true" also picks up changes made by the token's own
  //   account (for testing while the token is a person's). Leave off in
  //   production, or every SPP sync that sets dates would bounce back.
  pollIncludeOwnChanges:
    String(process.env.POLL_INCLUDE_OWN_CHANGES).toLowerCase() === "true",
};

// SPP login for the write-back (same env vars as the bid grid import).
const sppAuthObj = {
  company: process.env.COMPANY,
  user: process.env.USER,
  password: process.env.PASSWORD,
  instance: process.env.INSTANCE,
};

// Cached across warm invocations
let jiraAuthHeader;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event = {}) => {
  const isHttp = isHttpEvent(event);

  if (isHttp && CFG.inboundApiKey) {
    const provided = headerValue(event.headers, "x-api-key");
    if (!safeEqual(provided, CFG.inboundApiKey)) {
      console.warn("Rejected request: missing or invalid x-api-key");
      return httpResponse(401, { error: "Unauthorized" });
    }
  }
  // TODO(DEV): If the Function URL auth type is NONE and INBOUND_API_KEY is
  //   unset, anyone with the URL can create Jira projects. Set the key.

  let payload;
  let projects;
  try {
    payload = parseBody(event, isHttp);
    if (!NON_PROJECT_ACTIONS.has(payload?.action))
      projects = getProjectList(payload);
  } catch (err) {
    console.error(`Bad payload: ${err.message}`);
    if (isHttp) return httpResponse(400, { error: err.message });
    throw err;
  }

  try {
    loadCredentials();
    const out =
      payload?.action === "dumpBoardTemplate"
        ? await dumpBoardTemplate(payload.spaceKey)
        : payload?.action === "jiraDatesChanged"
          ? await syncDatesToSpp(payload)
          : payload?.action === "pollJiraDates"
            ? await pollJiraDates(payload)
            : await syncProjects(projects);
    return isHttp ? httpResponse(200, out) : out;
  } catch (err) {
    console.error(`Fatal: ${err.stack || err.message}`);
    if (isHttp) return httpResponse(500, { error: err.message });
    throw err;
  }
};

const NON_PROJECT_ACTIONS = new Set([
  "dumpBoardTemplate",
  "jiraDatesChanged",
  "pollJiraDates",
]);

async function syncProjects(rawProjects) {
  console.log(
    `Run start. projects=${rawProjects.length} dryRun=${CFG.dryRun}` +
      ` boardTemplate=${CFG.boardTemplateSpaceKey || "none"}`,
  );
  // Raw payload as received, so field-name mismatches with the SPP event
  //   handler are visible (e.g. clientName / userJiraId / adJiraId missing).
  // SPP sends the full project record (hundreds of fields), so only the
  //   ones this integration reads are logged. "(missing)" = key not present.
  const USED_KEYS = [
    "id",
    "name",
    "active",
    "parent_project",
    "parent_project__c",
    "parentId",
    "jiraKey",
    "project_code__c",
    "parentJiraKey",
    "clientName",
    "customer",
    "customerid",
    "userJiraId",
    "adJiraId",
    "budget",
    "applyBoardSettings",
    "start_date",
    "imp_due_date__c",
  ];
  for (const raw of rawProjects) {
    const picked = Object.fromEntries(
      USED_KEYS.map((k) => [k, raw && k in raw ? raw[k] : "(missing)"]),
    );
    console.log(
      `[Received SPP ${raw?.id ?? "?"}] ${JSON.stringify(picked)} ` +
        `(${raw ? Object.keys(raw).length : 0} keys in payload)`,
    );
  }
  boardTemplatePromise = null; // re-read the template board once per run
  templateSchemesPromise = null;
  const results = [];

  const projects = [];
  for (const raw of rawProjects) {
    try {
      projects.push(normalizeProject(raw));
    } catch (err) {
      results.push(errorResult(raw?.id, null, err));
    }
  }

  const inScope = [];
  for (const p of projects) {
    if (isInScope(p)) inScope.push(p);
    else
      results.push({
        sppId: p.id,
        type: p.parentId ? "epic" : "project",
        action: "skipped",
        jiraKey: p.jiraKey,
        writeBack: false,
        reason: "Inactive",
      });
  }

  const parents = inScope.filter((p) => !p.parentId);
  const children = inScope.filter((p) => p.parentId);
  logPlan(parents, children);

  // Parents first so children in the same payload can use their Jira key.
  const parentKeyById = new Map();
  const createdProjectKeys = new Set(); // new projects have no Epics yet
  for (const p of parents) {
    try {
      const r = await syncParentProject(p);
      if (r.jiraKey && (r.action === "created" || p.applyBoardSettings))
        r.board = await syncBoardSettings(r.jiraKey, {
          newSpace: r.action === "created",
        });
      else if (r.jiraKey)
        console.log(
          `[Board ${r.jiraKey}] Skipped: space already existed and applyBoardSettings is not set`,
        );
      results.push(r);
      if (r.jiraKey) parentKeyById.set(p.id, r.jiraKey);
      if (r.action === "created") createdProjectKeys.add(r.jiraKey);
    } catch (err) {
      results.push(errorResult(p.id, "project", err));
    }
  }

  for (const c of children) {
    try {
      results.push(
        await syncChildProject(c, parentKeyById, createdProjectKeys),
      );
    } catch (err) {
      results.push(errorResult(c.id, "epic", err));
    }
  }

  await writeBackToSpp(results);

  const count = (a) => results.filter((r) => r.action === a).length;
  const boardStatus = (s) =>
    results.filter((r) => r.board?.status === s).length;
  const summary = {
    created: count("created"),
    updated: count("updated"),
    skipped: count("skipped"),
    errors: count("error"),
    sppWritten: results.filter((r) => r.sppWrite === "ok").length,
    sppWriteFailed: results.filter((r) => r.sppWrite?.startsWith("failed"))
      .length,
    boardsOk: boardStatus("ok"),
    boardsPartial: boardStatus("partial"),
    boardsFailed: boardStatus("error"),
  };
  console.log("Run summary", JSON.stringify(summary));
  if (summary.errors)
    console.error(
      "Errors",
      JSON.stringify(
        results.filter((r) => r.action === "error"),
        null,
        2,
      ),
    );

  // TODO(CLARIFY): Who should be notified on errors (email/SNS/Slack/Jira ticket)?
  return { dryRun: CFG.dryRun, summary, results };
}

// ---------------------------------------------------------------------------
// SPP write-back (tslib-putRecords via the shared utils layer)
// ---------------------------------------------------------------------------
// Same pattern as the bid grid import's project update:
//   callSharedUtil("tslib-putRecords", { authObj, recordType: "Project",
//                                         writeObj: { id, ...fields } })
// One call per project so a failure is reported against the right record.
async function writeBackToSpp(results) {
  const pending = results.filter((r) => r.writeBack);
  if (pending.length === 0) return;

  const missing = ["COMPANY", "USER", "PASSWORD", "INSTANCE"].filter(
    (k) => !process.env[k],
  );

  for (const r of pending) {
    const writeObj = { id: r.sppId };
    if (r.type === "epic" && r.sppName) writeObj.name = r.sppName;
    if (r.type === "epic" && r.jiraKey && CFG.sppEpicKeyField)
      writeObj[CFG.sppEpicKeyField] = r.sppProjectCode ?? r.jiraKey;
    if (CFG.sppJiraKeyField && r.jiraKey)
      writeObj[CFG.sppJiraKeyField] = r.jiraKey;

    if (Object.keys(writeObj).length === 1) {
      // e.g. a parent when SPP_JIRA_KEY_FIELD isn't set
      r.sppWrite = "nothing to write";
      continue;
    }
    if (missing.length) {
      r.sppWrite = `failed: missing env var(s) ${missing.join(", ")}`;
      console.error(`SPP write-back for ${r.sppId} skipped: ${r.sppWrite}`);
      continue;
    }

    try {
      const response = await callSpp("tslib-putRecords", {
        authObj: sppAuthObj,
        recordType: "Project",
        writeObj,
      });
      console.log(
        `SPP project ${r.sppId} updated: ${JSON.stringify(writeObj)}`,
        `response: ${JSON.stringify(response)?.slice(0, 500)}`,
      );
      r.sppWrite = "ok";
    } catch (err) {
      r.sppWrite = `failed: ${err.message}`;
      console.error(`SPP write-back for ${r.sppId} failed: ${err.message}`);
    }
  }
}

// Shared utils are loaded on first use, so a missing layer only affects the
// SPP write-back, not the Jira sync.
let sharedUtilsModule;
async function getCallSharedUtil() {
  if (!sharedUtilsModule) {
    const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
      ? "/opt/nodejs/sharedUtils.js"
      : "../../shared/sharedUtils.js";
    try {
      sharedUtilsModule = await import(sharedPath);
    } catch (err) {
      throw new Error(
        `Could not load shared utils from ${sharedPath} (is the layer attached?): ${err.message}`,
      );
    }
  }
  return sharedUtilsModule.callSharedUtil;
}

// The shared utils interpolate values straight into the SPP XML request, so
// a name like "Advisor Recruitment & Contracting" must be escaped or SPP
// rejects it. Same approach as the bid grid import.
// NOTE: if xmlEscape is later added inside sharedUtils itself, remove this or
// values will be double-escaped.
const XML_ESCAPED_REQUEST_KEYS = ["criteriaObj", "writeObj"];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;") // must be first
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeDeep(value) {
  if (typeof value === "string") return xmlEscape(value);
  if (Array.isArray(value)) return value.map(escapeDeep);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, escapeDeep(v)]),
    );
  return value;
}

async function callSpp(utilName, request) {
  const callSharedUtil = await getCallSharedUtil();
  const safeRequest = { ...request };
  for (const key of XML_ESCAPED_REQUEST_KEYS)
    if (safeRequest[key] !== undefined)
      safeRequest[key] = escapeDeep(safeRequest[key]);
  return callSharedUtil(utilName, safeRequest);
}

// Logs the parent → children hierarchy before anything is sent to Jira, so a
// child that can't find its parent is visible up front.
function logPlan(parents, children) {
  const parentIds = new Set(parents.map((p) => p.id));
  const lines = ["Plan:"];
  for (const p of parents) {
    lines.push(
      `  Space  SPP ${p.id} "${p.name}" ${p.jiraKey ? `(update ${p.jiraKey})` : "(create)"}` +
        (p.applyBoardSettings ? " + board settings" : ""),
    );
    for (const c of children.filter((c) => c.parentId === p.id))
      lines.push(
        `    Epic SPP ${c.id} "${c.name}" ${c.jiraKey ? `(update ${c.jiraKey})` : "(create)"}`,
      );
  }
  for (const c of children.filter((c) => !parentIds.has(c.parentId)))
    lines.push(
      `  Epic   SPP ${c.id} "${c.name}" → parent ${c.parentId} not in payload, ` +
        (c.parentJiraKey
          ? `using parentJiraKey ${c.parentJiraKey}`
          : c.jiraKey
            ? `using the space from saved Epic key ${c.jiraKey}`
            : "will look up the parent's space by SPP ID"),
    );
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Jira → SPP: Epic date changes
// ---------------------------------------------------------------------------
// Called by a Jira automation rule when an Epic's Start Date or Due date
// changes. The rule only needs to send the Epic key:
//   { "action": "jiraDatesChanged", "issueKey": "{{issue.key}}" }
// (a native Jira webhook body with issue.key also works). The Lambda reads
// the Epic itself, so values never depend on the rule's templates.
// Writes to the SPP child project: start_date, imp_due_date__c and
// imp_jira_dates_changed__c = 1.
// Loops: the child sync writes these same dates to Jira, which also counts
//   as a change. The rule must skip changes made by the integration account
//   (condition "Initiator is not <integration account>"), or every SPP sync
//   would tick the checkbox.
const SPP_DATE_FIELDS = {
  start: "start_date",
  due: "imp_due_date__c",
  changedFlag: "imp_jira_dates_changed__c",
};

async function syncDatesToSpp(payload) {
  const issueKey = String(payload.issueKey ?? payload.issue?.key ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/i.test(issueKey))
    throw new Error(`jiraDatesChanged needs an Epic key (got "${issueKey}")`);

  const issue = await jiraRequest(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${[
      CFG.cf.sppId,
      CFG.cf.startDate,
      CFG.cf.dueDate,
      "issuetype",
    ].join(",")}`,
    null,
    { allow404: true },
  );
  if (!issue) throw new Error(`Epic ${issueKey} not found`);

  const f = issue.fields ?? {};
  const sppId = String(f[CFG.cf.sppId] ?? "").trim();
  const startDate = toJiraDate(f[CFG.cf.startDate]);
  const dueDate = toJiraDate(f[CFG.cf.dueDate]);
  const tag = `[Dates ${issueKey}]`;
  console.log(
    `${tag} Jira: ${JSON.stringify({ sppId, startDate, dueDate, type: f.issuetype?.name })}`,
  );

  if (!sppId) {
    // Not an integration Epic (or SPP Project ID was removed) - nothing to update.
    console.warn(`${tag} Skipped: no SPP Project ID on the Epic`);
    return {
      issueKey,
      action: "skipped",
      reason: "No SPP Project ID on the Epic",
    };
  }

  const writeObj = { id: sppId, [SPP_DATE_FIELDS.changedFlag]: "1" };
  // TODO(CLARIFY): A date cleared in Jira is not cleared in SPP (only set
  //   dates are written). Confirm that's wanted, and how SPP expects an
  //   empty date if it should be cleared.
  if (startDate) writeObj[SPP_DATE_FIELDS.start] = startDate;
  if (dueDate) writeObj[SPP_DATE_FIELDS.due] = dueDate;

  if (CFG.dryRun) {
    console.log(`${tag} [DRY RUN] SPP update ${JSON.stringify(writeObj)}`);
    return { issueKey, sppId, action: "dry run", writeObj };
  }
  const missing = ["COMPANY", "USER", "PASSWORD", "INSTANCE"].filter(
    (k) => !process.env[k],
  );
  if (missing.length)
    throw new Error(`Missing env var(s) for SPP: ${missing.join(", ")}`);

  // TODO(DEV): Dates are sent as "YYYY-MM-DD". Confirm tslib-putRecords
  //   accepts that for start_date (a standard SPP date field) as well as the
  //   custom imp_due_date__c.
  const response = await callSpp("tslib-putRecords", {
    authObj: sppAuthObj,
    recordType: "Project",
    writeObj,
  });
  console.log(
    `${tag} SPP project ${sppId} updated: ${JSON.stringify(writeObj)} response: ${JSON.stringify(response)?.slice(0, 500)}`,
  );
  return { issueKey, sppId, action: "updated", writeObj };
}

// ---------------------------------------------------------------------------
// Jira → SPP: scheduled poll for Epic date changes
// ---------------------------------------------------------------------------
// Alternative to a Jira automation rule. Run on a schedule (EventBridge, e.g.
// every 15 minutes) with { "action": "pollJiraDates" }:
//   1. Find integration Epics updated in the last POLL_LOOKBACK_MINUTES.
//   2. Read each one's change history; keep Epics whose Start Date or Due
//      date changed in that window, by someone other than the token's
//      account (unless POLL_INCLUDE_OWN_CHANGES / includeOwnChanges is on).
//   3. For each, run the same SPP write as jiraDatesChanged.
// Overlapping windows can process an Epic twice; the SPP write is the same
// both times, so that's harmless.
// Optional payload overrides: { lookbackMinutes, includeOwnChanges }.
let selfAccountId;

async function pollJiraDates(payload = {}) {
  const lookback = Number(payload.lookbackMinutes) || CFG.pollLookbackMinutes;
  const includeOwn =
    payload.includeOwnChanges === undefined
      ? CFG.pollIncludeOwnChanges
      : isTruthyFlag(payload.includeOwnChanges);
  const since = Date.now() - lookback * 60_000;
  const dateFields = new Set([CFG.cf.startDate, CFG.cf.dueDate]);

  if (!selfAccountId)
    selfAccountId = (await jiraRequest("GET", "/rest/api/3/myself"))?.accountId;

  const cfNum = CFG.cf.sppId.replace("customfield_", "");
  const jql = `issuetype = Epic AND cf[${cfNum}] is not EMPTY AND updated >= -${lookback}m ORDER BY updated DESC`;
  const keys = [];
  for (let token; ; ) {
    const res = await jiraRequest(
      "GET",
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=100` +
        (token ? `&nextPageToken=${encodeURIComponent(token)}` : ""),
      null,
      { readOnly: true },
    );
    keys.push(...(res?.issues ?? []).map((i) => i.key));
    token = res?.nextPageToken;
    if (!token || res?.isLast) break;
  }
  console.log(
    `[Poll] ${keys.length} Epic(s) updated in the last ${lookback} min` +
      (includeOwn ? " (including the integration's own changes)" : ""),
  );

  const results = [];
  for (const key of keys) {
    try {
      const change = await findDateChange(key, dateFields, since, includeOwn);
      if (!change) continue;
      console.log(
        `[Poll] ${key}: ${change.fields.join(", ")} changed by ${change.author} at ${change.at}`,
      );
      results.push({
        ...(await syncDatesToSpp({ issueKey: key })),
        changedBy: change.author,
      });
    } catch (err) {
      // One bad Epic doesn't stop the rest.
      console.error(`[Poll] ${key} failed: ${err.message}`);
      results.push({ issueKey: key, action: "error", error: err.message });
    }
  }

  const summary = {
    checked: keys.length,
    updated: results.filter((r) => r.action === "updated").length,
    skipped: results.filter((r) => r.action === "skipped").length,
    errors: results.filter((r) => r.action === "error").length,
  };
  console.log(`[Poll] Summary ${JSON.stringify(summary)}`);
  return { dryRun: CFG.dryRun, lookbackMinutes: lookback, summary, results };
}

// Latest Start Date / Due date change on an Epic since `since`, ignoring the
//   token account's own edits unless includeOwn. Null if there isn't one.
async function findDateChange(issueKey, dateFields, since, includeOwn) {
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`;
  // The changelog is oldest-first; read the total, then the most recent page.
  const first = await jiraRequest("GET", `${path}?maxResults=100`);
  const total = first?.total ?? 0;
  const page =
    total > 100
      ? await jiraRequest(
          "GET",
          `${path}?maxResults=100&startAt=${total - 100}`,
        )
      : first;

  let latest = null;
  for (const h of page?.values ?? []) {
    const at = Date.parse(h.created);
    if (!(at >= since)) continue;
    if (
      !includeOwn &&
      h.author?.accountId &&
      h.author.accountId === selfAccountId
    )
      continue;
    const fields = (h.items ?? [])
      .filter((it) => dateFields.has(it.fieldId))
      .map((it) => it.field);
    if (fields.length && (!latest || at > latest.atMs))
      latest = {
        atMs: at,
        at: h.created,
        author: h.author?.displayName ?? "unknown",
        fields,
      };
  }
  return latest;
}

// "YYYY-MM-DD" from SPP ("2026-09-17 0:0:0") or Jira ("2026-09-17") values;
//   null for empty or "0000-00-00".
function toJiraDate(value) {
  const m = String(value ?? "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || m[1] === "0000" || m[2] === "00" || m[3] === "00") return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------
function parseBody(event, isHttp) {
  let payload = event;
  if (isHttp) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body;
    if (!raw) throw new Error("Request body is empty");
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("Request body is not valid JSON");
    }
  }
  // An EventBridge schedule with no custom input sends its own event; treat
  //   it as a date poll.
  if (
    payload?.source === "aws.events" ||
    payload?.["detail-type"] === "Scheduled Event"
  )
    return { action: "pollJiraDates" };
  return payload;
}

function getProjectList(payload) {
  const list = Array.isArray(payload?.projects)
    ? payload.projects
    : Array.isArray(payload)
      ? payload
      : payload?.id
        ? [payload]
        : null;
  if (!list || list.length === 0)
    throw new Error('Payload must contain a non-empty "projects" array');
  return list;
}

const isTruthyFlag = (v) => [true, 1, "1", "true"].includes(v);

function normalizeProject(raw) {
  if (!raw || raw.id === undefined || raw.id === null || raw.id === "")
    throw new Error("Project is missing id");
  if (!raw.name) throw new Error(`Project ${raw.id} is missing name`);

  const blankToNull = (v) =>
    v === undefined ||
    v === null ||
    String(v).trim() === "" ||
    String(v) === "0"
      ? null
      : String(v).trim();

  const budget =
    raw.budget !== undefined && raw.budget !== null && raw.budget !== ""
      ? Number(raw.budget)
      : null;

  const p = {
    id: String(raw.id),
    name: String(raw.name),
    active: raw.active,
    // Parent = SPP parent_project field (internal ID of the parent project).
    //   parent_project__c and parentId are accepted too.
    parentId: parentProjectId(
      blankToNull(raw.parent_project) ??
        blankToNull(raw.parent_project__c) ??
        blankToNull(raw.parentId),
    ),
    jiraKey: blankToNull(raw.jiraKey),
    // Epic key saved on the SPP project by a previous sync (children only).
    // Project code, e.g. "1719" before the Epic exists and "1719-JJRIP5-2"
    //   after: the code with the Epic key appended (see projectCodeFor).
    projectCode: blankToNull(raw[CFG.sppEpicKeyField]),
    ...splitProjectCode(blankToNull(raw[CFG.sppEpicKeyField])),
    parentJiraKey: blankToNull(raw.parentJiraKey),
    // Customer name. The SPP event handler sends it as "clientName"
    //   (objects[i].clientName = client.name); the others are fallbacks.
    customerName:
      blankToNull(raw.clientName) ??
      blankToNull(raw.customer?.name) ??
      blankToNull(raw.customer_name) ??
      blankToNull(raw.customerName) ??
      (typeof raw.customer === "string" ? blankToNull(raw.customer) : null),
    // TODO(CLARIFY): Confirm SPP "project owner" is the Project Manager, and
    //   where "Account Director" lives in SPP (SPP-side script sends both).
    pmUserId: blankToNull(
      raw.projectManager?.id ??
        raw.trv_proj_secondary_project_manager__c ??
        raw.userid,
    ),
    // Jira accountIds sent by the SPP event handler (no lookup here).
    pmAccountId: blankToNull(raw.userJiraId),
    adAccountId: blankToNull(raw.adJiraId),
    // TODO(CLARIFY): Which SPP value is "Child Budget Amount"? Currency?
    budget: Number.isFinite(budget) ? budget : null,
    // Parent only: re-apply template board settings to an existing space.
    applyBoardSettings: isTruthyFlag(raw.applyBoardSettings),
    // Child dates → Epic Start Date / Due date. SPP sends "YYYY-MM-DD" or
    //   "YYYY-MM-DD 0:0:0"; "0000-00-00" means no date.
    startDate: toJiraDate(raw.start_date),
    dueDate: toJiraDate(raw.imp_due_date__c),
  };
  // A child's saved Epic key identifies its Epic directly on re-syncs. Only
  //   used when it looks like an issue key, so other values are ignored.
  if (p.parentId && !p.jiraKey && p.savedEpicKey) p.jiraKey = p.savedEpicKey;
  return p;
}

// Splits a project code into its own part and a trailing Epic key:
//   "1719"          → { projectCodeBase: "1719", savedEpicKey: null }
//   "1719-JJRIP5-2" → { projectCodeBase: "1719", savedEpicKey: "JJRIP5-2" }
//   "JJRIP5-2"      → { projectCodeBase: "",     savedEpicKey: "JJRIP5-2" }
// An Epic key starts with a letter, so numeric codes are never mistaken for
//   one. NOTE: a code that itself looks like a key (e.g. "GS-1719") would be;
//   the space check in syncChildProject stops it being used for the wrong Epic.
function splitProjectCode(code) {
  if (!code) return { projectCodeBase: "", savedEpicKey: null };
  const m = code.match(/^(?:(.*)-)?([A-Z][A-Z0-9_]+-\d+)$/i);
  return m
    ? { projectCodeBase: m[1] ?? "", savedEpicKey: m[2].toUpperCase() }
    : { projectCodeBase: code, savedEpicKey: null };
}

// Value written back to the project code: "<code>-<Epic key>", or just the key
//   when the project had no code.
function projectCodeFor(c, epicKey) {
  return c.projectCodeBase ? `${c.projectCodeBase}-${epicKey}` : epicKey;
}

// SPP sends parent_project as "<customerId>:<projectId>" (e.g. "1002:2899").
// Only the project ID is needed to match the parent's id.
function parentProjectId(value) {
  if (!value) return null;
  const projectId = value.includes(":") ? value.split(":").pop().trim() : value;
  return projectId && projectId !== "0" ? projectId : null;
}

function isInScope(p) {
  // TODO(CLARIFY): What happens when a project goes inactive/closed in SPP?
  //   Options: do nothing, archive the Jira project, transition the Epic to
  //   Done. Currently inactive projects are simply skipped.
  // Only an explicit "inactive" skips a project. SPP sometimes sends active
  //   as "" (seen 2026-10-22 on parent 2899), which means unknown, not inactive.
  const v = String(p.active ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false"].includes(v);
}

// ---------------------------------------------------------------------------
// Parent project → Jira project (space)
// ---------------------------------------------------------------------------
async function syncParentProject(p) {
  const pmAccountId = p.pmAccountId;
  const name = buildJiraProjectName(p);
  const description = `SPP Project ID: ${p.id}\nCustomer: ${p.customerName ?? "n/a"}`;
  // TODO(CLARIFY): Spec says "Customer information is passed from SPP to Jira"
  //   but doesn't say where. Jira projects have no custom fields. Options:
  //   project description (done here), a Project Category per customer,
  //   a customer custom field on every Epic (also done below if configured),
  //   or a JSM Organization.

  // TODO(CLARIFY): Account Director at the parent level. Jira projects only
  //   have a single "lead". AD is currently only set on child Epics.

  // No saved key: look for a space already created for this SPP project
  //   (matched by "SPP Project ID: <id>" in its description) before creating
  //   one, so a re-sync never tries to create the same space twice.
  if (!p.jiraKey) {
    const existing = await findSpaceForSppProject(p.id, name);
    if (existing) {
      console.log(
        `Space ${existing} already exists for SPP ${p.id} - updating it instead of creating`,
      );
      p.jiraKey = existing;
    }
  }

  if (p.jiraKey) {
    // TODO(CLARIFY): Which fields should update after creation? Currently:
    //   name, lead, description. The key never changes.
    await jiraRequest(
      "PUT",
      `/rest/api/3/project/${encodeURIComponent(p.jiraKey)}`,
      {
        name,
        description,
        ...(pmAccountId && { leadAccountId: pmAccountId }),
      },
    );
    return {
      sppId: p.id,
      type: "project",
      action: "updated",
      jiraKey: p.jiraKey,
      writeBack: false,
    };
  }

  if (!pmAccountId) {
    // Jira requires a project lead on create.
    // TODO(CLARIFY): Fallback lead when PM is missing or not a Jira user?
    throw new Error(
      `No userJiraId in payload - Jira needs a project lead ` +
        `(SPP user ${p.pmUserId ?? "n/a"})`,
    );
  }

  const key = await generateUniqueProjectKey(
    p,
    p.customerName ? { name: p.customerName } : null,
  );
  let created;
  try {
    const schemes = await getTemplateSchemes();
    created = await jiraRequest("POST", "/rest/api/3/project", {
      key,
      name,
      description,
      projectTypeKey: CFG.jiraProjectTypeKey,
      leadAccountId: pmAccountId,
      assigneeType: "UNASSIGNED",
      // Jira rejects a project template key together with a workflow scheme,
      //   so the template key is only sent when schemes aren't shared.
      ...(schemes ?? { projectTemplateKey: CFG.jiraProjectTemplateKey }),
    });
    console.log(
      `Created space ${key} "${name}"` +
        (schemes
          ? ` with ${CFG.boardTemplateSpaceKey}'s schemes ${JSON.stringify(schemes)}`
          : ` from template ${CFG.jiraProjectTemplateKey}`),
    );
  } catch (err) {
    // A server error or timeout can still leave the space created. If a
    // space with this key now exists for this SPP project, treat it as done.
    const existing = await jiraRequest(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(key)}`,
      null,
      { allow404: true },
    ).catch(() => null);
    const desc =
      typeof existing?.description === "string" ? existing.description : "";
    if (existing && desc.includes(`SPP Project ID: ${p.id}`)) {
      console.warn(
        `Create for SPP ${p.id} errored (${err.message}) but space ${key} exists - using it`,
      );
      created = { key };
    } else {
      throw err;
    }
  }

  // TODO(DEV): If SPP fails to save this key, the next push creates a second
  //   Jira project (no lookup fallback for parents). The SPP-side script must
  //   treat the write-back as required.
  return {
    sppId: p.id,
    type: "project",
    action: "created",
    jiraKey: created?.key ?? key,
    writeBack: !CFG.dryRun,
  };
}

// Finds the space created for an SPP parent project. Searches by name (and by
//   SPP ID, in case the name changed) and only accepts a space whose
//   description says "SPP Project ID: <id>", so a same-named space that
//   belongs to something else is never taken over.
async function findSpaceForSppProject(sppId, name) {
  const marker = `SPP Project ID: ${sppId}`;
  const descText = (d) => (typeof d === "string" ? d : JSON.stringify(d ?? "")); // plain text or ADF
  for (const query of [name, marker].filter(Boolean)) {
    const res = await jiraRequest(
      "GET",
      `/rest/api/3/project/search?query=${encodeURIComponent(query)}&expand=description&maxResults=50`,
    ).catch((err) => {
      console.warn(`Space lookup for SPP ${sppId} failed: ${err.message}`);
      return null;
    });
    const hit = (res?.values ?? []).find((pr) => {
      const d = descText(pr.description);
      const i = d.indexOf(marker);
      // Exact ID match: "SPP Project ID: 2899" must not match "...28990".
      return i >= 0 && !/\d/.test(d.charAt(i + marker.length));
    });
    if (hit) return hit.key;
  }
  return null;
}

function buildJiraProjectName(p) {
  // TODO(CLARIFY): Naming convention. Assumed "<Customer> - <Project name>".
  //   Jira project names max 80 chars.
  const base = p.customerName ? `${p.customerName} - ${p.name}` : p.name;
  return base.slice(0, 80);
}

const MAX_PROJECT_KEY_LENGTH = 6;

async function generateUniqueProjectKey(p, customer) {
  // TODO(CLARIFY): How should Jira project keys be formed? (Uppercase,
  //   starts with a letter, unique site-wide.) Assumed: derived from
  //   customer + project initials, with a numeric suffix if taken.
  // This Jira site rejects keys longer than 6 characters, so the whole key
  //   (initials + any suffix) is kept within MAX_PROJECT_KEY_LENGTH.
  const source = `${customer?.name ?? ""} ${p.name}`;
  let base = source
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  base = base.slice(0, MAX_PROJECT_KEY_LENGTH).padEnd(2, "X");

  for (let i = 0; i < 100; i++) {
    // Trim the initials to make room for the suffix: ACWRXY, ACWRX1, ACWR10...
    const suffix = i === 0 ? "" : String(i);
    const candidate = `${base.slice(0, MAX_PROJECT_KEY_LENGTH - suffix.length)}${suffix}`;
    const exists = await jiraRequest(
      "GET",
      `/rest/api/3/project/${candidate}`,
      null,
      { allow404: true },
    );
    if (!exists) return candidate;
  }
  throw new Error(`Could not generate unique Jira key for SPP project ${p.id}`);
}

// ---------------------------------------------------------------------------
// Board settings (copied from the template space's board)
// ---------------------------------------------------------------------------
// Template = the board in JIRA_BOARD_TEMPLATE_SPACE_KEY (e.g. GS1706).
// Public API:   filter (JQL + view/edit permissions) and the board itself.
// Internal API: quick filters, working days, board admins. These use
//   /rest/greenhopper/1.0, which the board settings page itself calls. It is
//   undocumented and can change without notice, so each internal step is
//   best-effort and reported in board.warnings rather than failing the run.
// TODO(DEV): Internal endpoints are only reachable on the site URL
//   (https://<site>.atlassian.net), not through api.atlassian.com with a
//   scoped token. Confirm JIRA_BASE_URL before relying on them.
// TODO(DEV): Verify each internal request below against the network call the
//   board settings page (or Dan's Chrome extension) makes for the same change:
//   DevTools → Network → make the change → compare URL, method and body.

const GH = "/rest/greenhopper/1.0";

// Scheme IDs used by the template space, passed to POST /project so the new
// space shares its configuration (same as "Create with shared configuration"
// in the UI). Public API. Returns null when sharing is off or no template.
let templateSchemesPromise = null;
function getTemplateSchemes() {
  if (!CFG.boardTemplateSpaceKey || !CFG.shareTemplateSchemes)
    return Promise.resolve(null);
  if (!templateSchemesPromise)
    templateSchemesPromise = loadTemplateSchemes(
      CFG.boardTemplateSpaceKey,
    ).catch((err) => {
      templateSchemesPromise = null;
      throw new Error(
        `Could not read ${CFG.boardTemplateSpaceKey}'s schemes: ${err.message}`,
      );
    });
  return templateSchemesPromise;
}

async function loadTemplateSchemes(spaceKey) {
  const project = await jiraRequest(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}`,
  );
  const id = project.id;
  const byProject = async (path, prop) => {
    const res = await jiraRequest(
      "GET",
      `/rest/api/3/${path}/project?projectId=${id}`,
    );
    return res?.values?.[0]?.[prop]?.id ?? null;
  };
  const [
    workflowScheme,
    issueTypeScheme,
    issueTypeScreenScheme,
    fieldConfigurationScheme,
    perm,
    notif,
  ] = await Promise.all([
    byProject("workflowscheme", "workflowScheme"),
    byProject("issuetypescheme", "issueTypeScheme"),
    byProject("issuetypescreenscheme", "issueTypeScreenScheme"),
    // null = the default field configuration scheme; nothing to send
    byProject("fieldconfigurationscheme", "fieldConfigurationScheme"),
    jiraRequest(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(spaceKey)}/permissionscheme`,
    ),
    jiraRequest(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(spaceKey)}/notificationscheme`,
    ),
  ]);
  const out = {
    workflowScheme,
    issueTypeScheme,
    issueTypeScreenScheme,
    fieldConfigurationScheme,
    permissionScheme: perm?.id ?? null,
    notificationScheme: notif?.id ?? null,
  };
  // Drop unknowns and send numbers, as POST /project expects.
  return Object.fromEntries(
    Object.entries(out)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, Number(v)]),
  );
}

// Loaded once per run (reset at the start of syncProjects).
let boardTemplatePromise = null;

function getBoardTemplate() {
  if (!boardTemplatePromise)
    boardTemplatePromise = loadBoardTemplate(CFG.boardTemplateSpaceKey).catch(
      (err) => {
        boardTemplatePromise = null;
        throw err;
      },
    );
  return boardTemplatePromise;
}

async function loadBoardTemplate(spaceKey) {
  if (!spaceKey)
    throw new Error("No template space (set JIRA_BOARD_TEMPLATE_SPACE_KEY)");

  const project = await jiraRequest(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}`,
    null,
    { allow404: true },
  );
  if (!project) throw new Error(`Template space ${spaceKey} not found`);

  const boards = await getSpaceBoards(project.key);
  if (boards.length === 0)
    throw new Error(`Template space ${spaceKey} has no board`);
  // TODO(CONFIG): Set JIRA_BOARD_TEMPLATE_BOARD_ID if the template space has
  //   more than one board.
  const board = CFG.boardTemplateBoardId
    ? boards.find((b) => String(b.id) === CFG.boardTemplateBoardId)
    : boards[0];
  if (!board)
    throw new Error(
      `Board ${CFG.boardTemplateBoardId} not found in template space ${spaceKey}`,
    );
  if (boards.length > 1 && !CFG.boardTemplateBoardId)
    console.warn(
      `Template space ${spaceKey} has ${boards.length} boards; using "${board.name}" (${board.id})`,
    );

  const config = await jiraRequest(
    "GET",
    `/rest/agile/1.0/board/${board.id}/configuration`,
  );
  const filter = await jiraRequest(
    "GET",
    `/rest/api/3/filter/${config.filter.id}`,
  );
  const quickFilters = await getQuickFilters(board.id);

  // Working days and board admins are only in the internal edit model.
  let editModel = null;
  try {
    editModel = await jiraRequest(
      "GET",
      `${GH}/rapidviewconfig/editmodel.json?rapidViewId=${board.id}`,
      null,
      { internal: true },
    );
  } catch (err) {
    console.warn(
      `Could not read template board edit model (internal API): ${err.message}`,
    );
  }

  return {
    space: { key: project.key, id: String(project.id), name: project.name },
    board: { id: board.id, name: board.name, type: board.type },
    filter: {
      id: filter.id,
      name: filter.name,
      jql: filter.jql,
      sharePermissions: filter.sharePermissions ?? [],
      editPermissions: filter.editPermissions ?? [],
    },
    quickFilters: quickFilters.map((q) => ({
      name: q.name,
      jql: q.jql,
      description: q.description ?? "",
    })),
    // Property names below come from the internal edit model (confirmed
    //   against GS1706 with jira_board_lookup.mjs on 2026-10-13).
    workingDays: pickWorkingDays(editModel?.workingDaysConfig),
    boardAdmins: editModel?.boardAdmins ?? null,
    columns: pickColumns(editModel?.rapidListConfig, config),
    swimlaneStrategy: editModel?.swimlanesConfig?.swimlaneStrategy ?? null,
    swimlanes: (editModel?.swimlanesConfig?.swimlanes ?? []).map((s) => ({
      name: s.name,
      query: s.query ?? "",
      isDefault: Boolean(s.isDefault),
    })),
    cardColorStrategy: editModel?.cardColorConfig?.cardColorStrategy ?? null,
    cardLayout: await readCardLayout(board.id),
    showDaysInColumn: editModel?.showDaysInColumn ?? null,
    oldDoneIssuesCutoff: editModel?.oldDoneIssuesCutoff ?? null,
    statisticsFieldId:
      editModel?.rapidListConfig?.currentStatisticsField?.id ?? "none_",
    subQuery: config?.subQuery?.query ?? null,
    editModel,
  };
}

// Extra fields shown on cards. Internal API. Modes: "workMode" = the board,
//   "planMode" = the backlog (Kanban boards only have it with the backlog on).
// URL pattern verified 2026-10-13 from the request that adds a field
//   (POST .../cardlayout/{board}/workMode/field). Reading uses GET on the same
//   URL. TODO(DEV): confirm the GET response shape (parsed defensively below).
const CARD_MODES = ["workMode", "planMode"];
async function readCardLayout(boardId) {
  const out = {};
  for (const mode of CARD_MODES) {
    try {
      const res = await jiraRequest(
        "GET",
        `${GH}/cardlayout/${boardId}/${mode}/field`,
        null,
        { internal: true },
      );
      const list = Array.isArray(res)
        ? res
        : (res?.fields ?? res?.cardLayoutFields ?? res?.values ?? []);
      out[mode] = list
        .map((f) => ({
          id: f.id,
          fieldId: f.fieldId ?? f.field?.id,
          name: f.name ?? f.fieldName ?? f.fieldId,
        }))
        .filter((f) => f.fieldId);
    } catch (err) {
      if (mode === "workMode") {
        console.warn(
          `Could not read card layout for board ${boardId}: ${err.message}`,
        );
        return null;
      }
      out[mode] = []; // no backlog mode on this board
    }
  }
  return out;
}

// Only the settings themselves. workingDaysConfig also carries the full time
// zone picker list (~3,000 lines), which must not be sent back.
function pickWorkingDays(wd) {
  if (!wd) return null;
  const days = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  return {
    weekDays: Object.fromEntries(
      days.map((d) => [d, Boolean(wd.weekDays?.[d])]),
    ),
    nonWorkingDays: wd.nonWorkingDays ?? [],
    timeZoneId: wd.timeZoneEditModel?.currentTimeZoneId ?? null,
  };
}

// Columns from the internal list config (has the Kanban "Backlog" flag),
// falling back to the public board configuration.
function pickColumns(listConfig, config) {
  const internal = listConfig?.mappedColumns;
  if (Array.isArray(internal) && internal.length)
    return internal.map((c) => ({
      name: c.name,
      statusIds: (c.mappedStatuses ?? []).map((s) => String(s.id)),
      isKanPlanColumn: Boolean(c.isKanPlanColumn),
      min: c.min ?? "",
      max: c.max ?? "",
    }));
  return (config?.columnConfig?.columns ?? []).map((c, i) => ({
    name: c.name,
    statusIds: (c.statuses ?? []).map((s) => String(s.id)),
    // Kanban boards with a backlog keep it as the first, status-less column.
    isKanPlanColumn: i === 0 && c.name === "Backlog",
    min: c.min ?? "",
    max: c.max ?? "",
  }));
}

// Read-only snapshot of a template board, for checking what will be copied.
async function dumpBoardTemplate(spaceKey) {
  const t = await loadBoardTemplate(spaceKey || CFG.boardTemplateSpaceKey);
  console.log("Board template", JSON.stringify(t, null, 2).slice(0, 20000));
  return t;
}

async function getSpaceBoards(spaceKey) {
  const out = [];
  for (let startAt = 0; ; ) {
    const page = await jiraRequest(
      "GET",
      `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(spaceKey)}&startAt=${startAt}&maxResults=50`,
    );
    const values = page?.values ?? [];
    out.push(...values);
    if (page?.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }
  // The board list also includes boards whose filter merely mentions the
  // space; keep only boards located in it.
  return out.filter(
    (b) => !b.location?.projectKey || b.location.projectKey === spaceKey,
  );
}

async function getQuickFilters(boardId) {
  const out = [];
  for (let startAt = 0; ; ) {
    const page = await jiraRequest(
      "GET",
      `/rest/agile/1.0/board/${boardId}/quickfilter?startAt=${startAt}&maxResults=50`,
    );
    const values = page?.values ?? [];
    out.push(...values);
    if (page?.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }
  return out.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

// Runs after a parent sync. Never throws: problems are returned in the
// result so the space and the SPP write-back still go through.
async function syncBoardSettings(spaceKey, { newSpace }) {
  if (!CFG.boardTemplateSpaceKey) {
    console.log(
      `[Board ${spaceKey}] Skipped: JIRA_BOARD_TEMPLATE_SPACE_KEY is not set`,
    );
    return undefined;
  }
  try {
    const result = await applyBoardSettings(spaceKey, { newSpace });
    console.log(
      `[Board ${spaceKey}] Done: status=${result.status} board=${result.boardId ?? "n/a"} ` +
        `filter=${result.filterId ?? "n/a"} warnings=${result.warnings.length}`,
    );
    return result;
  } catch (err) {
    console.error(`[Board ${spaceKey}] FAILED: ${err.message}`);
    return { status: "error", error: err.message };
  }
}

async function applyBoardSettings(spaceKey, { newSpace }) {
  const t = await getBoardTemplate();
  const warnings = [];

  const project = await jiraRequest(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}`,
    null,
    { allow404: true },
  );
  if (!project && !CFG.dryRun) throw new Error(`Space ${spaceKey} not found`);
  // In a dry run a "new" space was never created, so use its intended key.
  const target = project
    ? { key: project.key, id: String(project.id), name: project.name }
    : { key: spaceKey, id: null, name: spaceKey };

  // Board and filter are both named after the space, as on the GS1706 board.
  const boardName = target.name.slice(0, 255);
  const tag = `[Board ${target.key}] `;
  console.log(
    `${tag}Applying settings from ${t.space.key} board ${t.board.id} ` +
      `(${t.board.type}, ${t.columns.length} columns, ${t.quickFilters.length} quick filters, ` +
      `${(t.boardAdmins?.userKeys ?? []).length} admins)` +
      (newSpace ? " to new space" : " to existing space"),
  );

  const { jql: rewritten, changed } = rewriteJql(t.filter.jql, t.space, target);
  let jql = rewritten;
  if (!changed) {
    // A board filter not scoped to the space would show every issue.
    jql = `project = ${target.key} ORDER BY Rank ASC`;
    warnings.push(
      `Template filter JQL doesn't reference ${t.space.key} ("${t.filter.jql}"); used "${jql}"`,
    );
  }
  // Permissions are added separately after the filter exists (see
  //   shareFilter), so a sharing problem can't stop the board being created.
  const filterBody = { name: boardName, jql };
  const wantedShares = [
    ...t.filter.sharePermissions.map((p) =>
      toPermissionInput(p, t.space, target, VIEW),
    ),
    ...t.filter.editPermissions.map((p) =>
      toPermissionInput(p, t.space, target, EDIT),
    ),
  ].filter(Boolean);

  if (CFG.dryRun) {
    console.log(
      `[DRY RUN] Board settings ${t.space.key} → ${target.key}:`,
      JSON.stringify({
        board: { name: boardName, type: t.board.type },
        filter: { ...filterBody, shares: wantedShares },
        quickFilters: t.quickFilters.map((q) => q.name),
        columns: t.columns.map((c) => `${c.name} [${c.statusIds.join(",")}]`),
        workingDays: t.workingDays?.weekDays ?? null,
        boardAdmins: (t.boardAdmins?.userKeys ?? []).map(
          (u) => u.displayName ?? u.key ?? u,
        ),
      }),
    );
    return { status: "dry run", boardId: null, filterId: null, warnings };
  }

  // --- Filter + board (public API) ---------------------------------------
  const existingBoards = await getSpaceBoards(target.key);
  let board = existingBoards.find((b) => b.name === boardName);
  let filterId;

  if (board) {
    // Re-run: keep the board, bring its filter in line with the template.
    const cfg = await jiraRequest(
      "GET",
      `/rest/agile/1.0/board/${board.id}/configuration`,
    );
    filterId = cfg.filter.id;
    try {
      await jiraRequest("PUT", `/rest/api/3/filter/${filterId}`, filterBody);
    } catch (err) {
      // e.g. the filter is owned by someone else
      warnings.push(`Filter ${filterId} not updated: ${err.message}`);
    }
    console.log(
      `${tag}Board ${board.id} "${boardName}" already exists - reusing it (filter ${filterId}, JQL "${jql}")`,
    );
    await bestEffort(
      "Filter sharing",
      warnings,
      () => shareFilter(filterId, wantedShares),
      tag,
    );
  } else {
    const filter = await jiraRequest("POST", "/rest/api/3/filter", filterBody);
    filterId = filter.id;
    console.log(
      `${tag}Filter: OK - created ${filterId} "${boardName}", JQL "${jql}"`,
    );
    await bestEffort(
      "Filter sharing",
      warnings,
      () => shareFilter(filterId, wantedShares),
      tag,
    );
    board = await jiraRequest("POST", "/rest/agile/1.0/board", {
      name: boardName,
      type: t.board.type,
      filterId: Number(filterId),
      location: { type: "project", projectKeyOrId: target.key },
    });
    console.log(
      `${tag}Board: OK - created ${board.id} "${boardName}" (${t.board.type})`,
    );

    // The project template auto-creates a "<KEY> board". In a space this run
    // just created, remove it so the space has one board and one filter.
    // Existing spaces are never cleaned up automatically.
    for (const b of existingBoards) {
      if (newSpace && b.name === `${target.key} board`)
        await removeBoard(b, warnings);
      else
        warnings.push(`Space also has board ${b.id} "${b.name}" (left as is)`);
    }
  }

  // --- Internal API steps ------------------------------------------------
  await bestEffort(
    "Columns",
    warnings,
    () => copyColumns(t, target, board.id, warnings),
    tag,
  );
  await bestEffort(
    "Quick filters",
    warnings,
    () => copyQuickFilters(t, target, board.id, warnings),
    tag,
  );
  await bestEffort(
    "Working days",
    warnings,
    () => copyWorkingDays(t, board.id, warnings),
    tag,
  );
  await bestEffort(
    "Completed work items",
    warnings,
    () => copyOldDoneCutoff(t, board.id),
    tag,
  );
  await bestEffort(
    "Swimlanes",
    warnings,
    () => copySwimlaneStrategy(t, board.id),
    tag,
  );
  await bestEffort(
    "Card colors",
    warnings,
    () => copyCardColors(t, board.id),
    tag,
  );
  await bestEffort(
    "Card layout",
    warnings,
    () => copyCardLayout(t, board.id, warnings),
    tag,
  );
  await bestEffort(
    "Days in column",
    warnings,
    () => copyDaysInColumn(t, board.id),
    tag,
  );
  // Admins last: the integration account created the board and may not be
  //   on the template's admin list. As a Jira admin it can still edit later.
  await bestEffort(
    "Board admins",
    warnings,
    () => copyBoardAdmins(t, board.id),
    tag,
  );
  // Reads the finished board back and lists every setting that still differs.
  await bestEffort(
    "Verify",
    warnings,
    () => verifyBoard(t, target, board.id, warnings),
    tag,
  );
  for (const w of warnings) console.warn(`${tag}Warning: ${w}`);

  return {
    status: warnings.length ? "partial" : "ok",
    boardId: board.id,
    filterId: String(filterId),
    warnings,
  };
}

async function removeBoard(b, warnings) {
  try {
    const cfg = await jiraRequest(
      "GET",
      `/rest/agile/1.0/board/${b.id}/configuration`,
    );
    await jiraRequest("DELETE", `/rest/agile/1.0/board/${b.id}`);
    if (cfg?.filter?.id)
      await jiraRequest("DELETE", `/rest/api/3/filter/${cfg.filter.id}`);
    console.log(
      `[Board] Removed Jira's auto-created board ${b.id} "${b.name}" and its filter`,
    );
  } catch (err) {
    warnings.push(`Auto-created board ${b.id} not removed: ${err.message}`);
  }
}

async function copyQuickFilters(t, target, boardId, warnings) {
  const existing = await getQuickFilters(boardId);
  const have = new Set(existing.map((q) => q.name.trim().toLowerCase()));
  const want = new Set(t.quickFilters.map((q) => q.name.trim().toLowerCase()));

  // New boards come with Jira's default quick filters. Ones the template
  //   doesn't have are reported, not deleted.
  // TODO(DEV): Remove extras automatically once the internal delete call is
  //   confirmed (see the network tab when deleting a quick filter).
  const extras = existing.filter((q) => !want.has(q.name.trim().toLowerCase()));
  if (extras.length)
    warnings.push(
      `Quick filters not in template (left as is): ${extras.map((q) => q.name).join(", ")}`,
    );

  const added = [];
  const skipped = [];
  for (const q of t.quickFilters) {
    if (have.has(q.name.trim().toLowerCase())) {
      skipped.push(q.name);
      continue;
    }
    // Confirmed working in the 2026-10-13 test run (RIPP1V).
    await jiraRequest(
      "POST",
      `${GH}/quickfilters/${boardId}`,
      {
        name: q.name,
        query: rewriteJql(q.jql, t.space, target).jql,
        description: q.description,
      },
      { internal: true },
    );
    added.push(q.name);
  }
  return (
    `added ${added.length} (${added.join(", ") || "none"})` +
    (skipped.length ? `; already present: ${skipped.join(", ")}` : "")
  );
}

async function copyWorkingDays(t, boardId, warnings) {
  if (!t.workingDays)
    throw new Error("template working days unavailable (edit model not read)");
  // Weekday flags (GS1706: all 7 days on). Verified 2026-10-13 against the
  //   request the board settings page sends: flat day flags + rapidViewId.
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/workingdays/weekdays`,
    { ...t.workingDays.weekDays, rapidViewId: boardId },
    { internal: true },
  );
  const on = Object.entries(t.workingDays.weekDays)
    .filter(([, v]) => v)
    .map(([d]) => d.slice(0, 3));
  // New boards don't start on the system default zone (RIPP1 got Auckland),
  //   so the template's zone is always set.
  // Confirmed on 2026-10-13 against the board settings page.
  const timeZoneId = t.workingDays.timeZoneId ?? "defaultTimeZoneId";
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/workingdays/timezone`,
    { rapidViewId: boardId, timeZoneId },
    { internal: true },
  );
  if (t.workingDays.nonWorkingDays.length)
    warnings.push(
      `Working days: ${t.workingDays.nonWorkingDays.length} non-working date(s) not copied`,
    );
  return `${on.length} day(s): ${on.join(", ")}; time zone ${timeZoneId}`;
}

// Columns: same names and order as the template. Statuses that don't exist in
// the target space's workflow are dropped (GS1706 uses custom statuses
// 10634 and 10635, which only exist in spaces sharing its workflow).
async function copyColumns(t, target, boardId, warnings) {
  if (!t.columns.length) throw new Error("template columns unavailable");
  const statuses = await jiraRequest(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(target.key)}/statuses`,
  );
  const available = new Set(
    (statuses ?? []).flatMap((it) =>
      (it.statuses ?? []).map((s) => String(s.id)),
    ),
  );
  const dropped = [];
  const mappedColumns = t.columns.map((c) => {
    const keep = c.statusIds.filter((id) => available.has(id));
    dropped.push(
      ...c.statusIds
        .filter((id) => !available.has(id))
        .map((id) => `${id} (${c.name})`),
    );
    return {
      name: c.name,
      isKanPlanColumn: c.isKanPlanColumn,
      mappedStatuses: keep.map((id) => ({ id })),
      min: c.min,
      max: c.max,
    };
  });
  if (dropped.length)
    warnings.push(
      `Columns: status(es) not in ${target.key}'s workflow, left unmapped: ${dropped.join(", ")}`,
    );

  // Confirmed working in the 2026-10-13 test run (RIPP1V).
  //   network call made when saving board columns in the UI.
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/columns`,
    {
      rapidViewId: boardId,
      currentStatisticsField: { id: t.statisticsFieldId }, // "none_" = no constraint
      mappedColumns,
    },
    { internal: true },
  );
  return mappedColumns
    .map(
      (c) =>
        `${c.name} [${c.mappedStatuses.map((s) => s.id).join(",") || "-"}]`,
    )
    .join(" | ");
}

// Completed work items: how long done items stay on the board
//   (GS1706: "Never mind, show all"; new boards default to 2 weeks).
async function copyOldDoneCutoff(t, boardId) {
  if (t.oldDoneIssuesCutoff == null)
    throw new Error("template value unavailable (edit model not read)");
  // No error in the 2026-10-13 test run; the Verify step confirms the value.
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/oldDoneIssuesCutoff`,
    { rapidViewId: boardId, oldDoneIssuesCutoff: t.oldDoneIssuesCutoff },
    { internal: true },
  );
  return `"${t.oldDoneIssuesCutoff || "show all"}"`;
}

// Card colors: method only (GS1706: work type). Individual colors are left
//   at Jira's defaults for each work type (not required).
async function copyCardColors(t, boardId) {
  if (!t.cardColorStrategy)
    throw new Error("template method unavailable (edit model not read)");
  // Verified 2026-10-13 against the board settings page's request.
  await jiraRequest(
    "PUT",
    `${GH}/cardcolors/${boardId}/strategy`,
    { id: boardId, cardColorStrategyId: t.cardColorStrategy },
    { internal: true },
  );
  return `method ${t.cardColorStrategy}`;
}

// Swimlanes: method only (GS1706: Query, shown as "custom"). Choosing Query
//   makes Jira add its default lanes - "Expedite" (priority = Highest) and
//   "Everything Else" - which are what GS1706 has. Any difference shows up in
//   the Verify step. Verified 2026-10-13 against the board settings page.
async function copySwimlaneStrategy(t, boardId) {
  if (!t.swimlaneStrategy)
    throw new Error("template method unavailable (edit model not read)");
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/swimlaneStrategy`,
    { id: boardId, swimlaneStrategyId: t.swimlaneStrategy },
    { internal: true },
  );
  return (
    `method ${t.swimlaneStrategy}` +
    (t.swimlanes.length
      ? ` (template lanes: ${t.swimlanes.map((l) => l.name).join(", ")})`
      : "")
  );
}

// Card layout: extra fields on Kanban cards (GS1706: Due date).
async function copyCardLayout(t, boardId, warnings) {
  if (!t.cardLayout) throw new Error("template layout unavailable");
  const current = (await readCardLayout(boardId)) ?? {
    workMode: [],
    planMode: [],
  };
  const added = [];
  for (const mode of CARD_MODES) {
    const have = new Set(current[mode].map((f) => f.fieldId));
    for (const f of t.cardLayout[mode]) {
      if (have.has(f.fieldId)) continue;
      // Verified 2026-10-13 against the board settings page's request.
      await jiraRequest(
        "POST",
        `${GH}/cardlayout/${boardId}/${mode}/field`,
        { fieldId: f.fieldId },
        { internal: true },
      );
      added.push(`${f.name} (${mode === "workMode" ? "board" : "backlog"})`);
    }
    const extra = current[mode].filter(
      (f) => !t.cardLayout[mode].some((x) => x.fieldId === f.fieldId),
    );
    if (extra.length)
      warnings.push(
        `Card layout: ${mode} has fields not in template (left as is): ${extra.map((f) => f.name).join(", ")}`,
      );
  }
  return added.length ? `added ${added.join(", ")}` : "already matches";
}

// Days in column (GS1706: on).
async function copyDaysInColumn(t, boardId) {
  if (t.showDaysInColumn == null)
    throw new Error("template value unavailable (edit model not read)");
  // No error in the 2026-10-13 test run; the Verify step confirms the value.
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/showDaysInColumn`,
    { rapidViewId: boardId, showDaysInColumn: t.showDaysInColumn },
    { internal: true },
  );
  return t.showDaysInColumn ? "on" : "off";
}

// Reads the finished board back and compares it with the template. Every
// difference becomes a warning, so the log shows exactly what still doesn't
// match (and which internal calls need fixing).
async function verifyBoard(t, target, boardId, warnings) {
  const [model, cfg, quick, layout] = await Promise.all([
    jiraRequest(
      "GET",
      `${GH}/rapidviewconfig/editmodel.json?rapidViewId=${boardId}`,
      null,
      { internal: true },
    ),
    jiraRequest("GET", `/rest/agile/1.0/board/${boardId}/configuration`),
    getQuickFilters(boardId),
    readCardLayout(boardId),
  ]);
  const diffs = [];
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual ?? null);
    const e = JSON.stringify(expected ?? null);
    if (a !== e) diffs.push(`${label}: is ${a}, template ${e}`);
  };
  const keys = (list) => (list ?? []).map((x) => x?.key ?? x).sort();

  check(
    "Board admins",
    keys(model?.boardAdmins?.userKeys),
    keys(t.boardAdmins?.userKeys),
  );
  const wd = pickWorkingDays(model?.workingDaysConfig);
  check("Working days", wd?.weekDays, t.workingDays?.weekDays);
  check("Time zone", wd?.timeZoneId, t.workingDays?.timeZoneId);
  check(
    "Completed work items",
    model?.oldDoneIssuesCutoff,
    t.oldDoneIssuesCutoff,
  );
  check(
    "Column constraint",
    model?.rapidListConfig?.currentStatisticsField?.id ?? "none_",
    t.statisticsFieldId,
  );
  check(
    "Columns",
    pickColumns(model?.rapidListConfig, cfg).map(
      (c) => `${c.name}:${c.statusIds.join(",")}`,
    ),
    t.columns.map((c) => `${c.name}:${c.statusIds.join(",")}`),
  );
  check("Sub-filter", cfg?.subQuery?.query ?? null, t.subQuery);
  check(
    "Swimlane method",
    model?.swimlanesConfig?.swimlaneStrategy,
    t.swimlaneStrategy,
  );
  check(
    "Swimlanes",
    (model?.swimlanesConfig?.swimlanes ?? [])
      .map((s) => `${s.name}|${s.query ?? ""}`)
      .sort(),
    t.swimlanes.map((s) => `${s.name}|${s.query}`).sort(),
  );
  check(
    "Card color method",
    model?.cardColorConfig?.cardColorStrategy,
    t.cardColorStrategy,
  );
  check("Days in column", model?.showDaysInColumn, t.showDaysInColumn);
  if (t.cardLayout && layout)
    check(
      "Card layout (board)",
      layout.workMode.map((f) => f.fieldId),
      t.cardLayout.workMode.map((f) => f.fieldId),
    );
  check(
    "Quick filters",
    quick.map((q) => `${q.name}|${q.jql}`),
    t.quickFilters.map(
      (q) => `${q.name}|${rewriteJql(q.jql, t.space, target).jql}`,
    ),
  );

  for (const d of diffs) warnings.push(`Mismatch - ${d}`);
  return diffs.length
    ? `${diffs.length} difference(s) from template (see warnings)`
    : "board matches template";
}

async function copyBoardAdmins(t, boardId) {
  const a = t.boardAdmins;
  if (!a)
    throw new Error("template board admins unavailable (edit model not read)");
  const keys = (list) => (list ?? []).map((x) => x?.key ?? x).filter(Boolean);
  // URL and body confirmed 2026-10-13 (Jira accepted the request and only
  //   rejected it for the missing "Browse users and groups" permission).
  await jiraRequest(
    "PUT",
    `${GH}/rapidviewconfig/boardadmins`,
    {
      id: boardId,
      boardAdmins: { userKeys: keys(a.userKeys), groupKeys: keys(a.groupKeys) },
    },
    { internal: true },
  );
  const names = [...(a.userKeys ?? []), ...(a.groupKeys ?? [])].map(
    (x) => x?.displayName ?? x?.key ?? x,
  );
  return `${names.length}: ${names.join(", ")}`;
}

// Runs one board step. Logs "OK" with the step's summary, or the failure.
async function bestEffort(label, warnings, fn, tag = "") {
  try {
    const summary = await fn();
    console.log(`${tag}${label}: OK${summary ? ` - ${summary}` : ""}`);
  } catch (err) {
    const msg = `${label}: ${err.message.slice(0, 300)}`;
    warnings.push(msg);
    console.warn(`${tag}${label}: FAILED - ${err.message.slice(0, 300)}`);
  }
}

// Swaps references to the template space (key, quoted name, or id in a
// "project =" clause) for the target space. Issue keys like GS1706-12 are
// left alone. Returns { jql, changed }.
function rewriteJql(jql, from, to) {
  if (!jql) return { jql, changed: false };
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = jql;
  if (from.name)
    out = out.replace(new RegExp(`(["'])${esc(from.name)}\\1`, "gi"), to.key);
  out = out.replace(
    new RegExp(`(["']?)\\b${esc(from.key)}\\b(?!-\\d)\\1`, "gi"),
    to.key,
  );
  if (from.id)
    out = out.replace(
      new RegExp(
        `(\\bproject\\s*!?=\\s*)(["']?)${esc(from.id)}\\2(?!\\d)`,
        "gi",
      ),
      `$1${to.key}`,
    );
  return { jql: out, changed: out !== jql };
}

// Filter share rights for POST /filter/{id}/permission: 1 = view, 3 = view + edit.
const VIEW = 1;
const EDIT = 3;

// Converts a filter permission as returned by GET /filter into the flat body
// POST /rest/api/3/filter/{id}/permission accepts. GET and POST use different
// type names (GET "loggedin" = POST "authenticated", shown as "My
// organization" in the UI). A permission on the template space is moved to
// the target space.
function toPermissionInput(p, from, to, rights = VIEW) {
  if (!p?.type) return null;
  const projectId = (proj) =>
    proj?.id
      ? String(proj.id) === from.id && to.id
        ? to.id
        : String(proj.id)
      : undefined;
  switch (p.type) {
    case "loggedin":
    case "authenticated":
      return { type: "authenticated", rights };
    case "global":
      return { type: "global", rights };
    case "group":
      return p.group?.groupId
        ? { type: "group", groupId: p.group.groupId, rights }
        : { type: "group", groupname: p.group?.name, rights };
    case "project":
      return p.role?.id
        ? {
            type: "projectRole",
            projectId: projectId(p.project),
            projectRoleId: String(p.role.id),
            rights,
          }
        : { type: "project", projectId: projectId(p.project), rights };
    case "user":
      return p.user?.accountId
        ? { type: "user", accountId: p.user.accountId, rights }
        : null;
    default:
      return null; // e.g. "project-unknown": a space the account can't see
  }
}

// Adds the template's view/edit permissions to a filter one at a time, so a
// single failure doesn't block the others. Already-present ones are skipped.
async function shareFilter(filterId, wanted) {
  const sig = (x) =>
    [
      x.type,
      x.groupId ?? x.groupname ?? "",
      x.projectId ?? "",
      x.projectRoleId ?? "",
      x.accountId ?? "",
    ].join("|");
  const existing = new Set(
    (
      (await jiraRequest("GET", `/rest/api/3/filter/${filterId}/permission`)) ??
      []
    ).map((p) => sig(toPermissionInput(p, { id: null }, { id: null }) ?? {})),
  );
  const added = [];
  const failed = [];
  for (const w of wanted) {
    const label = `${w.type}${w.groupname || w.groupId ? ` ${w.groupname ?? w.groupId}` : ""} (${w.rights === EDIT ? "edit" : "view"})`;
    if (existing.has(sig(w))) continue;
    try {
      await jiraRequest("POST", `/rest/api/3/filter/${filterId}/permission`, w);
      added.push(label);
    } catch (err) {
      const noShare = /permission to share/i.test(err.message);
      if (noShare)
        // Every other share would fail the same way.
        throw new Error(
          `filter ${filterId} not shared: the Jira account lacks the global permission ` +
            `"Share dashboards and filters", so the filter (and board) stays private to that account` +
            (added.length
              ? ` (added before failing: ${added.join(", ")})`
              : ""),
        );
      failed.push(`${label}: ${err.message.slice(0, 200)}`);
    }
  }
  if (failed.length)
    throw new Error(
      `filter ${filterId} not shared with ${failed.join("; ")}` +
        (added.length ? ` (added: ${added.join(", ")})` : ""),
    );
  return added.length
    ? `added ${added.join(", ")}`
    : "already shared as template";
}

// ---------------------------------------------------------------------------
// Child project → Jira Epic
// ---------------------------------------------------------------------------
async function syncChildProject(c, parentKeyById, createdProjectKeys) {
  // Parent's space: from this run, from the payload, or - if the parent
  //   failed this run - from the child's saved Epic key ("JJRIP5-1" → JJRIP5).
  let jiraProjectKey =
    parentKeyById.get(c.parentId) ||
    c.parentJiraKey ||
    (c.jiraKey?.match(/^([A-Z][A-Z0-9_]+)-\d+$/i)?.[1] ?? null);
  // Parent not in this payload and no saved key: find the space created for
  //   the parent ("SPP Project ID: <parent id>" in its description).
  if (!jiraProjectKey && c.parentId) {
    jiraProjectKey = await findSpaceForSppProject(c.parentId, null);
    if (jiraProjectKey) {
      console.log(
        `[Epic SPP ${c.id}] Parent ${c.parentId} not in payload - found its space ${jiraProjectKey}`,
      );
      parentKeyById.set(c.parentId, jiraProjectKey); // reuse for siblings
    }
  }
  if (!jiraProjectKey) {
    // TODO(CLARIFY): Child pushed before its parent has a Jira project.
    //   Create the parent on the fly, or wait? Currently skipped.
    return {
      sppId: c.id,
      type: "epic",
      action: "skipped",
      jiraKey: null,
      writeBack: false,
      reason: `Parent ${c.parentId} has no Jira project yet (send parentJiraKey or include the parent)`,
    };
  }

  const { pmAccountId, adAccountId } = c;

  // Child names are written back to SPP as "<Epic key> <name>" (e.g.
  // "RG1719-2 Advisor Recruitment"). Strip that prefix before using the name
  // in Jira, so a re-pushed child never becomes "RG1719-2 RG1719-2 ...".
  const baseName = stripEpicKeyPrefix(c.name, jiraProjectKey, c.jiraKey);

  // The description is left to the team (it used to hold SPP ID / customer;
  //   those now have their own fields, and re-syncs no longer overwrite it).
  const fields = { summary: baseName.slice(0, 255) };
  // Custom fields must be on the Epic edit screen (they are, on the
  //   "Touchpoint Details" tab of GS1706's screen scheme).
  // Only set when SPP sends an ID, so a missing value never clears a person
  //   someone picked by hand in Jira.
  if (CFG.cf.projectManager && pmAccountId)
    fields[CFG.cf.projectManager] = { accountId: pmAccountId };
  if (CFG.cf.accountDirector && adAccountId)
    fields[CFG.cf.accountDirector] = { accountId: adAccountId };
  // Assignee = the Account Director, same as Account Manager (client: every
  //   Epic is assigned to the project's AD, no variation). Set separately via
  //   the assign endpoint (assignEpic), which doesn't depend on the edit screen.
  // Only sent when SPP has a value, so a missing value never clears Jira.
  if (CFG.cf.budget && c.budget != null) fields[CFG.cf.budget] = c.budget;
  if (CFG.cf.customer && c.customerName)
    fields[CFG.cf.customer] = c.customerName;
  if (CFG.cf.sppId) fields[CFG.cf.sppId] = c.id;
  // Dates are only sent when SPP has one, so an empty SPP date never clears
  //   a date set in Jira.
  if (CFG.cf.startDate && c.startDate) fields[CFG.cf.startDate] = c.startDate;
  if (c.dueDate) fields[CFG.cf.dueDate] = c.dueDate;

  // What this child sends to Jira - check here first when a field is missing.
  console.log(
    `[Epic SPP ${c.id}] fields: ` +
      JSON.stringify({
        summary: fields.summary,
        "DSS (PM)": pmAccountId ?? "none sent",
        "Account Manager (AD)": adAccountId ?? "none sent",
        Assignee: adAccountId ?? "none sent",
        "Client Name": c.customerName ?? "none sent",
        "SPP Project ID": c.id,
        "Start Date": c.startDate ?? "none sent",
        "Due date": c.dueDate ?? "none sent",
      }),
  );

  // Look up by SPP ID only if SPP didn't send a key and the Jira project
  // existed before this run (a project created just now has no Epics).
  // A child already written back is named "<Epic key> <name>", so the key
  // can be read from the name when SPP doesn't send jiraKey.
  const keyInName = c.name
    .trim()
    .match(new RegExp(`^(${jiraProjectKey}-\\d+)\\s+`))?.[1];
  // A saved key is only trusted if it belongs to this space (Epics don't
  //   move between spaces); otherwise fall back to the name / SPP ID lookup.
  const savedKey =
    c.jiraKey && c.jiraKey.toUpperCase().startsWith(`${jiraProjectKey}-`)
      ? c.jiraKey
      : null;
  if (c.jiraKey && !savedKey)
    console.warn(
      `[Epic SPP ${c.id}] Ignoring saved key ${c.jiraKey}: not in space ${jiraProjectKey}`,
    );
  let existingKey = savedKey || keyInName || null;
  let foundByLookup = false;
  if (!existingKey && !createdProjectKeys.has(jiraProjectKey)) {
    existingKey = await jiraFindEpicBySppId(jiraProjectKey, c.id);
    foundByLookup = Boolean(existingKey);
  }

  if (existingKey) {
    // TODO(CLARIFY): Child moved to a different parent in SPP - move the
    //   Epic? Not handled (REST edit can't move issues across projects).
    const { dropped } = await updateEpicFields(existingKey, fields);
    const assignProblem = await assignEpic(existingKey, adAccountId);
    if (assignProblem) dropped.push(assignProblem);
    const sppName = `${existingKey} ${baseName}`;
    return {
      sppId: c.id,
      type: "epic",
      action: "updated",
      jiraKey: existingKey,
      sppName,
      sppProjectCode: projectCodeFor(c, existingKey),
      // Save if the name lacks the current prefix, or SPP's key field is stale.
      writeBack:
        (c.name !== sppName ||
          foundByLookup ||
          (Boolean(CFG.sppEpicKeyField) &&
            c.projectCode !== projectCodeFor(c, existingKey)) ||
          (Boolean(CFG.sppJiraKeyField) && c.jiraKey !== existingKey)) &&
        !CFG.dryRun,
      ...(dropped.length && {
        warning: `Fields not set: ${dropped.join("; ")}`,
      }),
    };
  }

  const issuetype = await getEpicIssueType(jiraProjectKey);
  // Create with the summary only, then set the custom fields with an edit.
  //   Custom fields are often on the edit screen but not the create screen,
  //   which would make Jira reject the whole create.
  const { summary, ...customFields } = fields;
  // Create-only: the SPP project's name (without the Epic key prefix that the
  //   write-back adds), so the Epic keeps a record of what it was made from.
  if (CFG.cf.sppProjectName)
    customFields[CFG.cf.sppProjectName] = baseName.slice(0, 255);
  const created = await jiraRequest("POST", "/rest/api/3/issue", {
    fields: { project: { key: jiraProjectKey }, issuetype, summary },
  });

  const epicKey = created?.key ?? null;
  let fieldWarning;
  if (epicKey && Object.keys(customFields).length) {
    try {
      const { dropped } = await updateEpicFields(epicKey, customFields);
      const assignProblem = await assignEpic(epicKey, adAccountId);
      if (assignProblem) dropped.push(assignProblem);
      if (dropped.length)
        fieldWarning = `Epic ${epicKey} created; fields not set: ${dropped.join("; ")}`;
    } catch (err) {
      // The Epic exists, so keep going (its key still goes back to SPP); a
      //   re-sync sets the fields once the problem is fixed.
      fieldWarning = `Epic ${epicKey} created but fields not set: ${err.message.slice(0, 300)}`;
      console.warn(fieldWarning);
    }
  }
  return {
    sppId: c.id,
    type: "epic",
    action: "created",
    jiraKey: epicKey,
    sppName: epicKey ? `${epicKey} ${baseName}` : null,
    sppProjectCode: epicKey ? projectCodeFor(c, epicKey) : null,
    writeBack: !CFG.dryRun,
    ...(fieldWarning && { warning: fieldWarning }),
  };
}

// Assigns an Epic to the Account Director with Jira's assign endpoint. Unlike
//   setting "assignee" in a field update, this doesn't need Assignee on the
//   edit screen; it needs the "Assign work items" permission for the token's
//   account, and the AD must be assignable in the space. Never throws: returns
//   a problem string (shown as a warning) or null.
async function assignEpic(issueKey, requestedId) {
  if (!issueKey || !requestedId) return null;
  // Only allowlisted people are ever assigned; anyone else gets the default.
  const accountId = CFG.assigneeAllowlist.includes(requestedId)
    ? requestedId
    : CFG.assigneeDefault;
  if (accountId !== requestedId)
    console.log(
      `[Epic ${issueKey}] Assignee ${requestedId} not allowed - assigning ${accountId} instead`,
    );
  try {
    await jiraRequest(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`,
      { accountId },
    );
    return null;
  } catch (err) {
    const problem = `assignee: ${err.message.slice(0, 300)}`;
    console.warn(
      `[Epic ${issueKey}] Could not assign to ${accountId}: ${err.message.slice(0, 300)}`,
    );
    return problem;
  }
}

// Updates an Epic's fields. If Jira rejects specific fields (400 with
//   per-field errors, e.g. "duedate cannot be set" when the account lacks the
//   Schedule work items permission or the field isn't on the edit screen),
//   retries once without just those fields, so one bad field doesn't block
//   the rest. Returns { dropped: ["field: reason", ...] }.
async function updateEpicFields(issueKey, fields) {
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  try {
    await jiraRequest("PUT", path, { fields });
    return { dropped: [] };
  } catch (err) {
    if (err.status !== 400) throw err;
    let fieldErrors = {};
    try {
      fieldErrors = JSON.parse(err.body)?.errors ?? {};
    } catch {
      /* not JSON - rethrow below */
    }
    const bad = Object.keys(fieldErrors).filter((k) => k in fields);
    if (!bad.length) throw err;

    const rest = Object.fromEntries(
      Object.entries(fields).filter(([k]) => !bad.includes(k)),
    );
    const dropped = bad.map((k) => `${k}: ${fieldErrors[k]}`);
    console.warn(
      `[Epic ${issueKey}] Jira rejected ${dropped.join("; ")} - retrying without ${bad.length === 1 ? "it" : "them"}`,
    );
    if (Object.keys(rest).length)
      await jiraRequest("PUT", path, { fields: rest });
    return { dropped };
  }
}

// Removes a leading "<KEY>-<n> " Epic key prefix added by a previous write-back.
// Only keys from this space (or the child's own saved key) are stripped, so
// ordinary names are never altered.
function stripEpicKeyPrefix(name, spaceKey, epicKey) {
  let out = String(name).trim();
  const patterns = [new RegExp(`^${spaceKey}-\\d+\\s+`)];
  if (epicKey)
    patterns.push(new RegExp(`^${epicKey.replace(/[^A-Z0-9-]/gi, "")}\\s+`));
  for (const re of patterns) out = out.replace(re, "");
  return out || String(name).trim();
}

// Finds the space's Epic work type (by name, or by Epic hierarchy level).
// Throws a clear error listing the available types if the space has none.
const epicTypeCache = new Map(); // projectKey -> { id } | { name }
async function getEpicIssueType(projectKey) {
  if (epicTypeCache.has(projectKey)) return epicTypeCache.get(projectKey);
  const project = await jiraRequest(
    "GET",
    `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    null,
    { allow404: true },
  );
  if (!project) {
    // Dry run: the space wasn't really created. Fall back to the name.
    if (CFG.dryRun) return { name: "Epic" };
    throw new Error(`Jira space ${projectKey} not found`);
  }
  const types = project.issueTypes ?? [];
  const epic =
    types.find((t) => t.name?.toLowerCase() === "epic") ??
    types.find((t) => t.hierarchyLevel === 1);
  if (!epic) {
    // TODO(CONFIG): The space's work type scheme must include Epic. Use a
    //   company-managed scrum/kanban template (JIRA_PROJECT_TEMPLATE_KEY) or
    //   a work type scheme that includes Epic.
    throw new Error(
      `Space ${projectKey} has no Epic work type. Available: ` +
        (types.map((t) => t.name).join(", ") || "none"),
    );
  }
  const val = { id: String(epic.id) };
  epicTypeCache.set(projectKey, val);
  return val;
}

async function jiraFindEpicBySppId(projectKey, sppId) {
  // Safety net in case SPP didn't save the key from a previous run.
  if (!CFG.cf.sppId) return null;
  const cfNum = CFG.cf.sppId.replace("customfield_", "");
  const jql = `project = "${projectKey}" AND issuetype = Epic AND cf[${cfNum}] ~ "${sppId}"`;
  const res = await jiraRequest(
    "GET",
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=2`,
    null,
    { readOnly: true },
  );
  const issues = res?.issues ?? [];
  if (issues.length > 1)
    console.warn(
      `Multiple Epics found for SPP ${sppId}; using ${issues[0].key}`,
    );
  return issues[0]?.key ?? null;
}

// ---------------------------------------------------------------------------
// Jira REST API
// ---------------------------------------------------------------------------
// internal: true → /rest/greenhopper call; sends the XSRF opt-out header the
//   board settings page sends.
async function jiraRequest(
  method,
  path,
  body,
  { allow404 = false, readOnly = false, internal = false } = {},
) {
  const isWrite = method !== "GET" && !readOnly;
  if (CFG.dryRun && isWrite) {
    console.log(
      `[DRY RUN] Jira ${method} ${path}`,
      body ? JSON.stringify(body) : "",
    );
    return null;
  }

  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const resp = await fetch(`${CFG.jiraBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: jiraAuthHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(internal && { "X-Atlassian-Token": "no-check" }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 404 && allow404) return null;
    if (resp.status === 401)
      throw new Error(
        `Jira 401 Unauthorized on ${method} ${path}. Check JIRA_EMAIL / JIRA_API_TOKEN ` +
          `(token expired or revoked?) and JIRA_BASE_URL (scoped tokens need api.atlassian.com).`,
      );
    // 429 = not processed, always safe to retry. A 5xx on a write may have
    // partly succeeded (e.g. the space was created), so writes are not
    // retried on 5xx - the caller decides how to recover.
    const retryable =
      resp.status === 429 || (resp.status >= 500 && method === "GET");
    if (retryable) {
      const errText = await resp.text().catch(() => "");
      last = `${resp.status}: ${errText.slice(0, 500)}`;
      const wait =
        Number(resp.headers.get("Retry-After")) * 1000 || 1000 * 2 ** attempt;
      console.warn(`Jira ${last} on ${method} ${path}, retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(
        `Jira ${method} ${path} → ${resp.status}: ${text.slice(0, 800)}`,
      );
      err.status = resp.status; // used by updateEpicFields to retry without bad fields
      err.body = text;
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text; // some internal endpoints answer with plain text
    }
  }
  throw new Error(`Jira ${method} ${path} failed after retries (last ${last})`);
}

function adfText(text) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
function loadCredentials() {
  if (jiraAuthHeader) return;
  const missing = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].filter(
    (k) => !process.env[k],
  );
  if (missing.length)
    throw new Error(`Missing env var(s): ${missing.join(", ")}`);
  // TODO(CONFIG): The token's account needs "Administer Jira" (global) to
  //   create projects, plus browse/create/edit in the new projects. For board
  //   settings it also needs Browse on the template space and permission to
  //   create shared filters ("Share dashboards and filters" global permission).
  jiraAuthHeader = `Basic ${Buffer.from(`${CFG.jiraEmail}:${CFG.jiraApiToken}`).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers (Function URL / API Gateway)
// ---------------------------------------------------------------------------
function isHttpEvent(event) {
  return Boolean(event?.requestContext) || typeof event?.body === "string";
}

function headerValue(headers = {}, name) {
  const hit = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return hit ? headers[hit] : undefined;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errorResult(sppId, type, err) {
  console.error(`Failed ${type ?? "project"} SPP ${sppId}: ${err.message}`);
  return {
    sppId: sppId === undefined ? null : String(sppId),
    type,
    action: "error",
    jiraKey: null,
    writeBack: false,
    error: err.message,
  };
}

// Exposed for unit tests only (see test/generateUniqueProjectKey.test.mjs).
export const _test = {
  generateUniqueProjectKey,
  rewriteJql,
  toPermissionInput,
};
