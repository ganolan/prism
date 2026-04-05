/**
 * Schoology API Discovery Script
 *
 * Systematically tests all documented Schoology REST API v1 read endpoints
 * to map what's accessible with our current two-legged OAuth credentials.
 *
 * Usage: node test-api-discovery.js [category]
 * Categories: all, user, section, course, school, group, messaging, misc
 * Default: all
 */

import 'dotenv/config';
import OAuth from 'oauth-1.0a';
import { writeFileSync } from 'fs';

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

// ── Helpers ──

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
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, url };
  }
  return { status: 0, data: 'Too many redirects', url };
}

// Rate limiting - Schoology limits to ~50 req/min for OAuth 1.0a apps
let requestCount = 0;
async function throttledGet(path) {
  requestCount++;
  if (requestCount % 40 === 0) {
    console.log('    [pausing 5s for rate limit...]');
    await new Promise(r => setTimeout(r, 5000));
  }
  return apiGet(path);
}

function divider(title) {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(70));
}

function summarize(data, maxDepth = 2) {
  if (data === null || data === undefined) return 'null';
  if (typeof data === 'string') return data.substring(0, 200);
  if (Array.isArray(data)) {
    return `[Array(${data.length})${data.length > 0 ? ': ' + summarize(data[0], maxDepth - 1) : ''}]`;
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (maxDepth <= 0) return `{${keys.join(', ')}}`;
    const entries = keys.slice(0, 8).map(k => {
      const v = data[k];
      if (Array.isArray(v)) return `${k}: [Array(${v.length})]`;
      if (typeof v === 'object' && v !== null) return `${k}: {${Object.keys(v).join(', ')}}`;
      return `${k}: ${JSON.stringify(v)}`.substring(0, 80);
    });
    if (keys.length > 8) entries.push(`...+${keys.length - 8} more`);
    return `{ ${entries.join(', ')} }`;
  }
  return String(data);
}

// Results collector
const results = [];

async function testEndpoint(label, path, opts = {}) {
  const { expectMisleading = false, detail = false } = opts;
  process.stdout.write(`  ${label.padEnd(55)} `);

  try {
    const result = await throttledGet(path);
    const { status, data } = result;

    // Detect misleading responses (200 but returns parent object)
    let misleading = false;
    if (status === 200 && typeof data === 'object' && data !== null) {
      // If we're requesting a sub-resource but get back a section/assignment/course object
      const hasId = data.id && (data.course_title || data.title || data.school_title);
      if (hasId && !expectMisleading) {
        // Check if this looks like the parent object echoed back
        const pathParts = path.split('/');
        const lastSegment = pathParts[pathParts.length - 1].split('?')[0];
        if (!['sections', 'assignments', 'courses', 'users', 'schools'].includes(lastSegment)) {
          misleading = true;
        }
      }
    }

    const icon = status === 200 ? (misleading ? '⚠️  MISLEADING' : '✅') :
                 status === 403 ? '🔒 FORBIDDEN' :
                 status === 404 ? '❌ NOT FOUND' :
                 status === 400 ? '⛔ BAD REQ' :
                 status === 405 ? '🚫 NOT ALLOWED' :
                 `⚡ ${status}`;

    console.log(`${icon} (${status})`);

    if (status === 200 && !misleading && detail) {
      console.log(`    → ${summarize(data)}`);
    }
    if (misleading) {
      console.log(`    → Returns parent object instead of sub-resource`);
    }

    results.push({
      label,
      path,
      status,
      misleading,
      topKeys: typeof data === 'object' && data !== null ? Object.keys(data) : null,
      hasData: status === 200 && !misleading,
      sample: status === 200 && !misleading && detail ? data : undefined,
    });

    return { status, data, misleading };
  } catch (err) {
    console.log(`💥 ERROR: ${err.message}`);
    results.push({ label, path, status: -1, error: err.message });
    return { status: -1, data: null };
  }
}


