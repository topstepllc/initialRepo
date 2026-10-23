// SuiteProjects Pro reads for the Time Entry Reallocation tool.
// Deployed at: https://qswxt37g563vjqakg36ft7enqa0gelml.lambda-url.us-east-2.on.aws/
//
// GET ?type=projects                        -> [{ id, name }, ...]  (active projects in the configured stage(s))
// GET ?type=projectStructure&projectId=1234 -> { phases: [{ id, name, parentId, seq }], tasks: [{ id, name, phaseId }] }
//                                              (phases + tasks for ONE project, fetched in parallel; this is
//                                              what the front end's Project -> Phase -> Task pickers use)
// GET ?type=phases&projectId=1234           -> [{ id, name, parentId, seq }, ...]
//                                              (seq = SPP's own display order, used to sort the Phase picker)
// GET ?type=tasks&projectId=1234            -> [{ id, name, phaseId }, ...]
//
// Phases vs tasks: SPP splits project-task records by classification.
// /project-tasks/ only returns Tasks (classification T), /project-milestones/
// only returns Milestones (M), and Phases (P) come from /project-phases/.
// Tasks and Milestones are both bookable, so "tasks" in every response below
// is the two merged together. A task's parentId is the phase it sits directly
// under (0 = directly on the project, no phase). Phases can nest, so a
// phase's parentId is its parent phase (0 = top level). phaseId on tasks is
// returned as a string, "0" for no phase.
//
// IMPORTANT: SPP's /project-tasks/ endpoint only returns tasks for projects
// that are marked active -- inactive projects silently return zero tasks,
// regardless of any other filter (confirmed via testing, reason unknown).
// So the project list itself is filtered to active projects, to avoid
// showing users a project that would then yield an empty task dropdown.
//
// Env vars:
//   SPP_BASE_URL          e.g. https://triton-env-sb.app.sandbox.netsuitesuiteprojectspro.com/rest/v1
//   SPP_INTEGRATION_KEY   defaults to 'spp-triton-sandbox'
//   SPP_DEFAULT_STAGE_IDS comma-separated projectStageId list, defaults to '3'

const TOKEN_URL = 'https://mfuzb7y7b4uwqbe25ysh4qdzie0jtxqx.lambda-url.us-east-2.on.aws/';
const INTEGRATION_KEY = process.env.SPP_INTEGRATION_KEY || 'spp-triton-sandbox';
const BASE_URL = process.env.SPP_BASE_URL;
const DEFAULT_STAGE_IDS = process.env.SPP_DEFAULT_STAGE_IDS
  ? process.env.SPP_DEFAULT_STAGE_IDS.split(',').map(Number)
  : [3];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your hosting origin once deployed
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getAccessToken() {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ integrationKey: INTEGRATION_KEY }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Token request failed (${response.status}): ${errBody}`);
  }

  const body = await response.json();
  const token = body?.results?.[0]?.accessToken;

  if (!token) {
    throw new Error(`No accessToken found in token response: ${JSON.stringify(body)}`);
  }

  return token;
}

// Builds a filter clause for one or more internal IDs on a given field.
// Single value:    fieldName EQUAL 12
// Multiple values: fieldName ANY_OF [12,15,18]
function buildIdFilter(fieldName, ids) {
  const list = Array.isArray(ids) ? ids : [ids];

  if (list.length === 0) {
    throw new Error(`At least one value for ${fieldName} is required`);
  }

  const nums = list.map((id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid ${fieldName} value: ${id}`);
    }
    return n;
  });

  return nums.length === 1
    ? `${fieldName} EQUAL ${nums[0]}`
    : `${fieldName} ANY_OF [${nums.join(',')}]`;
}

// Generic paginated GET, following meta.links "next" until exhausted
async function fetchAllPages(initialUrl, accessToken) {
  const results = [];
  let url = initialUrl;

  while (url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`SuiteProjects Pro request failed (${response.status}): ${errBody}`);
    }

    const body = await response.json();
    results.push(...(body.data || []));

    const nextLink = body.meta?.links?.find((l) => l.rel === 'next');
    url = nextLink ? nextLink.href : null;
  }

  return results;
}

