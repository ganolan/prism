/**
 * Deep-dive on newly discovered working endpoints from the discovery scan.
 * Prints full response samples for documentation.
 *
 * Usage: node test-api-deepdive.js
 */

import 'dotenv/config';
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
    return { status: res.status, data };
  }
  return { status: 0, data: 'Too many redirects' };
}

function divider(title) {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(70));
}

function printSample(data, label = '', maxItems = 2) {
  if (label) console.log(`  ${label}:`);
  if (Array.isArray(data)) {
    console.log(`  [Array of ${data.length} items]`);
    data.slice(0, maxItems).forEach((item, i) => {
      console.log(`  --- Item ${i} ---`);
      console.log(JSON.stringify(item, null, 2).split('\n').map(l => '  ' + l).join('\n'));
    });
  } else {
    const str = JSON.stringify(data, null, 2);
    // Truncate very long output
    if (str.length > 3000) {
      console.log(str.substring(0, 3000) + '\n  ... [truncated]');
    } else {
      console.log(str.split('\n').map(l => '  ' + l).join('\n'));
    }
  }
}

// Use a CS course section for more relevant data
const CS_SECTIONS = {
  ACSS: '7899896098',
  AIML: '7899907727',
  APCSP: '7899896088',
  MAD: '7899907701',
  ROB: '7899907720',
};

