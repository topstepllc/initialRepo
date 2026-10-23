/*******************************************************
 * move_time_lambda.js
 *
 * Ports the movement logic from SPP's move_time.js SuiteScript into a
 * Lambda that writes via the XML/wsapi-backed tslib-getRecords /
 * tslib-putRecords shared utilities (the REST API does not support
 * writes to these SPP objects).
 *
 * IN SCOPE:  moving time entries between project/task (full + partial
 *            moves), matching the original script's branching logic.
 *
 * OUT OF SCOPE (explicitly deferred, per instructions):
 *   - calculated_cost__c recompute (loaded cost * multiplier)
 *   - email notifications on error
 *   - source-file / attachment lifecycle (workspace move, delete) --
 *     N/A here since the browser tool replaces the file-drop workflow
 *
 * DIFFERENCES FROM move_time.js (intentional):
 *   - Partial moves create the new entry BEFORE shrinking the original, so
 *     a failure can never make hours disappear (see processMovement).
 *   - Full moves also set customerid from the target project, so an entry
 *     moved to another customer's project doesn't keep the old customer.
 *   - Remaining hours are rounded to 2 decimals (avoids 5.8999999...).
 *   - If phaseTarget is sent, the target task must sit directly under that
 *     phase ("0" = directly on the project).
 *
 * DRY_RUN: currently false -- writes are LIVE. Set to true to log every
 * writeObj that WOULD be sent to tslib-putRecords without calling it. All
 * reads (fetchOne / tslib-getRecords) still run either way, so validation
 * errors (bad target task, etc.) still surface in dry-run mode.
 *
 * Audit log: after processing, a CSV of the batch (one row per movement
 * attempted, including failures) is written as a new Attachment to the SPP
 * workspace set in writeLogToWorkspace. Skipped while DRY_RUN.
 *
 * ---------------------------------------------------------------------
 * Expected request body (POST), built by submitTimeMovements() /
 * buildMovementPayload() in the front end:
 *
 * {
 *   "movements": [
 *     {
 *       "teId": "10482",        // original time entry (Task) id -- required
 *       "tsId": "998",          // timesheet id -- required for a partial move's new entry
 *       "userId": "251",        // required for a partial move's new entry
 *       "date": "8/25/2025",    // M/D/YYYY as exported by SPP -- required for a partial move's new entry
 *       "notes": "",            // optional, carried onto a partial move's new entry
 *       "hours": "8",           // original entry's total hours (hoursRefHeader) -- required
 *       "projTarget": "5521",   // destination project id -- required
 *       "phaseTarget": "7710",  // destination phase id, "0" = no phase -- optional; validated if sent
 *       "taskTarget": "88231",  // destination project task id -- required
 *       "timeToMove": "3"       // hours being moved -- required
 *     }
 *   ]
 * }
 *
 * Response body:
 * {
 *   "results": [
 *     { "teId": "10482", "status": "partial", "updatedId": "10482", "createdId": "10499" },
 *     { "teId": "10483", "status": "full", "updatedId": "10483" },
 *     { "teId": "10484", "status": "error", "message": "..." }
 *   ],
 *   "logFile": { "status": "ok", "id": "...", "name": "move-time-log-....csv" }
 *              // or { "status": "skipped", "reason": "..." } / { "status": "error", "message": "..." }
 * }
 * ---------------------------------------------------------------------
 ******************************************************/

const DRY_RUN = false; // live writes; set to true to log writes without making them

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your hosting origin once deployed
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

