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

// Two-legged OAuth: empty token
const token = { key: '', secret: '' };

async function apiGet(path) {
  let url = `${API}${path}`;
  // Follow redirects manually so each request gets fresh OAuth headers
  for (let i = 0; i < 5; i++) {
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'GET' }, token));
    const res = await fetch(url, {
      headers: { ...authHeader, 'Accept': 'application/json' },
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

async function apiPost(path, body) {
  const url = `${API}${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, url };
}

function divider(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function printResult({ status, data, url }) {
  console.log(`URL: ${url}`);
  console.log(`Status: ${status}`);
  console.log(JSON.stringify(data, null, 2));
}

async function run() {
  // ── Step 1: My user profile ──
  divider('Step 1: GET /users/me');
  const me = await apiGet('/users/me');
  printResult(me);

  if (me.status !== 200) {
    console.log('\n❌ Cannot authenticate. Check credentials. Stopping.');
    process.exit(1);
  }

  if (typeof me.data === 'string') {
    console.log('\n⚠️  Response is not JSON (likely XML). Raw body (first 500 chars):');
    console.log(me.data.substring(0, 500));
    // Try to extract uid from XML
    const uidMatch = me.data.match(/<uid>(\d+)<\/uid>/);
    if (!uidMatch) {
      console.log('❌ Cannot extract user ID. Stopping.');
      process.exit(1);
    }
    me.data = { id: uidMatch[1] };
    console.log(`→ Extracted user ID from XML: ${me.data.id}`);
  }

  const myId = me.data.id;
  console.log(`\n→ My user ID: ${myId}`);

  // ── Step 2: My course sections ──
  divider('Step 2: GET /users/{id}/sections');
  const sections = await apiGet(`/users/${myId}/sections`);
  printResult(sections);

  const sectionList = sections.data?.section || [];
  if (sectionList.length === 0) {
    console.log('\n⚠️  No sections found. Stopping.');
    process.exit(0);
  }

  // Pick the first section for further testing
  const testSection = sectionList[0];
  console.log(`\n→ Using section: "${testSection.course_title}" (id: ${testSection.id})`);

  // ── Step 3: Assignments for that section ──
  divider('Step 3: GET /sections/{id}/assignments');
  const assignments = await apiGet(`/sections/${testSection.id}/assignments`);
  printResult(assignments);

  const assignmentList = assignments.data?.assignment || [];
  if (assignmentList.length === 0) {
    console.log('\n⚠️  No assignments in this section.');
  }

  // ── Step 4: Grades for one assignment — check for comment field ──
  // Use the target assignment ID from the URL: 8323446396
  const targetAssignmentId = '8323446396';

  // First, figure out which section this assignment belongs to.
  // Try fetching grades for the target assignment across our sections.
  divider('Step 4: Grades for assignment 8323446396');

  let gradesResult = null;
  let gradeSectionId = null;

  // Try to find which section owns this assignment
  for (const sec of sectionList) {
    const attempt = await apiGet(`/sections/${sec.id}/grades`);
    if (attempt.status === 200) {
      // Check if this section has our target assignment in its grade columns
      const grades = attempt.data;
      // Schoology nests grades in section > period > assignment
      const hasAssignment = JSON.stringify(grades).includes(targetAssignmentId);
      if (hasAssignment) {
        gradeSectionId = sec.id;
        gradesResult = attempt;
        console.log(`→ Found assignment in section: "${sec.course_title}" (id: ${sec.id})`);
        break;
      }
    }
  }

  if (!gradesResult) {
    // Fallback: try a direct assignment endpoint
    console.log('→ Searching sections did not find the assignment. Trying direct grade fetch...');
    // Try each section's assignment-specific grades
    for (const sec of sectionList) {
      const attempt = await apiGet(`/sections/${sec.id}/assignments/${targetAssignmentId}`);
      if (attempt.status === 200) {
        gradeSectionId = sec.id;
        console.log(`→ Assignment belongs to section: "${sec.course_title}" (id: ${sec.id})`);
        break;
      }
    }
  }

  if (gradeSectionId) {
    // Try multiple grade endpoints to see what works
    const gradeEndpoints = [
      `/sections/${gradeSectionId}/grades`,
      `/sections/${gradeSectionId}/assignments/${targetAssignmentId}/grades`,
      `/sections/${gradeSectionId}/grades?assignment_id=${targetAssignmentId}`,
    ];

    let gradeEntries = [];
    for (const ep of gradeEndpoints) {
      console.log(`\nTrying: GET ${ep}`);
      const result = await apiGet(ep);
      console.log(`  Status: ${result.status}`);

      if (result.status === 200) {
        // Parse the section grades response to find our assignment
        const raw = result.data;
        // Section grades structure: { section: [ { period: [ { assignment: [ { grade... } ] } ] } ] }
        // Or: { grades: { grade: [...] } }
        const jsonStr = JSON.stringify(raw);

        // Look for grade entries
        const grades = raw?.grades?.grade || [];
        if (grades.length > 0) {
          gradeEntries = grades;
          console.log(`  → Found ${grades.length} grade entries`);
          console.log('  → Sample grade keys:', Object.keys(grades[0]));
          console.log('  → Has "comment" field:', 'comment' in grades[0]);
          console.log('  → Has "comment_status" field:', 'comment_status' in grades[0]);
          console.log('  → Sample entry:', JSON.stringify(grades[0], null, 4));
          break;
        }

        // Try section-level format
        const sectionGrades = raw?.section || [];
        if (sectionGrades.length > 0) {
          console.log(`  → Section-level grades response. Top keys:`, Object.keys(raw));
          // Find our assignment in the nested structure
          const found = jsonStr.includes(targetAssignmentId);
          console.log(`  → Contains target assignment ${targetAssignmentId}: ${found}`);
          // Print a trimmed sample
          const sample = JSON.stringify(raw, null, 2).substring(0, 1500);
          console.log(`  → Sample (first 1500 chars):\n${sample}`);

          // Extract grade entries for our assignment
          for (const sec of sectionGrades) {
            for (const period of (sec.period || [])) {
              for (const assign of (period.assignment || [])) {
                if (String(assign.assignment_id) === targetAssignmentId) {
                  gradeEntries = [assign];
                  console.log(`\n  → Found grade for assignment!`);
                  console.log('  → Keys:', Object.keys(assign));
                  console.log('  → Has "comment" field:', 'comment' in assign);
                  console.log('  → Full entry:', JSON.stringify(assign, null, 4));
                }
              }
            }
          }
          if (gradeEntries.length > 0) break;
        }

        // If we got data but couldn't parse, show raw structure
        if (gradeEntries.length === 0) {
          console.log(`  → Response keys:`, typeof raw === 'object' ? Object.keys(raw) : typeof raw);
          const sample = JSON.stringify(raw, null, 2).substring(0, 2000);
          console.log(`  → Data (first 2000 chars):\n${sample}`);
        }
      }
    }

    // ── Step 4b: Get section enrollments to find student UIDs ──
    divider('Step 4b: Section enrollments');
    const enrollments = await apiGet(`/sections/${gradeSectionId}/enrollments`);
    console.log(`Status: ${enrollments.status}`);
    const enrollmentList = enrollments.data?.enrollment || [];
    console.log(`→ Found ${enrollmentList.length} enrollments`);
    const studentEnrollments = enrollmentList.filter(e => e.uid && e.admin !== '1' && e.admin !== 1);
    console.log(`→ Student enrollments: ${studentEnrollments.length}`);
    if (studentEnrollments.length > 0) {
      const firstStudent = studentEnrollments[0];
      console.log(`→ First student UID: ${firstStudent.uid}`);

      // ── Step 5: Submission comments for one student ──
      divider('Step 5: Submission comments');

      // Try various comment endpoints
      const commentEndpoints = [
        { label: 'Assignment comments', path: `/sections/${gradeSectionId}/assignments/${targetAssignmentId}/comments` },
        { label: 'Submission comments (revision 0)', path: `/sections/${gradeSectionId}/submissions/${targetAssignmentId}/${firstStudent.uid}/comments` },
        { label: 'Grade comment for student', path: `/sections/${gradeSectionId}/grades?assignment_id=${targetAssignmentId}&uid=${firstStudent.uid}` },
      ];

      for (const ep of commentEndpoints) {
        console.log(`\n${ep.label}:`);
        const result = await apiGet(ep.path);
        printResult(result);
      }

      // ── Step 6: POST a test grade comment ──
      divider('Step 6: POST grade comment to assignment 8323446396');
      console.log(`→ Target student UID: ${firstStudent.uid}`);
      console.log(`→ Target section: ${gradeSectionId}`);

      // Method A: POST a submission comment
      console.log('\n--- Method A: POST submission comment ---');
      const commentPostA = await apiPost(
        `/sections/${gradeSectionId}/submissions/${targetAssignmentId}/${firstStudent.uid}/comments`,
        { comment: { comment: 'Wonderful reflection!' } }
      );
      console.log('Result:');
      printResult(commentPostA);

      // Method B: PUT grade with comment field
      console.log('\n--- Method B: PUT grade comment ---');
      const gradeUrl = `${API}/sections/${gradeSectionId}/assignments/${targetAssignmentId}/grades/${firstStudent.uid}`;
      const authHeader = oauth.toHeader(oauth.authorize({ url: gradeUrl, method: 'PUT' }, token));
      const putRes = await fetch(gradeUrl, {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ grade: { comment: 'Wonderful reflection!' } }),
      });
      const putText = await putRes.text();
      let putData;
      try { putData = JSON.parse(putText); } catch { putData = putText; }
      console.log(`URL: ${gradeUrl}`);
      console.log(`Status: ${putRes.status}`);
      console.log(JSON.stringify(putData, null, 2));

      // Method C: POST assignment comment (discussion-style)
      console.log('\n--- Method C: POST assignment-level comment ---');
      const commentPostC = await apiPost(
        `/sections/${gradeSectionId}/assignments/${targetAssignmentId}/comments`,
        { comment: { comment: 'Wonderful reflection!', uid: firstStudent.uid } }
      );
      console.log('Result:');
      printResult(commentPostC);
    }
  } else {
    console.log('\n⚠️  Could not locate assignment 8323446396 in any section.');
    console.log('Listing all section IDs for reference:');
    sectionList.forEach(s => console.log(`  - ${s.id}: ${s.course_title}`));
  }

  // ── Summary ──
  divider('Endpoint Map Summary');
  console.log(`
Endpoints tested:
  GET  /v1/users/me                                          → User profile
  GET  /v1/users/{id}/sections                               → Course sections list
  GET  /v1/sections/{id}/assignments                         → Assignments in a section
  GET  /v1/sections/{id}/grades                              → All grades in a section
  GET  /v1/sections/{id}/assignments/{aid}/grades            → Grades for one assignment
  GET  /v1/sections/{id}/assignments/{aid}/comments          → Assignment-level comments
  GET  /v1/sections/{id}/submissions/{aid}/{uid}/comments    → Per-student submission comments
  POST /v1/sections/{id}/submissions/{aid}/{uid}/comments    → Post a submission comment
  PUT  /v1/sections/{id}/assignments/{aid}/grades/{uid}      → Update grade (with comment)
`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
