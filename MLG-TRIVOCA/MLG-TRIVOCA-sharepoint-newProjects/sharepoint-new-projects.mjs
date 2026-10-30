// =============================================================================
// NOTE (9/21): We were asked to remove the SharePoint/Teams "Team" logic for
// now. All Team-related code (Team creation, creation polling, owner lookup
// for the Team, Team ID writeback to SPP, and Team mentions in the owner
// email) has been COMMENTED OUT rather than deleted, in case we need it again.
// Search for "TEAM LOGIC DISABLED" to find every spot that was changed.
// =============================================================================

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({ region: "us-east-2" });
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

// SPP credentials, pulled from Lambda environment variables, used for the
// writeback call (tslib-putRecords) once SharePoint provisioning succeeds.
const authObj = {
  company: process.env.COMPANY,
  user: process.env.USER,
  password: process.env.PASSWORD,
  instance: process.env.INSTANCE,
};

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SHAREPOINT_HOSTNAME = "trivocahealth.sharepoint.com";
const SITE_PATH_BY_DIVISION = {
  Qual: "/sites/QualitativeProjects",
  Quant: "/sites/QuantitativeProjects", // adjust if the actual Quant site path differs
};

// Mailbox used to send the "your folders are ready" notification.
// Must be a real mailbox in the tenant — app-only Mail.Send sends AS this
// user, not as the project owner. Recipient (project.owner_email) can be
// any valid address.
const NOTIFICATION_FROM_MAILBOX = "rschein@topstepllc.com";

// Only projects closed-won ON OR AFTER this date are provisioned. SPP sends
// project_closed_won_date__c as "YYYY-MM-DD", which sorts correctly as a
// plain string, so no Date parsing (or timezone drift) is needed.
const CLOSED_WON_CUTOFF = "2026-09-24";

// True if the project's closed-won date is on/after CLOSED_WON_CUTOFF.
// Blank, missing, or SPP's "0000-00-00" empty-date value all fail the check.
function isEligibleByClosedWonDate(project) {
  const closedWon = (project.project_closed_won_date__c || "").substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedWon) || closedWon === "0000-00-00") {
    return false;
  }
  return closedWon >= CLOSED_WON_CUTOFF;
}

// Retrieve NEW projects from SPP (passed via lambda function call) and
// provision SharePoint folders for each. Handles updates to EXISTING
// projects in a separate Lambda.
// (TEAM LOGIC DISABLED 9/21 — previously also provisioned a Team per project.)
export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);

  if (!Array.isArray(bodyJSON.projects) || bodyJSON.projects.length === 0) {
    console.log("No new projects in payload");
    return;
  }

  // Skip anything closed-won before CLOSED_WON_CUTOFF (or with no date)
  const eligibleProjects = bodyJSON.projects.filter((project) => {
    const eligible = isEligibleByClosedWonDate(project);
    if (!eligible) {
      console.log(
        `Skipping "${project.name}" — project_closed_won_date__c "${project.project_closed_won_date__c}" is empty or before ${CLOSED_WON_CUTOFF}`,
      );
    }
    return eligible;
  });

  if (eligibleProjects.length === 0) {
    console.log(
      `No projects with project_closed_won_date__c on/after ${CLOSED_WON_CUTOFF}`,
    );
    return;
  }

  const token = await getGraphToken();

  await Promise.all(
    eligibleProjects.map(async (project) => {
      // TEAM LOGIC DISABLED (9/21) — Team creation for new projects
      // let teamId = project.proj_sharepoint_team_id__c;
      //
      // if (teamId) {
      //   console.log(
      //     `Project "${project.name}" already has a Team (id=${teamId}) — skipping Team creation`,
      //   );
      // } else {
      //   const ownerId = await getUserId(token, project.owner_email);
      //   teamId = await newSharepointTeam(token, project.name, ownerId);
      // }

      const projectFolder = await createFoldersInSharepoint(project, token);

      // TEAM LOGIC DISABLED (9/21) — original call also passed teamId:
      // await writeSharepointIdsToSpp(project, projectFolder.id, teamId, authObj);
      await writeSharepointIdsToSpp(
        project,
        projectFolder.id,
        projectFolder.webUrl,
        authObj,
      );

      await emailProjectOwner(project, token);
    }),
  );
};

// Resolves the SharePoint site id for a division's configured site path
async function getSiteId(token, sitePath) {
  const res = await fetch(
    `${GRAPH_BASE}/sites/${SHAREPOINT_HOSTNAME}:${sitePath}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Failed to resolve site: ${JSON.stringify(data)}`);
  return data.id;
}