async function getProjects(stageIds, accessToken) {
  const stageFilter = buildIdFilter('projectStageId', stageIds);
  // Combine with an active-status clause -- tasks for inactive projects are
  // invisible via the API, so no point listing those projects at all.
  const filter = `${stageFilter} AND isActive IS true`;
  const url = `${BASE_URL}/projects/?q=${encodeURIComponent(filter)}&fields=id,name&limit=1000&offset=0`;
  console.log('Projects URL:', url);
  const projects = await fetchAllPages(url, accessToken);
  return projects.map((p) => ({ id: String(p.id), name: p.name }));
}

// Fetches one kind of bookable record (Tasks or Milestones) for a project.
// Both endpoints share the same filter and id/name/parentId fields.
async function getBookableRecords(endpoint, projectId, accessToken) {
  const filter = buildIdFilter('projectId', projectId);
  const url = `${BASE_URL}/${endpoint}/?q=${encodeURIComponent(filter)}&fields=id,name,projectId,parentId&limit=1000&offset=0`;
  console.log(`${endpoint} URL:`, url);
  const records = await fetchAllPages(url, accessToken);
  return records.map((t) => ({ id: String(t.id), name: t.name, phaseId: String(t.parentId || 0) }));
}

// Everything time can be booked to: Tasks (classification T) AND Milestones
// (classification M). SPP serves them from separate REST endpoints, but for
// this tool they're the same thing, so they're merged into one list (deduped
// by id, just in case). Both are Projecttask records in the XML API, so the
// move Lambda's target-task check accepts either.
async function getProjectTasks(projectId, accessToken) {
  const [tasks, milestones] = await Promise.all([
    getBookableRecords('project-tasks', projectId, accessToken),
    getBookableRecords('project-milestones', projectId, accessToken),
  ]);
  const byId = new Map();
  for (const t of [...tasks, ...milestones]) byId.set(t.id, t);
  return [...byId.values()];
}

async function getProjectPhases(projectId, accessToken) {
  const phaseFilter = buildIdFilter('projectId', projectId);
  const url = `${BASE_URL}/project-phases/?q=${encodeURIComponent(phaseFilter)}&fields=id,name,projectId,parentId,seq&limit=1000&offset=0`;
  console.log('Phase URL:', url);
  const phases = await fetchAllPages(url, accessToken);
  return phases.map((p) => ({
    id: String(p.id),
    name: p.name,
    parentId: String(p.parentId || 0),
    seq: Number(p.seq ?? 0),
  }));
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  const qs = event?.queryStringParameters || {};

  if (event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    const type = qs.type || 'projects';
    const needsProject = ['tasks', 'phases', 'projectStructure'].includes(type);

    if (needsProject && !qs.projectId) {
      return jsonResponse(400, { message: `projectId query param is required for type=${type}` });
    }
    if (type !== 'projects' && !needsProject) {
      return jsonResponse(400, { message: `Unknown type: ${type}` });
    }

    const accessToken = await getAccessToken();

    if (type === 'projects') {
      const stageIds = qs.stageIds ? qs.stageIds.split(',').map(Number) : DEFAULT_STAGE_IDS;
      const projects = await getProjects(stageIds, accessToken);
      return jsonResponse(200, projects);
    }

    console.log(`Fetching ${type} for project:`, qs.projectId);

    if (type === 'tasks') {
      return jsonResponse(200, await getProjectTasks(qs.projectId, accessToken));
    }

    if (type === 'phases') {
      return jsonResponse(200, await getProjectPhases(qs.projectId, accessToken));
    }

    // projectStructure
    const [phases, tasks] = await Promise.all([
      getProjectPhases(qs.projectId, accessToken),
      getProjectTasks(qs.projectId, accessToken),
    ]);
    return jsonResponse(200, { phases, tasks });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { message: err.message });
  }
};