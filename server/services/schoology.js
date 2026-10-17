import OAuth from 'oauth-1.0a';
import { summarizeRevisions } from '../lib/submissionRevisions.js';

const BASE = process.env.SCHOOLOGY_BASE_URL;
const API = `${BASE}/v1`;

const oauth = OAuth({
  consumer: {
    key: process.env.SCHOOLOGY_CONSUMER_KEY,
    secret: process.env.SCHOOLOGY_CONSUMER_SECRET,
  },
  signature_method: 'PLAINTEXT',
});

const token = { key: '', secret: '' };

// ── Low-level HTTP helpers ──

async function apiGet(path) {
  let url = path.startsWith('http') ? path : `${API}${path}`;
  for (let i = 0; i < 5; i++) {
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'GET' }, token));
    const res = await fetch(url, {
      headers: { ...authHeader, Accept: 'application/json' },
      redirect: 'manual',
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      url = location.startsWith('http') ? location : new URL(location, url).href;
      continue;
    }
    if (!res.ok) {
      const err = new Error(`Schoology API ${res.status}: GET ${path}`);
      err.status = res.status;
      if (res.status === 429) err.rateLimited = true;
      if (res.status === 429 || res.status >= 500) err.transient = true;
      throw err;
    }
    return res.json();
  }
  throw new Error(`Too many redirects: GET ${path}`);
}

async function apiPut(path, body) {
  const url = `${API}${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'PUT' }, token));
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function apiPost(path, body) {
  const url = `${API}${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function apiDelete(path) {
  const url = `${API}${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'DELETE' }, token));
  const res = await fetch(url, { method: 'DELETE', headers: { ...authHeader, Accept: 'application/json' } });
  return { status: res.status };
}

// Paginate through a Schoology list endpoint
async function paginateGet(path, listKey) {
  let all = [];
  let start = 0;
  const limit = 100;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await apiGet(`${path}${sep}start=${start}&limit=${limit}`);
    const items = data[listKey] || [];
    all = all.concat(items);
    if (items.length < limit) break;
    start += limit;
  }
  return all;
}

// ── Public API ──

export async function getMyUserId() {
  const data = await apiGet('/users/me');
  return String(data.id || data.uid);
}

export async function getMySections(userId) {
  return paginateGet(`/users/${userId}/sections`, 'section');
}

export async function getSection(sectionId) {
  return apiGet(`/sections/${sectionId}`);
}

export async function getSectionEnrollments(sectionId) {
  return paginateGet(`/sections/${sectionId}/enrollments`, 'enrollment');
}

export async function getSectionAssignments(sectionId) {
  return paginateGet(`/sections/${sectionId}/assignments`, 'assignment');
}

export async function getSectionGrades(sectionId) {
  // Returns flat array from grades.grade[]
  const data = await apiGet(`/sections/${sectionId}/grades`);
  return data?.grades?.grade || [];
}

export async function getSectionGradingPeriods(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/grading_periods`);
  return data?.grading_period || [];
}

export async function getUserProfile(uid) {
  return apiGet(`/users/${uid}`);
}

// Batched profile fetch (#105): POST /v1/multiget bundles up to ~50 per-user
// reads into one HTTP call. Each bundled `body` is the COMPLETE /users/{uid}
// object (primary_email + parents.parent[]). Paths MUST carry the /v1 prefix.
// Best-effort: a failed chunk (network/429) yields no entries for that chunk —
// those students are absent from the map and the caller preserves them.
// Returns Map<string uid, profile>.
const MULTIGET_CHUNK = 50;
export async function getUserProfilesBatch(uids) {
  const out = new Map();
  for (let i = 0; i < uids.length; i += MULTIGET_CHUNK) {
    const chunk = uids.slice(i, i + MULTIGET_CHUNK);
    let data;
    try {
      ({ data } = await apiPost('/multiget', { request: chunk.map(u => `/v1/users/${u}`) }));
    } catch {
      continue; // network error — preserve these students (caller skips them)
    }
    for (const entry of (data?.response || [])) {
      const code = Number(entry.response_code);
      if (code && code !== 200) continue;
      const body = entry.body;
      if (!body) continue;
      const uid = String(body.uid || body.id || '');
      if (uid) out.set(uid, body);
    }
  }
  return out;
}

export async function getSectionFolders(sectionId) {
  // Paginate: Schoology pages this endpoint at 20 items by default, so a single
  // un-paginated GET silently drops the 21st+ folder (and every assignment in
  // it falls into the "Ungrouped" bucket). The list wrapper key is `folders`.
  return paginateGet(`/sections/${sectionId}/folders`, 'folders');
}

export async function getSectionGradingCategories(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/grading_categories`);
  return data?.grading_category || [];
}

export async function getSectionGradingScales(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/grading_scales`);
  return data?.grading_scale || data?.grading_scales || [];
}