async function run() {
  const me = await apiGet('/users/me');
  const myId = me.data.id;
  console.log(`UID: ${myId}`);

  // Use ACSS as primary test section
  const sectionId = CS_SECTIONS.ACSS;
  console.log(`Primary test section: ACSS (${sectionId})`);

  // Get test IDs
  const assignRes = await apiGet(`/sections/${sectionId}/assignments?limit=3`);
  const assignments = assignRes.data?.assignment || [];
  const testAssignmentId = assignments[0]?.id;
  console.log(`Test assignment: ${testAssignmentId} (${assignments[0]?.title})`);

  const enrollRes = await apiGet(`/sections/${sectionId}/enrollments?limit=50`);
  const students = (enrollRes.data?.enrollment || []).filter(e => e.admin !== 1 && e.admin !== '1');
  const testStudentUid = students[0]?.uid;
  console.log(`Test student: ${testStudentUid}`);

  // ─── 1. Section object (GET /sections/{id}) ───
  divider('1. GET /sections/{id} — Section detail');
  const sectionDetail = await apiGet(`/sections/${sectionId}`);
  printSample(sectionDetail.data);

  // ─── 2. Section updates (feed posts) ───
  divider('2. GET /sections/{id}/updates — Feed/updates');
  const updates = await apiGet(`/sections/${sectionId}/updates`);
  console.log(`  Status: ${updates.status}`);
  printSample(updates.data?.update || [], 'Updates', 1);

  // ─── 3. Section documents ───
  divider('3. GET /sections/{id}/documents — Course materials');
  const docs = await apiGet(`/sections/${sectionId}/documents`);
  console.log(`  Status: ${docs.status}, Total: ${docs.data?.total}`);
  printSample(docs.data?.document || [], 'Documents', 2);

  // ─── 4. Section discussions ───
  divider('4. GET /sections/{id}/discussions — Discussions');
  const discussions = await apiGet(`/sections/${sectionId}/discussions`);
  console.log(`  Status: ${discussions.status}, Total: ${discussions.data?.total}`);
  printSample(discussions.data?.discussion || [], 'Discussions', 1);

  // ─── 5. Section pages ───
  divider('5. GET /sections/{id}/pages — Pages');
  const pages = await apiGet(`/sections/${sectionId}/pages`);
  console.log(`  Status: ${pages.status}, Total: ${pages.data?.total}`);
  printSample(pages.data?.page || [], 'Pages', 1);

  // ─── 6. Section events ───
  divider('6. GET /sections/{id}/events — Events/calendar');
  const events = await apiGet(`/sections/${sectionId}/events`);
  console.log(`  Status: ${events.status}, Total: ${events.data?.total}`);
  printSample(events.data?.event || [], 'Events', 1);

  // ─── 7. Section folders ───
  divider('7. GET /sections/{id}/folders — Folder structure');
  const folders = await apiGet(`/sections/${sectionId}/folders`);
  console.log(`  Status: ${folders.status}, Total: ${folders.data?.total}`);
  printSample(folders.data?.folder || folders.data, 'Folders');

  // ─── 8. Section completion ───
  divider('8. GET /sections/{id}/completion — Completion tracking');
  const completion = await apiGet(`/sections/${sectionId}/completion`);
  console.log(`  Status: ${completion.status}, Total: ${completion.data?.total}`);
  printSample(completion.data?.completion || [], 'Completion', 2);

  // ─── 9. Completion per user ───
  if (testStudentUid) {
    divider('9. GET /sections/{id}/completion/user/{uid}');
    const userCompletion = await apiGet(`/sections/${sectionId}/completion/user/${testStudentUid}`);
    console.log(`  Status: ${userCompletion.status}`);
    printSample(userCompletion.data);
  }

  // ─── 10. Submissions detail ───
  if (testAssignmentId && testStudentUid) {
    divider('10. GET /sections/{id}/submissions/{aid}/{uid} — Submission revisions');
    const sub = await apiGet(`/sections/${sectionId}/submissions/${testAssignmentId}/${testStudentUid}`);
    console.log(`  Status: ${sub.status}`);
    printSample(sub.data);
  }

  // ─── 11. User events ───
  divider('11. GET /users/{uid}/events — Calendar events');
  const userEvents = await apiGet(`/users/${myId}/events?limit=3`);
  console.log(`  Status: ${userEvents.status}, Total: ${userEvents.data?.total}`);
  printSample(userEvents.data?.event || [], 'Events', 1);

  // ─── 12. User grades ───
  divider('12. GET /users/{uid}/grades — User grade overview');
  const userGrades = await apiGet(`/users/${myId}/grades`);
  console.log(`  Status: ${userGrades.status}`);
  printSample(userGrades.data);

  // ─── 13. Messaging ───
  divider('13. GET /messages/inbox — Messages inbox');
  const inbox = await apiGet('/messages/inbox?limit=2');
  console.log(`  Status: ${inbox.status}, Unread: ${inbox.data?.unread_count}`);
  printSample(inbox.data?.message || [], 'Messages', 1);

  divider('14. GET /messages/sent — Messages sent');
  const sent = await apiGet('/messages/sent?limit=2');
  console.log(`  Status: ${sent.status}`);
  printSample(sent.data?.message || [], 'Messages', 1);

  // ─── 15. Groups ───
  divider('15. GET /groups — All groups');
  const groups = await apiGet('/groups?limit=5');
  console.log(`  Status: ${groups.status}, Total: ${groups.data?.total}`);
  printSample(groups.data?.group || [], 'Groups', 2);

  // ─── 16. Group updates ───
  const myGroups = await apiGet(`/users/${myId}/groups`);
  const userGroupList = myGroups.data?.group || [];
  if (userGroupList.length > 0) {
    const gid = userGroupList[0].id;
    divider(`16. GET /groups/{id}/updates (group: ${userGroupList[0].title})`);
    const gUpdates = await apiGet(`/groups/${gid}/updates?limit=2`);
    console.log(`  Status: ${gUpdates.status}`);
    printSample(gUpdates.data?.update || [], 'Updates', 1);

    divider(`17. GET /groups/{id}/discussions`);
    const gDisc = await apiGet(`/groups/${gid}/discussions`);
    console.log(`  Status: ${gDisc.status}, Total: ${gDisc.data?.total}`);
    printSample(gDisc.data?.discussion || [], 'Discussions', 1);
  }

  // ─── 18. Courses ───
  divider('18. GET /courses/{id}/sections');
  // Get course_id from sections list
  const sectionsRes = await apiGet(`/users/${myId}/sections`);
  const sectionsList = sectionsRes.data?.section || [];
  const acssSection = sectionsList.find(s => s.id === sectionId);
  const courseId = acssSection?.course_id || acssSection?.course_nid;
  if (courseId) {
    const courseSections = await apiGet(`/courses/${courseId}/sections`);
    console.log(`  Status: ${courseSections.status}`);
    printSample(courseSections.data?.section || [], 'Sections', 2);
  }

  // ─── 19. Mastery endpoint (deeper look) ───
  divider('19. GET /sections/{id}/mastery — Mastery detail');
  const mastery = await apiGet(`/sections/${sectionId}/mastery`);
  console.log(`  Status: ${mastery.status}, Total: ${mastery.data?.total}`);
  // Show period structure
  if (mastery.data?.period) {
    console.log(`  Periods: ${mastery.data.period.length}`);
    printSample(mastery.data.period, 'Period structure', 1);
  }
  if (mastery.data?.final_grade) {
    console.log(`  Final grades: ${mastery.data.final_grade.length}`);
    printSample(mastery.data.final_grade, 'Final grade entries', 2);
  }

  // ─── 20. Final grades (direct GET, is it really misleading?) ───
  divider('20. GET /sections/{id}/final_grades — verify response');
  const finalGrades = await apiGet(`/sections/${sectionId}/final_grades`);
  console.log(`  Status: ${finalGrades.status}`);
  const fgKeys = typeof finalGrades.data === 'object' ? Object.keys(finalGrades.data) : [];
  console.log(`  Top-level keys: ${fgKeys.join(', ')}`);
  // Check if it has grade data or just section info
  if (finalGrades.data?.final_grade) {
    console.log('  Has final_grade array');
    printSample(finalGrades.data.final_grade, 'Final grades', 2);
  } else if (finalGrades.data?.course_title || finalGrades.data?.id) {
    console.log('  Returns section/course object — misleading');
  } else {
    printSample(finalGrades.data, 'Raw data');
  }

  // ─── 21. Schools/{id} sub-endpoints (verify misleading) ───
  divider('21. GET /schools/{id}/courses — verify response');
  const schoolCourses = await apiGet('/schools/94044023/courses');
  console.log(`  Status: ${schoolCourses.status}`);
  const scKeys = typeof schoolCourses.data === 'object' ? Object.keys(schoolCourses.data) : [];
  console.log(`  Top-level keys: ${scKeys.join(', ')}`);
  if (schoolCourses.data?.course) {
    console.log(`  Has course array: ${schoolCourses.data.course.length} items`);
    printSample(schoolCourses.data.course, 'Courses', 1);
  } else if (schoolCourses.data?.title) {
    console.log('  Returns school object — misleading');
  }

  divider('22. GET /schools/{id}/users — verify response');
  const schoolUsers = await apiGet('/schools/94044023/users?limit=3');
  console.log(`  Status: ${schoolUsers.status}`);
  const suKeys = typeof schoolUsers.data === 'object' ? Object.keys(schoolUsers.data) : [];
  console.log(`  Top-level keys: ${suKeys.join(', ')}`);
  if (schoolUsers.data?.user) {
    console.log(`  Has user array: ${schoolUsers.data.user.length} items`);
  } else if (schoolUsers.data?.title) {
    console.log('  Returns school object — misleading');
  }

  // ─── 23. Enrollment detail ───
  divider('23. Enrollment detail — sample fields');
  if (students.length > 0) {
    printSample(students[0], 'Student enrollment');
    // Check if admin enrollments have different fields
    const admins = (enrollRes.data?.enrollment || []).filter(e => e.admin === 1 || e.admin === '1');
    if (admins.length > 0) {
      printSample(admins[0], 'Admin enrollment');
    }
  }

  // ─── 24. Grades structure ───
  divider('24. GET /sections/{id}/grades — full structure');
  const grades = await apiGet(`/sections/${sectionId}/grades`);
  console.log(`  Status: ${grades.status}`);
  if (grades.data?.grades?.grade) {
    const gradeList = grades.data.grades.grade;
    console.log(`  Total grade entries: ${gradeList.length}`);
    printSample(gradeList.slice(0, 2), 'Grade entries');
  }
  if (grades.data?.final_grade) {
    console.log(`  Final grade entries: ${grades.data.final_grade.length}`);
    printSample(grades.data.final_grade.slice(0, 2), 'Final grades');
  }

  // ─── 25. Roles ───
  divider('25. GET /roles — all role definitions');
  const roles = await apiGet('/roles');
  printSample(roles.data?.role || [], 'Roles', 8);

  // ─── 26. Assignment fields ───
  divider('26. Assignment object — full fields');
  if (assignments.length > 0) {
    printSample(assignments[0], 'Assignment');
  }

  // ─── 27. Test pagination ───
  divider('27. Pagination test on /sections/{id}/enrollments');
  const page1 = await apiGet(`/sections/${sectionId}/enrollments?start=0&limit=5`);
  console.log(`  Page 1: ${page1.data?.enrollment?.length} items, total: ${page1.data?.total}`);
  console.log(`  Links: ${JSON.stringify(page1.data?.links)}`);
  if (page1.data?.links?.next) {
    const page2 = await apiGet(`/sections/${sectionId}/enrollments?start=5&limit=5`);
    console.log(`  Page 2: ${page2.data?.enrollment?.length} items`);
  }

  console.log('\n\nDone!');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