export const handler = async (event) => {
  if (event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const authObj = {
    company: process.env.COMPANY,
    user: process.env.USER,
    password: process.env.PASSWORD,
    instance: process.env.INSTANCE,
  };
  const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
    ? "/opt/nodejs/sharedUtils.js"
    : "../../shared/sharedUtils.js";
  const { callSharedUtil } = await import(sharedPath);

  let movements;
  try {
    const body = JSON.parse(event.body || "{}");
    movements = Array.isArray(body.movements) ? body.movements : null;
  } catch (err) {
    return jsonResponse(400, { message: `Invalid JSON body: ${err.message}` });
  }

  if (!movements || !movements.length) {
    return jsonResponse(400, { message: "Request body must include a non-empty 'movements' array." });
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN is ON -- no tslib-putRecords calls will actually be made. Processing ${movements.length} movement(s).`);
  }

  const results = [];
  for (const movement of movements) {
    try {
      const outcome = await processMovement(movement, authObj, callSharedUtil);
      results.push({ teId: movement.teId, status: outcome.type, ...outcome });
    } catch (err) {
      results.push({
        teId: movement.teId,
        status: "error",
        message: err.message,
        ...(err.createdId ? { createdId: err.createdId } : {}),
      });
    }
  }

  console.log(`DRY_RUN=${DRY_RUN}; about to write audit log (if configured)`);
  const logFile = DRY_RUN
    ? { status: "skipped", reason: "DRY_RUN" }
    : await writeLogToWorkspace(callSharedUtil, authObj, movements, results);
  console.log(`logFile result: ${JSON.stringify(logFile)}`);

  return jsonResponse(200, { results, logFile });
};

/*******************************************************
 * Core per-line movement logic, ported from move_time.js's main() loop
 * (the part that actually moves time -- CSV parsing, error emailing, and
 * attachment/workspace handling are all intentionally left out).
 ******************************************************/
async function processMovement(movement, authObj, callSharedUtil) {
  const { teId, tsId, userId, date, notes, projTarget, taskTarget } = movement;
  const phaseTarget = String(movement.phaseTarget ?? "").trim();

  console.log(`--- Processing movement for teId ${teId} --- input: ${JSON.stringify(movement)}`);

  if (!teId) throw new Error("teId is required");

  const projTargetNum = Number(projTarget);
  const taskTargetNum = Number(taskTarget);
  if (!Number.isInteger(projTargetNum) || projTargetNum <= 0) {
    throw new Error(`invalid target project id: ${projTarget}`);
  }
  if (!Number.isInteger(taskTargetNum) || taskTargetNum <= 0) {
    throw new Error(`invalid target task id: ${taskTarget}`);
  }
  if (phaseTarget !== "" && !(Number.isInteger(Number(phaseTarget)) && Number(phaseTarget) >= 0)) {
    throw new Error(`invalid target phase id: ${phaseTarget}`);
  }

  const hoursRaw = parseFloat(movement.hours);
  const timeToMoveRaw = parseFloat(movement.timeToMove);
  if (isNaN(hoursRaw) || hoursRaw <= 0) throw new Error(`invalid original hours: ${movement.hours}`);
  if (isNaN(timeToMoveRaw) || timeToMoveRaw <= 0) throw new Error(`invalid time to move: ${movement.timeToMove}`);
  const hours = round2(hoursRaw);
  const timeToMove = round2(timeToMoveRaw);

  // Confirms the target task actually belongs to the target project --
  // equivalent of move_time.js's getTask(taskTarget, projTarget).
  console.log(`Fetching target task for task ID ${taskTargetNum} in project ID ${projTargetNum}`);

  const targetTask = await fetchOne(callSharedUtil, authObj, "Projecttask", {
    id: taskTargetNum,
    projectid: projTargetNum,
  });
  if (!targetTask) {
    throw new Error(`target task ${taskTargetNum} does not belong to target project ${projTargetNum}`);
  }
  console.log(`Target task fetched successfully: ${JSON.stringify(targetTask)}`);

  // Phase check: the task's parentid is the phase it sits directly under
  // (0 = directly on the project). Only enforced when the front end sent a
  // phase and the read actually returned parentid.
  if (phaseTarget !== "" && targetTask.parentid !== undefined) {
    const actualPhase = String(Number(targetTask.parentid || 0));
    if (actualPhase !== String(Number(phaseTarget))) {
      const where = actualPhase === "0" ? "directly on the project (no phase)" : `under phase ${actualPhase}`;
      throw new Error(`target task ${taskTargetNum} is ${where}, not under the selected phase ${phaseTarget}`);
    }
  }

  const timeDiff = round2(hours - timeToMove);
  if (timeDiff < 0) {
    throw new Error(`time to move (${timeToMove}) exceeds original entry's ${hours} hrs`);
  }

  // Needed on both paths: customerid for the partial move's new entry, and
  // for re-pointing the customer on a full move.
  const targetProject = await fetchOne(callSharedUtil, authObj, "Project", { id: projTargetNum });
  if (!targetProject) throw new Error(`target project ${projTargetNum} not found`);
  console.log(`Target project fetched successfully: ${JSON.stringify(targetProject)}`);

  if (timeDiff > 0) {
    // --- Partial move: create a new entry for the moved portion, then shrink
    //     the original -- mirrors move_time.js's partialMoveAdd / partialMoveUpd.

    // move_time.js reads `teRec.timetypeid` off a bare `new NSOA.record.oaTask(teId)`
    // without an explicit wsapi.read -- that only works via SuiteScript's lazy-load
    // proxy objects. We fetch it explicitly here.
    const originalEntry = await fetchOne(callSharedUtil, authObj, "Task", { id: teId });
    if (!originalEntry) throw new Error(`original time entry ${teId} not found`);
    console.log(`Original entry fetched successfully: ${JSON.stringify(originalEntry)}`);

    const createWriteObj = {
      projectid: projTargetNum,
      projecttaskid: taskTargetNum,
      decimal_hours: timeToMove,
      userid: userId,
      date: normalizeDateForSpp(date),
      customerid: targetProject.customerid,
      notes: notes || "",
      timesheetid: tsId,
      timetypeid: originalEntry.timetypeid,
    };
    console.log(`[CREATE new entry] Task writeObj: ${JSON.stringify(createWriteObj)}`);

    const updateWriteObj = {
      id: teId,
      decimal_hours: timeDiff,
    };
    console.log(`[UPDATE original entry] Task writeObj: ${JSON.stringify(updateWriteObj)}`);

    let createdEntry = null;
    let updatedOriginal = null;

    if (!DRY_RUN) {
      // Create first: if it fails, nothing has changed. If the follow-up
      // update fails, the moved hours exist twice (never zero times), and the
      // error names both ids so it can be corrected by hand.
      createdEntry = await callSharedUtil("tslib-putRecords", {
        authObj,
        recordType: "Task",
        writeObj: createWriteObj,
      });
      console.log(`Create result: ${JSON.stringify(createdEntry)}`);

      try {
        updatedOriginal = await callSharedUtil("tslib-putRecords", {
          authObj,
          recordType: "Task",
          writeObj: updateWriteObj,
        });
        console.log(`Update result: ${JSON.stringify(updatedOriginal)}`);
      } catch (err) {
        const createdId = createdEntry?.id ?? null;
        const e = new Error(
          `created new entry ${createdId ?? "(id unknown)"} with ${timeToMove} hrs, but failed to reduce ` +
          `original entry ${teId} to ${timeDiff} hrs -- those hours are currently counted twice. ` +
          `Fix entry ${teId} in SuiteProjects Pro before retrying this row. Cause: ${err.message}`
        );
        e.createdId = createdId;
        throw e;
      }
    }

    return {
      type: "partial",
      updatedId: updatedOriginal?.id ?? teId,
      createdId: createdEntry?.id ?? null,
      dryRun: DRY_RUN,
    };
  }

  // --- Full move: the whole entry moves onto the new project/task in place --
  //     mirrors move_time.js's fullMove branch, plus the customer update.
  const fullMoveWriteObj = {
    id: teId,
    projectid: projTargetNum,
    projecttaskid: taskTargetNum,
    customerid: targetProject.customerid,
  };
  console.log(`[FULL MOVE] Task writeObj: ${JSON.stringify(fullMoveWriteObj)}`);

  let updated = null;

  if (!DRY_RUN) {
    updated = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Task",
      writeObj: fullMoveWriteObj,
    });
    console.log(`Full move result: ${JSON.stringify(updated)}`);
  }

  return { type: "full", updatedId: updated?.id ?? teId, dryRun: DRY_RUN };
}

