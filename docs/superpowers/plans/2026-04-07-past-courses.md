# Past Courses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual past-course import flow and a Current/Archived tab toggle to the Dashboard, with courses grouped by academic year.

**Architecture:** Fix the sync to correctly store `grading_period` and mark active courses `archived=0`. Extract shared per-section sync logic into a reusable `syncSectionData` helper. Add a `POST /api/courses/import` endpoint and a `?view=` param to `GET /api/courses`. Rewrite the Dashboard to use a tab toggle, year-grouped archived view, and an import form.

**Tech Stack:** Node/Express, better-sqlite3, React 18, React Router

---

## File Map

| File | Change |
|---|---|
| `server/services/schoology.js` | Add `getSectionGradingPeriods` export |
| `server/services/sync.js` | Extract `syncSectionData` export; fix grading period upsert; set `archived=0` |
| `server/routes/courses.js` | Add `?view=` param to GET; add `POST /import` |
| `client/src/services/api.js` | Add `getCoursesByView` and `importCourse` |
| `client/src/pages/Dashboard.jsx` | Full rewrite: tab toggle, grouped archived view, import form, modal rename |

---

## Task 1: Add `getSectionGradingPeriods` to schoology service

**Files:**
- Modify: `server/services/schoology.js`

- [ ] **Step 1: Add the export after `getSectionGrades`**

In `server/services/schoology.js`, add after `getSectionGrades` (line ~92):

```javascript
export async function getSectionGradingPeriods(sectionId) {
  const data = await apiGet(`/sections/${sectionId}/grading_periods`);
  return data?.grading_period || [];
}
```

- [ ] **Step 2: Verify manually**

```bash
node --input-type=module <<'EOF'
import 'dotenv/config';
import { getSectionGradingPeriods } from './server/services/schoology.js';
const periods = await getSectionGradingPeriods('7899907727');
console.log(periods);
EOF
```

Expected output:
```json
[{ "id": 1123041, "title": "2025-2026: 08/14/2025 - 06/17/2026", ... }]
```

- [ ] **Step 3: Commit**

```bash
git add server/services/schoology.js
git commit -m "feat: add getSectionGradingPeriods to schoology service"
```

---

## Task 2: Extract `syncSectionData` and fix grading period sync

**Files:**
- Modify: `server/services/sync.js`

- [ ] **Step 1: Add imports at top of sync.js**

The import block at the top of `server/services/sync.js` must include `getSectionGradingPeriods`:

```javascript
import { getDb } from '../db/index.js';
import {
  getMyUserId,
  getMySections,
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getSectionGradingPeriods,
  getUserProfile,
} from './schoology.js';
```

- [ ] **Step 2: Add `syncSectionData` as an exported function**

Add this function before `fullSync`:

```javascript
// Sync enrollments, assignments, and grades for one section.
// Returns counts of records written.
export async function syncSectionData(db, sectionId, courseId, now) {
  const enrollments = await getSectionEnrollments(sectionId);
  const studentEnrollments = enrollments.filter(e => e.admin !== '1' && e.admin !== 1);

  const upsertStudent = db.prepare(`
    INSERT INTO students (schoology_uid, first_name, last_name, email, picture_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_uid) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = COALESCE(excluded.email, students.email),
      picture_url = COALESCE(excluded.picture_url, students.picture_url),
      updated_at = excluded.updated_at
  `);
  const upsertEnrolment = db.prepare(`
    INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id)
    VALUES (?, ?, ?)
    ON CONFLICT(student_id, course_id) DO UPDATE SET
      schoology_enrolment_id = excluded.schoology_enrolment_id
  `);

  for (const e of studentEnrollments) {
    upsertStudent.run(String(e.uid), e.name_first, e.name_last, e.primary_email || null, e.picture_url || null, now);
    const studentRow = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(String(e.uid));
    if (studentRow) upsertEnrolment.run(studentRow.id, courseId, String(e.id));
  }

  const assignments = await getSectionAssignments(sectionId);
  const upsertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_assignment_id) DO UPDATE SET
      title = excluded.title,
      due_date = excluded.due_date,
      max_points = excluded.max_points,
      assignment_type = excluded.assignment_type,
      synced_at = excluded.synced_at
  `);
  for (const a of assignments) {
    upsertAssignment.run(courseId, String(a.id), a.title, a.due || null, a.max_points ?? null, a.type || 'assignment', now);
  }

  const grades = await getSectionGrades(sectionId);
  const upsertGrade = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, grade_comment, comment_status, exception, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      score = excluded.score,
      max_score = excluded.max_score,
      grade_comment = excluded.grade_comment,
      comment_status = excluded.comment_status,
      exception = excluded.exception,
      synced_at = excluded.synced_at
  `);

  const enrolmentMap = {};
  const allEnrolments = db.prepare('SELECT id, student_id, schoology_enrolment_id FROM enrolments WHERE course_id = ?').all(courseId);
  for (const en of allEnrolments) enrolmentMap[en.schoology_enrolment_id] = en.student_id;

  const enrollIdToUid = {};
  for (const e of enrollments) enrollIdToUid[String(e.id)] = String(e.uid);

  let gradesCount = 0;
  for (const g of grades) {
    const enrollmentId = String(g.enrollment_id);
    let studentId = enrolmentMap[enrollmentId];
    if (!studentId) {
      const uid = enrollIdToUid[enrollmentId];
      if (uid) {
        const row = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(uid);
        studentId = row?.id;
      }
    }
    if (!studentId) continue;
    const assignRow = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?').get(String(g.assignment_id));
    if (!assignRow) continue;
    upsertGrade.run(studentId, assignRow.id, enrollmentId, g.grade ?? null, g.max_points ?? assignRow.max_points ?? null, g.comment || null, g.comment_status ?? null, g.exception ?? 0, now);
    gradesCount++;
  }

  return { studentsCount: studentEnrollments.length, assignmentsCount: assignments.length, gradesCount };
}
```

- [ ] **Step 3: Update the `upsertCourse` statement in `fullSync`**

Replace the existing `upsertCourse` prepared statement (around line 35) with:

```javascript
const upsertCourse = db.prepare(`
  INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, archived, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(schoology_section_id) DO UPDATE SET
    course_name = excluded.course_name,
    section_name = excluded.section_name,
    course_code = excluded.course_code,
    section_school_code = excluded.section_school_code,
    grading_period = excluded.grading_period,
    archived = 0,
    synced_at = excluded.synced_at
`);
```

- [ ] **Step 4: Update the upsert loop to fetch grading periods**

Replace the existing upsert loop (around line 46) with:

```javascript
for (const sec of sections) {
  const periods = await getSectionGradingPeriods(String(sec.id));
  const gradingPeriod = periods[0]?.title || null;
  upsertCourse.run(
    String(sec.id),
    sec.course_title,
    sec.section_title,
    sec.course_code || null,
    sec.section_school_code || null,
    gradingPeriod,
    now
  );
}
```

- [ ] **Step 5: Replace the per-section sync block with `syncSectionData` calls**

Replace the entire `// 2. For each section, sync enrollments, assignments, grades` block (lines ~70–198) with:

```javascript
// 2. For each section, sync enrollments, assignments, grades
for (const sec of sections) {
  const sectionId = String(sec.id);
  const courseRow = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
  if (!courseRow) continue;

  log(`Syncing "${sec.course_title}"...`);
  const result = await syncSectionData(db, sectionId, courseRow.id, now);
  totalRecords += result.studentsCount + result.assignmentsCount + result.gradesCount;
}
```

The profile-fetching block (step 3, lines ~200–250) remains unchanged.

- [ ] **Step 6: Verify the server starts cleanly**

```bash
npm run dev:server
```

Expected: server starts with no import errors.

- [ ] **Step 7: Commit**

```bash
git add server/services/sync.js
git commit -m "feat: extract syncSectionData, fix grading period population, set archived=0 on sync"
```

---

## Task 3: Add `?view=` and `POST /import` to courses route

**Files:**
- Modify: `server/routes/courses.js`

- [ ] **Step 1: Add imports at the top of courses.js**

```javascript
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { apiGet } from '../services/schoology.js';
import { syncSectionData } from '../services/sync.js';
```

- [ ] **Step 2: Update `GET /` to handle `?view=`**

Replace the existing `router.get('/')` handler with:

```javascript
router.get('/', (req, res) => {
  const db = getDb();
  const { view } = req.query;

  let rows;
  if (view === 'current') {
    rows = db.prepare('SELECT * FROM courses WHERE archived = 0 AND hidden = 0 ORDER BY course_name').all();
  } else if (view === 'archived') {
    rows = db.prepare('SELECT * FROM courses WHERE archived = 1 AND hidden = 0 ORDER BY course_name').all();
  } else {
    // Legacy behaviour — keep for backwards compatibility
    const includeArchived = req.query.archived === 'true';
    const includeHidden = req.query.hidden === 'true';
    let query = 'SELECT * FROM courses WHERE 1=1';
    if (!includeArchived) query += ' AND archived = 0';
    if (!includeHidden) query += ' AND hidden = 0';
    query += ' ORDER BY course_name';
    rows = db.prepare(query).all();
  }

  res.json(rows);
});
```

- [ ] **Step 3: Add `POST /import` before the archive/visibility routes**

Add after `router.get('/:id/gradebook', ...)` and before `router.put('/:id/archive', ...)`:

```javascript
// POST /api/courses/import — fetch a past course from Schoology and sync it
router.post('/import', async (req, res) => {
  const { sectionId } = req.body;
  if (!sectionId) return res.status(400).json({ error: 'sectionId required' });

  try {
    const [sec, periodsData] = await Promise.all([
      apiGet(`/sections/${sectionId}`),
      apiGet(`/sections/${sectionId}/grading_periods`),
    ]);

    const gradingPeriod = periodsData?.grading_period?.[0]?.title || null;
    const now = new Date().toISOString();
    const db = getDb();

    db.prepare(`
      INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, archived, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(schoology_section_id) DO UPDATE SET
        course_name = excluded.course_name,
        section_name = excluded.section_name,
        course_code = excluded.course_code,
        section_school_code = excluded.section_school_code,
        grading_period = excluded.grading_period,
        archived = 1,
        synced_at = excluded.synced_at
    `).run(
      String(sec.id), sec.course_title, sec.section_title,
      sec.course_code || null, sec.section_school_code || null,
      gradingPeriod, now
    );

    const courseRow = db.prepare('SELECT * FROM courses WHERE schoology_section_id = ?').get(String(sec.id));
    const { studentsCount, assignmentsCount, gradesCount } = await syncSectionData(db, String(sec.id), courseRow.id, now);

    res.json({ course: courseRow, studentsCount, assignmentsCount, gradesCount });
  } catch (err) {
    if (err.message.includes('403')) return res.status(403).json({ error: 'Section not accessible — check the section ID and try again' });
    if (err.message.includes('404')) return res.status(404).json({ error: 'Section not found — check the section ID and try again' });
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify endpoint manually**

With the dev server running (`npm run dev:server`), in another terminal:

```bash
curl -s -X POST http://localhost:3000/api/courses/import \
  -H "Content-Type: application/json" \
  -d '{"sectionId":"7899907695"}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).course.course_name)"
```

Expected: `MOBILE GAMES DEVELOPMENT`

Also verify `?view=`:

```bash
curl -s "http://localhost:3000/api/courses?view=archived" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).map(c=>c.course_name))"
```

Expected: array containing `MOBILE GAMES DEVELOPMENT`

```bash
curl -s "http://localhost:3000/api/courses?view=current" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).map(c=>c.course_name))"
```

Expected: array NOT containing `MOBILE GAMES DEVELOPMENT`

- [ ] **Step 5: Commit**

```bash
git add server/routes/courses.js
git commit -m "feat: add ?view= param and POST /import to courses route"
```

---

## Task 4: Update frontend API service

**Files:**
- Modify: `client/src/services/api.js`

- [ ] **Step 1: Add `getCoursesByView` and `importCourse`**

After the existing `getCourses` line (line 21), add:

```javascript
export const getCoursesByView = (view) => request(`/courses?view=${view}`);
export const importCourse = (sectionId) => request('/courses/import', {
  method: 'POST',
  body: JSON.stringify({ sectionId }),
});
```

Leave the existing `getCourses`, `toggleArchiveCourse`, and all other exports unchanged.

- [ ] **Step 2: Commit**

```bash
git add client/src/services/api.js
git commit -m "feat: add getCoursesByView and importCourse to API service"
```

---

## Task 5: Rewrite Dashboard.jsx

**Files:**
- Modify: `client/src/pages/Dashboard.jsx`

- [ ] **Step 1: Replace the file with the new implementation**

Replace the entire contents of `client/src/pages/Dashboard.jsx` with:

```jsx
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, importCourse } from '../services/api.js';