// Resolves the default document library's drive id for a site
async function getDriveId(token, siteId) {
  const res = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Failed to resolve drive: ${JSON.stringify(data)}`);
  return data.id;
}

// Patches list-item fields (metadata) on a drive item, e.g. the project folder
async function updateFolderMetadata(token, driveId, itemId, columns) {
  const res = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/listItem/fields`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(columns),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Metadata update failed for item ${itemId}: ${JSON.stringify(data)}`,
    );
  }

  console.log(
    `Metadata updated for item ${itemId}: ${JSON.stringify(columns)}`,
  );
  return data;
}

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepoint(project, token) {
  const sitePath = SITE_PATH_BY_DIVISION[project.proj_Division__c];
  console.log(`sitePath: ${sitePath}`);
  if (!sitePath) {
    console.log(
      `No site path configured for division: ${project.proj_Division__c}`,
    );
    return { deleted: false };
  }
  const siteId = await getSiteId(token, sitePath);
  console.log(`siteId: ${siteId}`);

  const driveId = await getDriveId(token, siteId);
  console.log(`driveId: ${driveId}`);

  // Generic folder creation, works at root OR under a parent item
  async function createFolder(token, driveId, folderName, parentId = null) {
    const endpoint = parentId
      ? `${GRAPH_BASE}/drives/${driveId}/items/${parentId}/children`
      : `${GRAPH_BASE}/drives/${driveId}/root/children`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        `Folder creation failed for "${folderName}"${
          parentId ? ` under parent ${parentId}` : " at root"
        }: ${JSON.stringify(data)}`,
      );
    }
    console.log(`Folder created: ${folderName} -> id: ${data.id}`);
    return data;
  }

  // Recursively walks a folder tree definition and creates each node.
  // `node` can be a plain string (leaf, no children) or an object:
  //   { name: "Accounting+Compliance", children: [ "Compliance Materials", { name: "..." , children: [...] } ] }
  async function createFolderTree(token, driveId, node, parentId) {
    const name = typeof node === "string" ? node : node.name;
    const children = typeof node === "string" ? [] : node.children || [];

    const created = await createFolder(token, driveId, name, parentId);

    if (children.length) {
      await Promise.all(
        children.map((child) =>
          createFolderTree(token, driveId, child, created.id),
        ),
      );
    }

    return created;
  }

  // Define the full structure once, declaratively
  const folderStructure = [
    {
      name: "Accounting+Compliance",
      children: ["Compliance Materials", "Invoicing"],
    },
    "Client Lists",
    {
      name: "Project Management",
      children: [
        {
          name: "Project Materials",
          children: ["NDAs", "Prework", "Schedule", "Screener+Algorithm"],
        },
        "Recruiting Updates",
      ],
    },
  ];

  const projectFolder = await createFolder(
    token,
    driveId,
    sanitizeSharepointName(project.name),
  );

  // Metadata on the project folder itself
  await addMetadataToSharepointFolder(
    token,
    project,
    projectFolder.id,
    siteId,
    driveId,
    project.proj_Division__c,
  );

  console.log(`Creating folder structure for: ${project.name}`);
  await Promise.all(
    folderStructure.map((node) =>
      createFolderTree(token, driveId, node, projectFolder.id),
    ),
  );

  return projectFolder;
}

// Add metadata to the Sharepoint folder for each NEW project (Loop A, Yes branch, second action)
async function addMetadataToSharepointFolder(
  token,
  project,
  folderId,
  siteId,
  driveId,
  division,
) {
  console.log(`Entering metadata function`);

  // Pulls the column definitions for the document library backing this drive
  // and logs displayName -> name (the internal/backend name Graph expects
  // in the fields PATCH below). Handy for re-discovering internal names
  // (e.g. "Project_x0020_Status") without digging through Site Settings.
  async function logFolderColumnNames(token, driveId) {
    const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/list/columns`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      console.log(
        `Failed to fetch column definitions: ${JSON.stringify(data)}`,
      );
      return;
    }
    const columnMap = data.value
      .filter((col) => !col.readOnly) // skip system/computed columns you can't write to
      .map((col) => ({ displayName: col.displayName, name: col.name }));
    console.log(`Writable column names: ${JSON.stringify(columnMap)}`);
  }

  await logFolderColumnNames(token, driveId);

  const columns = buildDivisionMetadataColumns(project, division);
  if (!columns) {
    console.log(
      `Unrecognized division "${division}" — skipping metadata update for folder ${folderId}`,
    );
    return;
  }

  await updateFolderMetadata(token, driveId, folderId, columns);
}