// Thin wrapper around tslib-getRecords for the common "fetch exactly one
// record matching this criteria" case (mirrors move_time.js's getProject/
// getTask helpers, which both used a limit of 1).
async function fetchOne(callSharedUtil, authObj, recordType, criteriaObj) {
  const records = await callSharedUtil("tslib-getRecords", {
    authObj,
    recordType,
    criteriaObj,
    limit: 1,
  });
  return records && records.length ? records[0] : null;
}

// Ported directly from move_time.js: SPP's exports hand back dates as
// "M/D/YYYY" (no zero-padding, e.g. "8/25/2025"), but the original script
// never wrote that straight through -- it rebuilds it as zero-padded
// "YYYY/MM/DD" first. Only matters for a partial move's newly-created
// entry (full moves never touch the date field at all).
function normalizeDateForSpp(dateStr) {
  if (!dateStr) return dateStr;
  const parts = String(dateStr).trim().split("/");
  if (parts.length !== 3) return dateStr; // not the expected M/D/YYYY shape -- pass through as-is
  let [month, day, year] = parts;
  if (day.length === 1) day = "0" + day;
  if (month.length === 1) month = "0" + month;
  return `${year}/${month}/${day}`;
}

/*******************************************************
 * Post-batch audit log: writes one CSV, one row per movement attempted
 * (including failures), as a new Attachment record in an SPP workspace.
 *
 * This is best-effort: a failure here is reported in the response's
 * `logFile` field but never overwrites/blocks the actual `results`.
 *
 * Every stage logs explicitly (resolved workspace id, CSV built, about to
 * call tslib-putRecords, result) specifically so a partial/no-op run is
 * diagnosable -- e.g. a Lambda timeout cutting execution off partway
 * through will now show exactly how far it got before disappearing.
 ******************************************************/
