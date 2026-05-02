import OAuth from 'oauth-1.0a';

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
      throw new Error(`Schoology API ${res.status}: GET ${path}`);
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

export async function getSectionFolders(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/folders`);
  return data?.folders || data?.folder || [];
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

export async function getSubmissionStatus(sectionId, assignmentId, userId) {
  const data = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${userId}`);
  return data?.revision || [];
}

export async function pushGradeComments(sectionId, gradeUpdates) {
  // gradeUpdates: array of { assignment_id, enrollment_id, grade, comment, comment_status }
  return apiPut(`/sections/${sectionId}/grades`, {
    grades: { grade: gradeUpdates },
  });
}

export { apiGet, apiPut };