// Emails the project owner once their SharePoint folders have been created —
// called after createFoldersInSharepoint has resolved for the project. Sends
// AS NOTIFICATION_FROM_MAILBOX (app-only Mail.Send requires a real tenant
// mailbox as sender); recipient can be any valid address, since
// project.owner_email comes straight from SPP.
// (TEAM LOGIC DISABLED 9/21 — email previously also announced the Team.)
async function emailProjectOwner(project, token) {
  const message = {
    message: {
      subject: `SharePoint site ready: ${project.name}`,
      body: {
        contentType: "Text",
        // TEAM LOGIC DISABLED (9/21) — original body mentioned the Team:
        // content: `Hi,\n\nThe SharePoint folder structure and Team for "${project.name}" have been created and are ready to use.\n\nThanks,\nAutomation`,
        content: `Hi,\n\nThe SharePoint folder structure for "${project.name}" has been created and is ready to use.\n\nThanks,\nAutomation`,
      },
      toRecipients: [
        { emailAddress: { address: project.owner_email } },
        { emailAddress: { address: "rschein@topstepllc.com" } },
      ],
    },
    saveToSentItems: true,
  };

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(NOTIFICATION_FROM_MAILBOX)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    },
  );

  // sendMail returns 202 with an EMPTY body on success — only parse JSON
  // on the error path, or res.json() will throw on the happy path.
  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `Failed to send folder-ready email for "${project.name}" to ${project.owner_email}: ${JSON.stringify(data)}`,
    );
  }

  console.log(
    `Sent folder-ready email to ${project.owner_email} for "${project.name}"`,
  );
}

// Writes the newly-created SharePoint folder ID and folder link (webUrl from
// the folder-create response) back to the project's record in SPP. Call this
// once createFoldersInSharepoint has resolved.
// TEAM LOGIC DISABLED (9/21) — original signature also accepted teamId:
// async function writeSharepointIdsToSpp(project, folderId, teamId, authObj) {
async function writeSharepointIdsToSpp(project, folderId, folderUrl, authObj) {
  console.log(`WRITE--authObj: ${JSON.stringify(authObj)}`);
  // TEAM LOGIC DISABLED (9/21)
  // console.log(`WRITE--teamId: ${JSON.stringify(teamId)}`);
  console.log(`WRITE--folderId: ${JSON.stringify(folderId)}`);
  console.log(`WRITE--folderUrl: ${JSON.stringify(folderUrl)}`);
  console.log(`WRITE--projectId: ${JSON.stringify(project.id)}`);
  const projectSharepointIds = {
    id: project.id,
    proj_sharepoint_folder_id__c: folderId,
    proj_sharepoint_folder_link__c: folderUrl,
    // TEAM LOGIC DISABLED (9/21)
    // proj_sharepoint_team_id__c: teamId,
  };

  const projectUpdateDetails = {
    authObj: authObj,
    recordType: "Project",
    writeObj: projectSharepointIds,
  };

  const projectUpdate = await callSharedUtil(
    "tslib-putRecords",
    projectUpdateDetails,
  );

  // TEAM LOGIC DISABLED (9/21) — original log included the Team ID:
  // console.log(
  //   `Wrote SharePoint IDs back to SPP for "${project.name}": folder=${folderId}, team=${teamId}`,
  // );
  console.log(
    `Wrote SharePoint folder ID and link back to SPP for "${project.name}": folder=${folderId}, link=${folderUrl}`,
  );

  return projectUpdate;
}