function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildResultsCsv(movements, results) {
  const resultsByTeId = new Map(results.map(r => [String(r.teId), r]));
  const header = [
    "teId", "status", "projTarget", "phaseTarget", "taskTarget", "hours", "timeToMove",
    "updatedId", "createdId", "message", "timestamp",
  ];
  const timestamp = new Date().toISOString();

  const rows = movements.map(m => {
    const r = resultsByTeId.get(String(m.teId)) || {};
    return [
      m.teId, r.status || "", m.projTarget, m.phaseTarget ?? "", m.taskTarget, m.hours, m.timeToMove,
      r.updatedId ?? "", r.createdId ?? "", r.message || "", timestamp,
    ].map(csvEscape).join(",");
  });

  return [header.join(","), ...rows].join("\r\n");
}

async function writeLogToWorkspace(callSharedUtil, authObj, movements, results) {
  const workspaceId = Number(6 || 0);
  console.log(`writeLogToWorkspace: resolved workspaceId=${workspaceId}`);
  if (!workspaceId) {
    console.log("writeLogToWorkspace: skipped -- SPP_LOG_WORKSPACE_ID env var is not set");
    return { status: "skipped", reason: "SPP_LOG_WORKSPACE_ID env var is not set" };
  }

  try {
    const csv = buildResultsCsv(movements, results);
    const base64Data = Buffer.from(csv, "utf-8").toString("base64");
    const filename = `move-time-log-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    console.log(`writeLogToWorkspace: built CSV (${csv.length} chars, ${movements.length} row(s)); calling tslib-putRecords for "${filename}" in workspace ${workspaceId}`);

    const created = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Attachment",
      writeObj: {
        name: filename,
        file_name: filename,
        workspaceid: workspaceId,
        base64_data: base64Data,
      },
    });
    console.log(`writeLogToWorkspace: log file written: ${filename} (id ${created?.id ?? "unknown"})`);
    return { status: "ok", id: created?.id ?? null, name: filename };
  } catch (err) {
    console.error(`writeLogToWorkspace: failed to write log file to workspace ${workspaceId}: ${err.stack || err.message || err}`);
    return { status: "error", message: err.message || String(err) };
  }
}