// ── Main ──

async function run() {
  const category = process.argv[2] || 'all';
  const validCategories = ['all', 'user', 'section', 'course', 'school', 'group', 'messaging', 'misc'];
  if (!validCategories.includes(category)) {
    console.log(`Invalid category: ${category}`);
    console.log(`Valid: ${validCategories.join(', ')}`);
    process.exit(1);
  }

  console.log('Schoology API Discovery');
  console.log(`Category: ${category}`);
  console.log(`Base URL: ${API}`);
  console.log('');

  // ── Resolve our user ID first ──
  const me = await apiGet('/users/me');
  if (me.status !== 200) {
    console.log('Cannot authenticate. Check credentials.');
    process.exit(1);
  }
  const myId = me.data.id;
  console.log(`Authenticated as UID: ${myId}`);

  // ── Get sections list for testing ──
  const sectionsRes = await apiGet(`/users/${myId}/sections`);
  const sections = sectionsRes.data?.section || [];
  const testSectionId = sections[0]?.id;
  const testCourseId = sections[0]?.course_id || sections[0]?.course_nid;
  console.log(`Test section: ${testSectionId} (${sections[0]?.course_title})`);
  console.log(`Test course ID: ${testCourseId}`);
  console.log(`Total sections: ${sections.length}`);

  // Get an assignment ID for testing
  const assignRes = await apiGet(`/sections/${testSectionId}/assignments?limit=5`);
  const assignments = assignRes.data?.assignment || [];
  const testAssignmentId = assignments[0]?.id;
  console.log(`Test assignment: ${testAssignmentId} (${assignments[0]?.title})`);

  // Get an enrollment for testing
  const enrollRes = await apiGet(`/sections/${testSectionId}/enrollments`);
  const enrollments = enrollRes.data?.enrollment || [];
  const students = enrollments.filter(e => e.admin !== 1 && e.admin !== '1');
  const testStudentUid = students[0]?.uid;
  const testEnrollmentId = students[0]?.id;
  console.log(`Test student UID: ${testStudentUid}, enrollment ID: ${testEnrollmentId}`);

  // Get school ID
  const schoolRes = await apiGet('/schools');
  const schools = schoolRes.data?.school || [];
  const testSchoolId = schools[0]?.id;
  console.log(`Test school ID: ${testSchoolId} (${schools[0]?.title})`);

  // ═══════════════════════════════════════════════════════
  //  USER ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'user') {
    divider('USER ENDPOINTS');

    await testEndpoint('GET /users/me', '/users/me', { detail: true });
    await testEndpoint('GET /users/{uid}', `/users/${myId}`, { detail: true });
    await testEndpoint('GET /users/{uid}/sections', `/users/${myId}/sections`, { detail: true });
    await testEndpoint('GET /users/{uid}/grades', `/users/${myId}/grades`, { detail: true });
    await testEndpoint('GET /users/{uid}/updates', `/users/${myId}/updates`, { detail: true });
    await testEndpoint('GET /users/{uid}/blogs', `/users/${myId}/blogs`, { detail: true });
    await testEndpoint('GET /users/{uid}/events', `/users/${myId}/events`, { detail: true });
    await testEndpoint('GET /users/{uid}/groups', `/users/${myId}/groups`, { detail: true });
    await testEndpoint('GET /users/{uid}/notifications', `/users/${myId}/notifications`, { detail: true });
    await testEndpoint('GET /users/{uid}/requests', `/users/${myId}/requests`, { detail: true });

    // Student profile test
    if (testStudentUid) {
      await testEndpoint('GET /users/{student_uid} (student)', `/users/${testStudentUid}`, { detail: true });
    }

    // Multi-get
    if (testStudentUid) {
      await testEndpoint('GET /users?uids=...', `/users?uids=${myId},${testStudentUid}`, { detail: true });
    }

    // User activity
    await testEndpoint('GET /users/{uid}/activity', `/users/${myId}/activity`, { detail: true });

    // User's grading rubrics
    await testEndpoint('GET /users/{uid}/grading_rubrics', `/users/${myId}/grading_rubrics`, { detail: true });
  }

  // ═══════════════════════════════════════════════════════
  //  SECTION ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'section') {
    divider('SECTION - CORE');

    await testEndpoint('GET /sections/{id}', `/sections/${testSectionId}`, { detail: true });
    await testEndpoint('GET /sections/{id}/info', `/sections/${testSectionId}/info`, { detail: true });

    divider('SECTION - CONTENT & MATERIALS');

    await testEndpoint('GET /sections/{id}/updates', `/sections/${testSectionId}/updates`, { detail: true });
    await testEndpoint('GET /sections/{id}/documents', `/sections/${testSectionId}/documents`, { detail: true });
    await testEndpoint('GET /sections/{id}/discussions', `/sections/${testSectionId}/discussions`, { detail: true });
    await testEndpoint('GET /sections/{id}/pages', `/sections/${testSectionId}/pages`, { detail: true });
    await testEndpoint('GET /sections/{id}/links', `/sections/${testSectionId}/links`, { detail: true });
    await testEndpoint('GET /sections/{id}/media-albums', `/sections/${testSectionId}/media-albums`, { detail: true });
    await testEndpoint('GET /sections/{id}/folders', `/sections/${testSectionId}/folders`, { detail: true });
    await testEndpoint('GET /sections/{id}/events', `/sections/${testSectionId}/events`, { detail: true });

    divider('SECTION - GRADES & ASSESSMENTS');

    await testEndpoint('GET /sections/{id}/assignments', `/sections/${testSectionId}/assignments?limit=3`, { detail: true });
    await testEndpoint('GET /sections/{id}/assignments/{aid}', `/sections/${testSectionId}/assignments/${testAssignmentId}`, { detail: true });
    await testEndpoint('GET /sections/{id}/grades', `/sections/${testSectionId}/grades`, { detail: true });
    await testEndpoint('GET /sections/{id}/grades?assignment_id', `/sections/${testSectionId}/grades?assignment_id=${testAssignmentId}`, { detail: true });
    await testEndpoint('GET /sections/{id}/grade_items', `/sections/${testSectionId}/grade_items`, { detail: true });
    await testEndpoint('GET /sections/{id}/grading_scales', `/sections/${testSectionId}/grading_scales`, { detail: true });
    await testEndpoint('GET /sections/{id}/grading_categories', `/sections/${testSectionId}/grading_categories`, { detail: true });
    await testEndpoint('GET /sections/{id}/grading_periods', `/sections/${testSectionId}/grading_periods`, { detail: true });
    await testEndpoint('GET /sections/{id}/grading_groups', `/sections/${testSectionId}/grading_groups`, { detail: true });
    await testEndpoint('GET /sections/{id}/grading_rubrics', `/sections/${testSectionId}/grading_rubrics`, { detail: true });
    await testEndpoint('GET /sections/{id}/final_grades', `/sections/${testSectionId}/final_grades`, { detail: true });
    await testEndpoint('GET /sections/{id}/mastery', `/sections/${testSectionId}/mastery`, { detail: true });

    divider('SECTION - PEOPLE');

    await testEndpoint('GET /sections/{id}/enrollments', `/sections/${testSectionId}/enrollments`, { detail: true });
    await testEndpoint('GET /sections/{id}/members', `/sections/${testSectionId}/members`, { detail: true });

    divider('SECTION - ATTENDANCE');

    await testEndpoint('GET /sections/{id}/attendance', `/sections/${testSectionId}/attendance`, { detail: true });
    await testEndpoint('GET /sections/{id}/attendance/summary', `/sections/${testSectionId}/attendance/summary`, { detail: true });

    divider('SECTION - SUBMISSIONS');

    if (testAssignmentId && testStudentUid) {
      await testEndpoint('GET /sections/{id}/submissions/{aid}/{uid}', `/sections/${testSectionId}/submissions/${testAssignmentId}/${testStudentUid}`, { detail: true });
      await testEndpoint('GET /sections/{id}/submissions/{aid}/{uid}/comments', `/sections/${testSectionId}/submissions/${testAssignmentId}/${testStudentUid}/comments`, { detail: true });
    }

    divider('SECTION - COMPLETION & RULES');

    await testEndpoint('GET /sections/{id}/completion', `/sections/${testSectionId}/completion`, { detail: true });
    await testEndpoint('GET /sections/{id}/completion/user/{uid}', `/sections/${testSectionId}/completion/user/${testStudentUid}`, { detail: true });
    await testEndpoint('GET /sections/{id}/rules', `/sections/${testSectionId}/rules`, { detail: true });

    divider('SECTION - STANDARDS & RUBRICS (sub-resources)');

    await testEndpoint('GET /sections/{id}/standards', `/sections/${testSectionId}/standards`, { detail: true });
    await testEndpoint('GET /sections/{id}/outcomes', `/sections/${testSectionId}/outcomes`, { detail: true });
    await testEndpoint('GET /sections/{id}/learning_objectives', `/sections/${testSectionId}/learning_objectives`, { detail: true });
    await testEndpoint('GET /sections/{id}/alignments', `/sections/${testSectionId}/alignments`, { detail: true });
    await testEndpoint('GET /sections/{id}/rubrics', `/sections/${testSectionId}/rubrics`, { detail: true });

    divider('ASSIGNMENT SUB-RESOURCES');

    if (testAssignmentId) {
      await testEndpoint('GET /sections/{id}/assignments/{aid}/grades', `/sections/${testSectionId}/assignments/${testAssignmentId}/grades`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/comments', `/sections/${testSectionId}/assignments/${testAssignmentId}/comments`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/rubric', `/sections/${testSectionId}/assignments/${testAssignmentId}/rubric`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/standards', `/sections/${testSectionId}/assignments/${testAssignmentId}/standards`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/alignments', `/sections/${testSectionId}/assignments/${testAssignmentId}/alignments`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/learning_objectives', `/sections/${testSectionId}/assignments/${testAssignmentId}/learning_objectives`, { detail: true });
      await testEndpoint('GET /sections/{id}/assignments/{aid}/criteria', `/sections/${testSectionId}/assignments/${testAssignmentId}/criteria`, { detail: true });
    }

    divider('ALL SECTIONS - CROSS-CHECK');

    // Test a few endpoints on a second section to see if access varies
    if (sections.length > 1) {
      const sec2 = sections[1].id;
      console.log(`  (Testing against second section: ${sections[1].course_title} / ${sec2})`);
      await testEndpoint('GET /sections/{id2}/grading_rubrics', `/sections/${sec2}/grading_rubrics`, { detail: true });
      await testEndpoint('GET /sections/{id2}/attendance', `/sections/${sec2}/attendance`, { detail: true });
      await testEndpoint('GET /sections/{id2}/final_grades', `/sections/${sec2}/final_grades`, { detail: true });
      await testEndpoint('GET /sections/{id2}/mastery', `/sections/${sec2}/mastery`, { detail: true });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  COURSE ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'course') {
    divider('COURSE ENDPOINTS');

    if (testCourseId) {
      await testEndpoint('GET /courses/{id}', `/courses/${testCourseId}`, { detail: true });
      await testEndpoint('GET /courses/{id}/sections', `/courses/${testCourseId}/sections`, { detail: true });
      await testEndpoint('GET /courses/{id}/grading_rubrics', `/courses/${testCourseId}/grading_rubrics`, { detail: true });
      await testEndpoint('GET /courses/{id}/grading_scales', `/courses/${testCourseId}/grading_scales`, { detail: true });
      await testEndpoint('GET /courses/{id}/grading_categories', `/courses/${testCourseId}/grading_categories`, { detail: true });
      await testEndpoint('GET /courses/{id}/standards', `/courses/${testCourseId}/standards`, { detail: true });
      await testEndpoint('GET /courses/{id}/outcomes', `/courses/${testCourseId}/outcomes`, { detail: true });
      await testEndpoint('GET /courses/{id}/learning_objectives', `/courses/${testCourseId}/learning_objectives`, { detail: true });
      await testEndpoint('GET /courses/{id}/folders', `/courses/${testCourseId}/folders`, { detail: true });
      await testEndpoint('GET /courses/{id}/assignments', `/courses/${testCourseId}/assignments`, { detail: true });
      await testEndpoint('GET /courses/{id}/events', `/courses/${testCourseId}/events`, { detail: true });
    }

    // Global courses list
    await testEndpoint('GET /courses', '/courses', { detail: true });
    await testEndpoint('GET /courses?building_id=...', `/courses?building_id=${testSchoolId}`, { detail: true });
  }

  // ═══════════════════════════════════════════════════════
  //  SCHOOL / DISTRICT ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'school') {
    divider('SCHOOL ENDPOINTS');

    await testEndpoint('GET /schools', '/schools', { detail: true });

    if (testSchoolId) {
      await testEndpoint('GET /schools/{id}', `/schools/${testSchoolId}`, { detail: true });
      await testEndpoint('GET /schools/{id}/buildings', `/schools/${testSchoolId}/buildings`, { detail: true });
      await testEndpoint('GET /schools/{id}/courses', `/schools/${testSchoolId}/courses`, { detail: true });
      await testEndpoint('GET /schools/{id}/sections', `/schools/${testSchoolId}/sections`, { detail: true });
      await testEndpoint('GET /schools/{id}/users', `/schools/${testSchoolId}/users`, { detail: true });
      await testEndpoint('GET /schools/{id}/enrollments', `/schools/${testSchoolId}/enrollments`, { detail: true });
      await testEndpoint('GET /schools/{id}/events', `/schools/${testSchoolId}/events`, { detail: true });
      await testEndpoint('GET /schools/{id}/grading_periods', `/schools/${testSchoolId}/grading_periods`, { detail: true });
    }

    // District
    await testEndpoint('GET /districts', '/districts', { detail: true });

    // Roles
    await testEndpoint('GET /roles', '/roles', { detail: true });
  }

  // ═══════════════════════════════════════════════════════
  //  GROUP ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'group') {
    divider('GROUP ENDPOINTS');

    await testEndpoint('GET /groups', '/groups', { detail: true });
    await testEndpoint('GET /users/{uid}/groups', `/users/${myId}/groups`, { detail: true });

    // If we find any groups, test group sub-endpoints
    const groupsRes = await throttledGet(`/users/${myId}/groups`);
    const groups = groupsRes.data?.group || [];
    if (groups.length > 0) {
      const testGroupId = groups[0].id;
      console.log(`  (Testing group: ${groups[0].title} / ${testGroupId})`);
      await testEndpoint('GET /groups/{id}', `/groups/${testGroupId}`, { detail: true });
      await testEndpoint('GET /groups/{id}/members', `/groups/${testGroupId}/members`, { detail: true });
      await testEndpoint('GET /groups/{id}/updates', `/groups/${testGroupId}/updates`, { detail: true });
      await testEndpoint('GET /groups/{id}/events', `/groups/${testGroupId}/events`, { detail: true });
      await testEndpoint('GET /groups/{id}/discussions', `/groups/${testGroupId}/discussions`, { detail: true });
      await testEndpoint('GET /groups/{id}/documents', `/groups/${testGroupId}/documents`, { detail: true });
      await testEndpoint('GET /groups/{id}/folders', `/groups/${testGroupId}/folders`, { detail: true });
    } else {
      console.log('  (No groups found, skipping group sub-endpoints)');
    }
  }

  // ═══════════════════════════════════════════════════════
  //  MESSAGING ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'messaging') {
    divider('MESSAGING ENDPOINTS');

    await testEndpoint('GET /messages/inbox', '/messages/inbox', { detail: true });
    await testEndpoint('GET /messages/sent', '/messages/sent', { detail: true });
    await testEndpoint('GET /messages', '/messages', { detail: true });
  }

  // ═══════════════════════════════════════════════════════
  //  MISCELLANEOUS ENDPOINTS
  // ═══════════════════════════════════════════════════════
  if (category === 'all' || category === 'misc') {
    divider('MISCELLANEOUS ENDPOINTS');

    await testEndpoint('GET /app-user-info', '/app-user-info', { detail: true });
    await testEndpoint('GET /search?keywords=test', '/search?keywords=test', { detail: true });
    await testEndpoint('GET /standards', '/standards', { detail: true });
    await testEndpoint('GET /grading_scales', '/grading_scales', { detail: true });
    await testEndpoint('GET /grading_periods', '/grading_periods', { detail: true });
    await testEndpoint('GET /analytics', '/analytics', { detail: true });
    await testEndpoint('GET /analytics/users', '/analytics/users', { detail: true });
    await testEndpoint('GET /realms', '/realms', { detail: true });
    await testEndpoint('GET /resources', '/resources', { detail: true });
    await testEndpoint('GET /likes', '/likes', { detail: true });

    // Blog endpoints
    await testEndpoint('GET /blogs', '/blogs', { detail: true });

    // Attendance global
    await testEndpoint('GET /attendance', '/attendance', { detail: true });

    // Multiget
    await testEndpoint('GET /multiget (empty)', '/multiget', { detail: true });
  }

  // ═══════════════════════════════════════════════════════
  //  SUMMARY REPORT
  // ═══════════════════════════════════════════════════════
  divider('DISCOVERY SUMMARY');

  const working = results.filter(r => r.hasData);
  const forbidden = results.filter(r => r.status === 403);
  const notFound = results.filter(r => r.status === 404);
  const misleading = results.filter(r => r.misleading);
  const badRequest = results.filter(r => r.status === 400);
  const other = results.filter(r => !r.hasData && !r.misleading && ![403, 404, 400, -1].includes(r.status));

  console.log(`\nTotal endpoints tested: ${results.length}`);
  console.log(`  Working (200 with data): ${working.length}`);
  console.log(`  Forbidden (403):         ${forbidden.length}`);
  console.log(`  Not Found (404):         ${notFound.length}`);
  console.log(`  Misleading (200 wrong):  ${misleading.length}`);
  console.log(`  Bad Request (400):       ${badRequest.length}`);
  console.log(`  Other:                   ${other.length}`);

  console.log('\n── WORKING ENDPOINTS ──');
  for (const r of working) {
    console.log(`  ✅ ${r.label}`);
    if (r.topKeys) console.log(`     Keys: ${r.topKeys.join(', ')}`);
  }

  console.log('\n── FORBIDDEN ENDPOINTS ──');
  for (const r of forbidden) {
    console.log(`  🔒 ${r.label}`);
  }

  console.log('\n── NOT FOUND ENDPOINTS ──');
  for (const r of notFound) {
    console.log(`  ❌ ${r.label}`);
  }

  console.log('\n── MISLEADING ENDPOINTS ──');
  for (const r of misleading) {
    console.log(`  ⚠️  ${r.label}`);
  }

  if (other.length > 0) {
    console.log('\n── OTHER ──');
    for (const r of other) {
      console.log(`  ⚡ ${r.label} (${r.status})`);
    }
  }

  // Write raw results to JSON for later analysis
  const outputPath = 'api-discovery-results.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${outputPath}`);
  console.log(`Total API requests made: ${requestCount}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