// =============================================================================
// TEAM LOGIC DISABLED (9/21) — Team creation + polling. Uncomment to restore.
// =============================================================================
/*
// Create a Sharepoint Team Site for each NEW project (Loop A, Yes branch, second path, first action)
async function newSharepointTeam(token, teamName, ownerId, description = "") {
  const res = await fetch(`${GRAPH_BASE}/teams`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      "template@odata.bind":
        "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
      displayName: teamName,
      description,
      members: [
        {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${ownerId}')`,
        },
      ],
    }),
  });

  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Team creation failed: ${JSON.stringify(data)}`);
  }

  const operationUrl = res.headers.get("Location");
  console.log(
    `Team creation started for "${teamName}", polling: ${operationUrl}`,
  );
  return await pollTeamCreation(token, operationUrl);
}

async function pollTeamCreation(
  token,
  operationUrl,
  maxAttempts = 30,
  delayMs = 5000,
) {
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${GRAPH_BASE}${operationUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    lastStatus = data.status;
    console.log(
      `Poll attempt ${attempt}: status = ${data.status} data = ${JSON.stringify(data)}`,
    );

    if (data.status === "succeeded") {
      const teamId =
        data.targetResourceLocation?.match(/teams\('(.+)'\)/)?.[1] ??
        data.resourceLocation?.match(/teams\('(.+)'\)/)?.[1];
      if (!teamId) {
        throw new Error(
          `Team succeeded but no teamId found in: ${JSON.stringify(data)}`,
        );
      }
      return teamId;
    }
    if (data.status === "failed") {
      throw new Error(
        `Team creation operation failed: ${JSON.stringify(data)}`,
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(
    `Team creation timed out after ${maxAttempts} attempts for operation: ${operationUrl}. Last known status: "${lastStatus}"`,
  );
}
*/

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/07df17c1-4112-495c-b15f-76a25f844f3d/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: "82c08c90-bc61-4af4-ad27-7f7e3d838c1c",
    client_secret: "A3H8Q~Wo~wbycVR4j4PDSg6mKtkka.HH26z5.cQF",
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  } else {
    console.log(`Token request successful: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// =============================================================================
// TEAM LOGIC DISABLED (9/21) — owner lookup was only used to assign the Team
// owner. Uncomment along with newSharepointTeam/pollTeamCreation to restore.
// =============================================================================
/*
const FALLBACK_OWNER_EMAIL = "unassigned.pm@trivoca.com";

// Resolves a user's AAD object id for the given email. Falls back to
// FALLBACK_OWNER_EMAIL if the original lookup fails or doesn't return a
// usable id. Only throws if the fallback lookup ALSO fails, since at that
// point there's no owner left to assign.
async function getUserId(token, upnOrEmail) {
  async function lookupUser(email) {
    const res = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(email)}?$select=id,displayName,userPrincipalName`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok || !data.id) return null;
    return data;
  }

  const primary = await lookupUser(upnOrEmail);
  if (primary) {
    console.log(
      `Resolved user: ${primary.userPrincipalName} -> id: ${primary.id}`,
    );
    return primary.id;
  }

  console.log(
    `Could not resolve user "${upnOrEmail}", falling back to ${FALLBACK_OWNER_EMAIL}`,
  );

  const fallback = await lookupUser(FALLBACK_OWNER_EMAIL);
  if (fallback) {
    console.log(
      `Resolved fallback user: ${fallback.userPrincipalName} -> id: ${fallback.id}`,
    );
    return fallback.id;
  }

  // Both lookups failed — nothing usable to return, and passing undefined
  // downstream just produces a confusing Graph error later, so fail loudly here.
  throw new Error(
    `Failed to resolve both primary user "${upnOrEmail}" and fallback "${FALLBACK_OWNER_EMAIL}"`,
  );
}
*/

// Builds the division-specific metadata columns object for the folder PATCH.
// Builds the division-specific metadata columns object for the folder PATCH.
function buildDivisionMetadataColumns(project, division) {
  const projectDate = project.start_date
    ? project.start_date.substring(0, 10)
    : null;
  const projectEndDate = project.trv_proj_End_Date__c
    ? project.trv_proj_End_Date__c.substring(0, 10)
    : null;

  if (division === "Qual") {
    return {
      ProjectManager: project.owner_name,
      Secondary_x0020_Project_x0020_Manager: project.secondary_owner_name,
      ProjectCoordinator: project.coordinator_name,
      ProjectDate: projectDate,
      ProjectEndDate: projectEndDate,
      AccountManager: project.proj_Sales_Rep__c,
      ProjectStatus: project.proj_Project_Status__c,
      Client: project.client_name,
    };
  }
  if (division === "Quant") {
    return {
      Project_x0020_Manager: project.owner_name,
      // Verify this internal name against the "Writable column names" log line
      Secondary_x0020_Project_x0020_Manager: project.secondary_owner_name,
      Project_x0020_Coordinator: project.coordinator_name,
      Project_x0020_Start_x0020_Date: projectDate,
      Project_x0020_End_x0020_Date: projectEndDate,
      Account_x0020_Manager: project.proj_Sales_Rep__c,
      Project_x0020_Status: project.proj_Project_Status__c,
      Clients: project.client_name,
    };
  }
  return null;
}
// SharePoint Online rejects these in file/folder names: " * : < > ? / \ |
// (# and % are allowed in SPO). Also strips control characters.
const INVALID_SP_CHARS = /["*:<>?/\\|\x00-\x1F]/g;

// Names SharePoint blocks outright, regardless of characters
const RESERVED_SP_NAMES = new Set([
  ".lock",
  "con",
  "prn",
  "aux",
  "nul",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "_vti_",
  "desktop.ini",
]);

// Returns a SharePoint-safe folder name, or throws if nothing usable is left.
function sanitizeSharepointName(rawName) {
  let name = (rawName || "")
    .replace(INVALID_SP_CHARS, "-")
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .replace(/^~\$/, "") // leading ~$ is blocked
    .trim()
    .replace(/[.\s]+$/, ""); // no trailing periods or spaces

  if (name.includes("_vti_")) name = name.replace(/_vti_/g, "-vti-");
  if (RESERVED_SP_NAMES.has(name.toLowerCase())) name = `${name}-project`;

  // Keep well under the 400-char full-path limit
  if (name.length > 200) name = name.substring(0, 200).trim();

  if (!name) {
    throw new Error(`Project name "${rawName}" is empty after sanitizing`);
  }
  if (name !== rawName) {
    console.log(`Sanitized folder name: "${rawName}" -> "${name}"`);
  }
  return name;
}
