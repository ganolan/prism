/**
 * test-rubrics-api.js
 *
 * Probes Schoology API for rubric, grading scale, measurement topic,
 * and standards-based grading endpoints.
 *
 * Run: node test-rubrics-api.js
 *
 * Phase 0 of the Standards-Based Grading plan (Issue #7).
 * Results determine whether we can pull measurement topic data via API
 * or need a manual entry fallback.
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

function divider(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function probe(label, { status, data, url }) {
  const ok = status >= 200 && status < 300;
  const icon = ok ? '✅' : status === 403 ? '🔒' : status === 404 ? '❌' : '⚠️';
  console.log(`\n${icon} ${label}`);
  console.log(`   GET ${url.replace(API, '')}`);
  console.log(`   Status: ${status}`);
  if (ok && data && typeof data === 'object') {
    const keys = Object.keys(data);
    console.log(`   Top-level keys: [${keys.join(', ')}]`);
    // Show truncated sample
    const sample = JSON.stringify(data, null, 2);
    if (sample.length > 2000) {
      console.log(`   Data (first 2000 chars):\n${sample.substring(0, 2000)}\n   ... (truncated, ${sample.length} total chars)`);
    } else {
      console.log(`   Data:\n${sample}`);
    }
  } else if (!ok) {
    const msg = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data)?.substring(0, 300);
    if (msg) console.log(`   Response: ${msg}`);
  }
  return { status, data, ok };
}

// ── Main ──

async function run() {
  divider('PHASE 0: Schoology API Discovery — Rubrics & Standards');

  // Step 0: Authenticate
  console.log('\nAuthenticating...');
  const me = await apiGet('/users/me');
  if (me.status !== 200) {
    console.log(`❌ Auth failed (${me.status}). Check .env credentials.`);
    process.exit(1);
  }
  const myId = me.data.id || me.data.uid;
  console.log(`✅ Authenticated as user ${myId}`);

  // Step 1: Get sections — pick first active one for testing
  const sectionsRes = await apiGet(`/users/${myId}/sections`);
  const allSections = sectionsRes.data?.section || [];
  if (allSections.length === 0) {
    console.log('❌ No sections found.');
    process.exit(1);
  }
  console.log(`\nFound ${allSections.length} sections:`);
  allSections.forEach(s => console.log(`  - [${s.id}] ${s.course_title} — ${s.section_title}`));

  const testSection = allSections[0];
  const sid = testSection.id;
  console.log(`\n→ Using test section: "${testSection.course_title}" (id: ${sid})`);

  // Get a sample assignment for rubric probing
  const assignRes = await apiGet(`/sections/${sid}/assignments?limit=20`);
  const assignments = assignRes.data?.assignment || [];
  console.log(`\n→ Found ${assignments.length} assignments in test section`);

  // ── SECTION A: Assignment metadata inspection ──
  divider('A. Assignment Metadata — Looking for rubric/standards fields');

  if (assignments.length > 0) {
    // Show ALL fields on first assignment
    console.log('\nFull field list on first assignment:');
    const first = assignments[0];
    for (const [key, val] of Object.entries(first)) {
      const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
      console.log(`  ${key}: ${display.substring(0, 200)}`);
    }

    // Check all assignments for rubric-related fields
    console.log('\nScanning all assignments for rubric/standards fields...');
    const interestingFields = ['rubric', 'rubric_id', 'grading_category', 'grading_category_id',
      'grading_scale', 'grading_scale_id', 'standards', 'learning_objectives',
      'measurement_topics', 'category', 'category_id', 'factor', 'grade_item_id',
      'grading_group', 'grading_group_id', 'alignment', 'outcomes'];

    for (const a of assignments) {
      const found = [];
      for (const field of interestingFields) {
        if (a[field] !== undefined && a[field] !== null && a[field] !== '' && a[field] !== 0) {
          found.push(`${field}=${JSON.stringify(a[field]).substring(0, 100)}`);
        }
      }
      if (found.length > 0) {
        console.log(`  📋 "${a.title}" (id: ${a.id}): ${found.join(', ')}`);
      }
    }

    // Check for any field we haven't thought of
    const allKeys = new Set();
    for (const a of assignments) {
      for (const k of Object.keys(a)) allKeys.add(k);
    }
    console.log(`\nAll unique fields across assignments: [${[...allKeys].sort().join(', ')}]`);
  }

  // ── SECTION B: Grading Scales ──
  divider('B. Grading Scales');

  probe('Global grading scales', await apiGet('/grading_scales'));
  probe('Section grading scales', await apiGet(`/sections/${sid}/grading_scales`));

  // ── SECTION C: Grading Categories (likely Reporting Categories) ──
  divider('C. Grading Categories / Reporting Categories');

  const gcResult = probe('Section grading categories', await apiGet(`/sections/${sid}/grading_categories`));

  // If we got categories, drill into them
  if (gcResult.ok && gcResult.data) {
    const categories = gcResult.data?.grading_category || gcResult.data?.grading_categories?.grading_category || [];
    if (Array.isArray(categories) && categories.length > 0) {
      console.log(`\n→ Found ${categories.length} grading categories. Inspecting first:`);
      console.log(JSON.stringify(categories[0], null, 2));

      // Check if categories have sub-items (measurement topics)
      const firstCat = categories[0];
      if (firstCat.id) {
        probe('Single grading category detail', await apiGet(`/sections/${sid}/grading_categories/${firstCat.id}`));
      }
    }
  }

  // Also try course-level
  if (testSection.course_id) {
    probe('Course-level grading categories', await apiGet(`/courses/${testSection.course_id}/grading_categories`));
  }

  // ── SECTION D: Grading Groups / Periods ──
  divider('D. Grading Groups / Periods');

  probe('Section grading groups', await apiGet(`/sections/${sid}/grading_groups`));
  probe('Section grading periods', await apiGet(`/sections/${sid}/grading_periods`));

  // ── SECTION E: Rubrics ──
  divider('E. Rubrics');

  probe('Section rubrics', await apiGet(`/sections/${sid}/rubrics`));
  probe('Global rubrics (user)', await apiGet(`/users/${myId}/rubrics`));

  if (assignments.length > 0) {
    // Try rubric on first few assignments
    for (const a of assignments.slice(0, 3)) {
      probe(`Assignment rubric: "${a.title}" (${a.id})`,
        await apiGet(`/sections/${sid}/assignments/${a.id}/rubric`));
    }

    // Also try plural form
    probe('Assignment rubrics (plural, first assignment)',
      await apiGet(`/sections/${sid}/assignments/${assignments[0].id}/rubrics`));
  }

  // ── SECTION F: Standards / Learning Objectives ──
  divider('F. Standards / Learning Objectives');

  probe('Section standards', await apiGet(`/sections/${sid}/standards`));
  if (testSection.course_id) {
    probe('Course standards', await apiGet(`/courses/${testSection.course_id}/standards`));
  }
  probe('Global standards', await apiGet('/standards'));

  // ── SECTION G: Grade data — looking for rubric scores ──
  divider('G. Grade Data — Inspecting for rubric/topic scores');

  // Fetch section grades and inspect response shape deeply
  const gradesRes = await apiGet(`/sections/${sid}/grades`);
  if (gradesRes.status === 200) {
    const grades = gradesRes.data?.grades?.grade || [];
    console.log(`\n→ Section grades: ${grades.length} entries`);

    if (grades.length > 0) {
      // Show all keys on first grade
      console.log('\nAll fields on first grade entry:');
      for (const [key, val] of Object.entries(grades[0])) {
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  ${key}: ${display.substring(0, 200)}`);
      }

      // Look for rubric-related fields in any grade
      const gradeKeys = new Set();
      for (const g of grades) {
        for (const k of Object.keys(g)) gradeKeys.add(k);
      }
      console.log(`\nAll unique fields across grades: [${[...gradeKeys].sort().join(', ')}]`);

      // Check for nested rubric data
      const rubricFields = [...gradeKeys].filter(k =>
        k.includes('rubric') || k.includes('criteria') || k.includes('topic') ||
        k.includes('standard') || k.includes('objective') || k.includes('category'));
      if (rubricFields.length > 0) {
        console.log(`\n🎯 Rubric-related fields found in grades: [${rubricFields.join(', ')}]`);
      } else {
        console.log('\n⚠️  No rubric-related fields found in grade entries');
      }
    }
  }

  // Try rubric-specific grade endpoints
  if (assignments.length > 0) {
    const testAssign = assignments[0];
    probe('Assignment rubric grades', await apiGet(`/sections/${sid}/assignments/${testAssign.id}/grades/rubric`));
    probe('Assignment rubric results', await apiGet(`/sections/${sid}/assignments/${testAssign.id}/rubric_results`));
  }

  // ── SECTION H: Mastery / Outcomes endpoints ──
  divider('H. Mastery / Outcomes');

  probe('Section outcomes', await apiGet(`/sections/${sid}/outcomes`));
  probe('Section mastery', await apiGet(`/sections/${sid}/mastery`));
  if (testSection.course_id) {
    probe('Course outcomes', await apiGet(`/courses/${testSection.course_id}/outcomes`));
  }

  // ── SECTION I: Grading Scales on specific items ──
  divider('I. Probing Additional Patterns');

  probe('Section grade_items', await apiGet(`/sections/${sid}/grade_items`));
  probe('Section grade_scales', await apiGet(`/sections/${sid}/grade_scales`));

  // Try with query params on grades
  probe('Grades with rubric param', await apiGet(`/sections/${sid}/grades?with_rubric=1`));
  probe('Grades with details param', await apiGet(`/sections/${sid}/grades?with_details=1`));

  // ── SECTION J: Probe ALL sections for variety ──
  divider('J. Quick Probe Across All Sections');

  for (const sec of allSections) {
    const catRes = await apiGet(`/sections/${sec.id}/grading_categories`);
    const cats = catRes.data?.grading_category || catRes.data?.grading_categories?.grading_category || [];
    const catCount = Array.isArray(cats) ? cats.length : 0;

    const rubRes = await apiGet(`/sections/${sec.id}/rubrics`);
    const rubOk = rubRes.status >= 200 && rubRes.status < 300;

    console.log(`  [${sec.id}] ${sec.course_title}: categories=${catCount}, rubrics=${rubRes.status}${rubOk ? ' ✅' : ''}`);

    if (catCount > 0) {
      console.log(`    Categories: ${cats.map(c => `"${c.title || c.name || c.id}"`).join(', ')}`);
    }
  }

  // ── SUMMARY ──
  divider('SUMMARY — Endpoint Status');
  console.log(`
This summary shows what Schoology exposes for standards-based grading.
Use these findings to determine the implementation approach for Issue #7.

Key questions to answer:
1. Can we get grading scales (the "General Academic Scale")?
2. Can we get grading categories (Reporting Categories)?
3. Can we get measurement topics / learning objectives?
4. Can we get per-student rubric scores per assignment?
5. Do assignments carry alignment metadata (grading_category_id, rubric_id)?

If #4 is NO → need manual entry fallback for topic ratings.
If #2 and #3 are YES → can auto-build the measurement topic hierarchy.
If #5 is YES → can auto-detect summative vs formative assignments.
`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