export async function getSectionCompletion(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/completion`);
  return data?.completion || [];
}

// Bulk submission fetch (#55): every student's LATEST revision for one
// assignment in a single call — `{ revision: [{ revision_id, uid, created,
// num_items, late, draft }], total, links }`. ⚠️ The bulk endpoint returns only
// the latest revision per student, NOT the full revision history (verified
// 2026-06-07 across MAD + AP CSP CPT projects — per-student showed [1,2,3…] where
// bulk showed only the latest). That is sync-equivalent: the sync only needs the
// latest revision's late/draft and the newest non-draft `created` (#49 resubmit
// timing), and a genuine resubmit IS the latest. Follows links.next (Schoology
// pages this at ~20). Native dropbox only — the public revisions API is blind to
// post-submit LTI (those use the #62 document endpoints). Group the result with
// groupRevisionsByUid to recover the per-student summary.
export async function getAssignmentSubmissions(sectionId, assignmentId) {
  let url = `/sections/${sectionId}/submissions/${assignmentId}?limit=100`;
  const all = [];
  // Safety cap: Schoology rosters are ~20; this guards a malformed links.next.
  for (let page = 0; url && page < 100; page++) {
    const data = await apiGet(url);
    const revs = data?.revision || [];
    all.push(...revs);
    url = data?.links?.next || null;
  }
  return all;
}

// Returns the per-student revision summary { ...latestRevision, latestRevisionAt }
// or null. latestRevisionAt is the newest non-draft `created` (the #49 resubmit
// baseline). Shares summarizeRevisions with the bulk #55 path.
export async function getSubmissionStatus(sectionId, assignmentId, userId) {
  const data = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${userId}`);
  return summarizeRevisions(data?.revision || []);
}

export async function pushGradeComments(sectionId, gradeUpdates) {
  // gradeUpdates: array of { assignment_id, enrollment_id, grade, comment, comment_status }
  return apiPut(`/sections/${sectionId}/grades`, {
    grades: { grade: gradeUpdates },
  });
}

// One student's submission comment thread, oldest first. Pages by start/limit
// until `total` is reached (verified 2026-10-17; threads seen hold 0 to 3).
export async function getSubmissionComments(sectionId, assignmentId, userId) {
  const base = `/sections/${sectionId}/submissions/${assignmentId}/${userId}/comments`;
  const first = await apiGet(`${base}?start=0&limit=200`);
  const items = [...(first?.comment || [])];
  const total = Number(first?.total ?? items.length);
  for (let page = 0; items.length < total && page < 50; page++) {
    const more = (await apiGet(`${base}?start=${items.length}&limit=200`))?.comment || [];
    if (!more.length) break;
    items.push(...more);
  }
  return items.sort((a, b) => (Number(a.created) - Number(b.created)) || (Number(a.id) - Number(b.id)));
}

// Post a text comment on a student's submission. The body must be flat
// ({comment}); the nested form posts a blank comment. Attachments are dropped
// by this endpoint (16 Oct 2026), so it is text only. Returns {status, data}.
export async function postSubmissionComment(sectionId, assignmentId, userId, text) {
  return apiPost(`/sections/${sectionId}/submissions/${assignmentId}/${userId}/comments`, { comment: text });
}

export async function deleteSubmissionComment(sectionId, assignmentId, userId, commentId) {
  return apiDelete(`/sections/${sectionId}/submissions/${assignmentId}/${userId}/comments/${commentId}`);
}

export { apiGet, apiPut, apiPost, apiDelete };
