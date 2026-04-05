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
  let url = `${API}${path}`;
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
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, url };
  }
  return { status: 0, data: 'Too many redirects', url };
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
  return { status: res.status, data, url };
}

const TARGET_ASSIGNMENT = '8323446396';

async function run() {
  // Step 1: Get my user ID
  console.log('Authenticating...');
  const me = await apiGet('/users/me');
  if (me.status !== 200) {
    console.log('Auth failed:', me.status);
    process.exit(1);
  }
  const myId = typeof me.data === 'string'
    ? me.data.match(/<uid>(\d+)<\/uid>/)?.[1]
    : me.data.id;
  console.log(`User ID: ${myId}\n`);

  // Step 2: Find which section owns this assignment
  const sections = await apiGet(`/users/${myId}/sections`);
  const sectionList = sections.data?.section || [];

  let sectionId = null;
  for (const sec of sectionList) {
    const check = await apiGet(`/sections/${sec.id}/assignments/${TARGET_ASSIGNMENT}`);
    if (check.status === 200) {
      sectionId = sec.id;
      console.log(`Assignment found in: "${sec.course_title}" (section ${sec.id})\n`);
      break;
    }
  }

  if (!sectionId) {
    console.log('Could not find assignment in any section.');
    process.exit(1);
  }

  // Step 3: Get ALL enrollments (paginated) to map UIDs to names
  let enrollmentList = [];
  let start = 0;
  const limit = 100;
  while (true) {
    const page = await apiGet(`/sections/${sectionId}/enrollments?start=${start}&limit=${limit}`);
    const pageList = page.data?.enrollment || [];
    enrollmentList = enrollmentList.concat(pageList);
    if (pageList.length < limit) break;
    start += limit;
  }
  const students = enrollmentList.filter(e => e.admin !== '1' && e.admin !== 1);

  // Build UID -> name map (index by both uid and id/enrollment_id)
  const nameMap = {};
  for (const s of enrollmentList) {
    nameMap[s.uid] = `${s.name_first} ${s.name_last}`;
    if (s.id) nameMap[s.id] = `${s.name_first} ${s.name_last}`;
  }

  // Step 4: Get section-level grades (which include comment fields)
  console.log('Fetching section grades...\n');
  const grades = await apiGet(`/sections/${sectionId}/grades`);

  if (grades.status !== 200) {
    console.log('Failed to fetch grades:', grades.status);
    process.exit(1);
  }

  // Parse grades — flat structure: grades.grades.grade[]
  const allGrades = grades.data?.grades?.grade || [];
  const assignmentGrades = allGrades.filter(g => String(g.assignment_id) === TARGET_ASSIGNMENT);

  console.log(`${'='.repeat(60)}`);
  console.log(`  Grade comments for assignment ${TARGET_ASSIGNMENT}`);
  console.log(`${'='.repeat(60)}\n`);

  if (assignmentGrades.length === 0) {
    console.log('No grades found for this assignment.');
    console.log('Total grades in section:', allGrades.length);
    process.exit(1);
  }

  let henryUid = null;
  let henryGrade = null;

  for (const g of assignmentGrades) {
    const name = nameMap[g.enrollment_id] || nameMap[g.uid] || `UID:${g.enrollment_id || g.uid}`;
    const comment = g.comment || '(no comment)';
    const grade = g.grade || '(no grade)';
    console.log(`  ${name.padEnd(25)} Grade: ${String(grade).padEnd(6)} Comment: ${comment}`);

    // Find Henry Walker
    if (name.toLowerCase().includes('henry') && name.toLowerCase().includes('walker')) {
      henryUid = g.enrollment_id || g.uid;
      henryGrade = g;
    }
  }

  console.log(`\nTotal grade entries: ${assignmentGrades.length}`);

  if (!henryUid) {
    console.log('\nCould not find Henry Walker in grade entries by name map.');
    // Try matching by enrollment list
    for (const s of enrollmentList) {
      if (s.name_first?.toLowerCase().includes('henry') && s.name_last?.toLowerCase().includes('walker')) {
        henryUid = s.uid;
        console.log(`Found Henry Walker in enrollments: UID ${henryUid}`);
        // Also check if enrollment_id is different
        console.log(`Enrollment record:`, JSON.stringify(s, null, 2));
        break;
      }
    }
    if (!henryUid) {
      console.log('Henry Walker not found. Students:', enrollmentList.map(s => `${s.name_first} ${s.name_last} (uid:${s.uid})`).join(', '));
      process.exit(1);
    }
  }

  console.log(`\nHenry Walker UID: ${henryUid}`);
  console.log('Current grade entry:', JSON.stringify(henryGrade, null, 2));

  // Step 5: Test BULK grade comment update via PUT /sections/{id}/grades
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Testing bulk grade comment update');
  console.log(`${'='.repeat(60)}\n`);

  // Method 1: PUT to section-level grades with the full grades payload
  // This mirrors the structure returned by GET /sections/{id}/grades
  console.log('--- Method 1: PUT /sections/{id}/grades (bulk) ---');
  const bulkBody = {
    grades: {
      grade: [{
        assignment_id: TARGET_ASSIGNMENT,
        enrollment_id: henryUid,
        grade: henryGrade?.grade || '',
        comment: 'Wonderful, Thanks for sharing!',
        comment_status: 1,
      }],
    },
  };
  console.log('Request body:', JSON.stringify(bulkBody, null, 2));
  const bulkResult = await apiPut(`/sections/${sectionId}/grades`, bulkBody);
  console.log(`Status: ${bulkResult.status}`);
  console.log('Response:', JSON.stringify(bulkResult.data, null, 2));

  // Method 2: Try PUT to assignment-level grades (multi-grade)
  console.log('\n--- Method 2: PUT /sections/{id}/assignments/{aid}/grades (bulk) ---');
  const bulkBody2 = {
    grades: {
      grade: [{
        enrollment_id: henryUid,
        grade: henryGrade?.grade || '',
        comment: 'Wonderful, Thanks for sharing!',
        comment_status: 1,
      }],
    },
  };
  console.log('Request body:', JSON.stringify(bulkBody2, null, 2));
  const bulkResult2 = await apiPut(`/sections/${sectionId}/assignments/${TARGET_ASSIGNMENT}/grades`, bulkBody2);
  console.log(`Status: ${bulkResult2.status}`);
  console.log('Response:', JSON.stringify(bulkResult2.data, null, 2));

  // Step 6: Re-fetch to verify if comment was updated
  if (bulkResult.status === 207 || bulkResult.status === 200 || bulkResult2.status === 200) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('  Verifying: Re-fetching grades');
    console.log(`${'='.repeat(60)}\n`);

    const verify = await apiGet(`/sections/${sectionId}/grades`);
    const verifyGrades = verify.data?.grades?.grade || [];
    const henryAfter = verifyGrades.find(
      g => String(g.enrollment_id) === String(henryUid) && String(g.assignment_id) === TARGET_ASSIGNMENT
    );
    if (henryAfter) {
      console.log('Henry Walker grade after update:');
      console.log(JSON.stringify(henryAfter, null, 2));
    } else {
      console.log('Could not find Henry Walker grade in verification fetch.');
    }
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