// Derive academic year and semester from Schoology grading_period title string.
// Examples:
//   "2025-2026: 08/14/2025 - 06/17/2026"  → { academicYear: '2025-26', semester: 'Full Year' }
//   "Semester 1: 08/14/2025 - 01/11/2026" → { academicYear: '2025-26', semester: 'Semester 1' }
//   "Semester 2: 01/12/2026 - 06/17/2026" → { academicYear: '2025-26', semester: 'Semester 2' }
function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };

  let semester = 'Full Year';
  if (gradingPeriod.includes('Semester 1')) semester = 'Semester 1';
  else if (gradingPeriod.includes('Semester 2')) semester = 'Semester 2';

  // Extract the first date in MM/DD/YYYY format
  const dateMatch = gradingPeriod.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateMatch) return { academicYear: 'Unknown', semester };

  const month = parseInt(dateMatch[1], 10);
  const year = parseInt(dateMatch[3], 10);
  // Aug–Dec: this calendar year starts the academic year
  // Jan–Jul: the previous calendar year started the academic year
  const startYear = month >= 8 ? year : year - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(-2)}`;

  return { academicYear, semester };
}

function groupByAcademicYear(courses) {
  const groups = {};
  for (const c of courses) {
    const { academicYear } = parseGradingPeriod(c.grading_period);
    if (!groups[academicYear]) groups[academicYear] = [];
    groups[academicYear].push(c);
  }
  // Sort year keys descending (e.g. "2025-26" before "2024-25")
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearCourses]) => ({ year, courses: yearCourses }));
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('current');
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [allCourses, setAllCourses] = useState([]);
  const [importId, setImportId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);

  function reload() {
    Promise.all([getCoursesByView(activeTab), getSyncStatus()])
      .then(([c, s]) => { setCourses(c); setSyncStatus(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  function loadAllCourses() {
    getCourses(true, true).then(setAllCourses).catch(console.error);
  }

  useEffect(() => {
    setImportError(null);
    setImportSuccess(null);
    reload();
  }, [activeTab]);

  async function handleToggleVisibility(courseId) {
    await toggleCourseVisibility(courseId);
    loadAllCourses();
    reload();
  }

  function openEditMode() {
    setEditMode(true);
    loadAllCourses();
  }

  async function handleImport(e) {
    e.preventDefault();
    const sid = importId.trim();
    if (!sid) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importCourse(sid);
      setImportSuccess(result);
      setImportId('');
      reload();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  const yearGroups = groupByAcademicYear(courses);

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        <button className="secondary" onClick={openEditMode}>Show/Hide Courses</button>
      </div>

      {/* Sync status */}
      {syncStatus?.last && (
        <p className="text-sm text-muted mb-2">
          Last sync: {new Date(syncStatus.last.completed_at || syncStatus.last.started_at).toLocaleString()}
          {' — '}{syncStatus.last.status}
          {syncStatus.last.records_synced ? ` (${syncStatus.last.records_synced} records)` : ''}
        </p>
      )}

      {/* Tab toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <button
          className={activeTab === 'current' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setActiveTab('current')}
        >
          Current
        </button>
        <button
          className={activeTab === 'archived' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setActiveTab('archived')}
        >
          Archived
        </button>
      </div>

      {/* Current tab */}
      {activeTab === 'current' && (
        courses.length === 0 ? (
          <div className="card empty-state">
            <p>No courses synced yet. Click <strong>Sync Schoology</strong> in the sidebar to pull your courses.</p>
          </div>
        ) : (
          <div className="grid-2">
            {courses.map(c => (
              <Link to={`/course/${c.id}`} key={c.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
                    {c.section_name && <p className="text-sm text-muted">{c.section_name}</p>}
                  </div>
                </div>
                {c.synced_at && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>
                    Synced {new Date(c.synced_at).toLocaleDateString()}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )
      )}

      {/* Archived tab */}
      {activeTab === 'archived' && (
        <div>
          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses yet. Use the form below to add a past course.</p>
            </div>
          ) : (
            yearGroups.map(({ year, courses: groupCourses }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{
                  marginBottom: '0.75rem',
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                  fontSize: '0.85rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}>
                  {year}
                </h3>
                <div className="grid-2">
                  {groupCourses.map(c => {
                    const { semester } = parseGradingPeriod(c.grading_period);
                    return (
                      <Link to={`/course/${c.id}`} key={c.id} className="card" style={{ opacity: 0.75 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
                            {c.section_name && <p className="text-sm text-muted">{c.section_name}</p>}
                          </div>
                          <span className="badge badge-gray">{semester}</span>
                        </div>
                        {c.grading_period && (
                          <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>{c.grading_period}</p>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          {/* Add past course form */}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.25rem' }}>Add a past course</h3>
            <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
              Find the section ID in the Schoology URL:{' '}
              <code>schoology.hkis.edu.hk/course/<strong>[ID]</strong>/materials</code>
            </p>
            {importSuccess && (
              <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
                Imported <strong>{importSuccess.course.course_name}</strong> — {importSuccess.studentsCount} students, {importSuccess.assignmentsCount} assignments
              </div>
            )}
            {importError && (
              <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>{importError}</div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label className="text-sm" style={{ display: 'block', marginBottom: '0.25rem' }}>Section ID</label>
                <input
                  type="text"
                  value={importId}
                  onChange={e => setImportId(e.target.value)}
                  placeholder="e.g. 7899907695"
                  style={{ width: '100%' }}
                  disabled={importing}
                />
              </div>
              <button
                className="primary"
                onClick={handleImport}
                disabled={importing || !importId.trim()}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Show/Hide Courses Modal */}
      {editMode && (
        <div className="modal-overlay" onClick={() => setEditMode(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Show/Hide Courses</h3>
              <button className="ghost" onClick={() => setEditMode(false)}>✕</button>
            </div>
            <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
              Hidden courses will not appear on your dashboard. Click to show/hide.
            </p>
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {allCourses.map(c => (
                <div
                  key={c.id}
                  onClick={() => handleToggleVisibility(c.id)}
                  style={{
                    padding: '0.75rem',
                    marginBottom: '0.5rem',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    opacity: c.hidden ? 0.5 : 1,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    transition: 'all 0.2s ease',
                  }}
                  className="hover-lift"
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>{c.course_name}</div>
                    {c.section_name && <div className="text-sm text-muted">{c.section_name}</div>}
                    {(!c.course_code && !c.section_school_code) && (
                      <div className="text-sm text-muted" style={{ fontStyle: 'italic' }}>No course code</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {c.archived ? <span className="badge badge-gray">Past</span> : null}
                    <span className="badge" style={{
                      background: c.hidden ? 'var(--danger-bg)' : 'var(--success-bg)',
                      color: c.hidden ? 'var(--danger)' : 'var(--success)',
                    }}>
                      {c.hidden ? 'Hidden' : 'Visible'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={() => setEditMode(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify in browser**

Run `npm run dev` and open the dashboard. Check:
- [ ] Current tab shows active courses, no Archive/Unarchive buttons
- [ ] Archived tab shows MGD grouped under `2025-26` with a `Semester 1` badge
- [ ] "Show/Hide Courses" button opens modal with renamed title
- [ ] Import form is visible on Archived tab only
- [ ] Entering `7899907695` and clicking Import shows success banner (idempotent re-import)
- [ ] Entering an invalid ID shows an error message

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Dashboard.jsx
git commit -m "feat: Current/Archived tab toggle, year-grouped archived view, past course import form"
```

---

## Task 6: Run a full sync to populate grading_period for current courses

- [ ] **Step 1: Trigger a full sync**

With the dev server running, open Prism in the browser and click **Sync Schoology** in the sidebar. Wait for it to complete.

- [ ] **Step 2: Verify grading_period is now populated**

```bash
node --input-type=module <<'EOF'
import 'dotenv/config';
import { getDb } from './server/db/index.js';
const db = getDb();
const rows = db.prepare('SELECT course_name, grading_period, archived FROM courses').all();
console.table(rows);
EOF
```

Expected: current courses (archived=0) now have non-null `grading_period` values like `"2025-2026: 08/14/2025 - 06/17/2026"`. MGD (archived=1) should have `"Semester 1: 08/14/2025 - 01/11/2026"`.

- [ ] **Step 3: Verify Current tab groups correctly**

Switch to the Archived tab in the browser. MGD should now show under `2025-26` with the `Semester 1` badge and the full grading period string visible on the card.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: post-sync grading_period verification complete"
```
