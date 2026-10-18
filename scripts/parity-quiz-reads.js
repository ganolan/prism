// Live parity check for #141 (AGENTS.md: a parity probe is the verification of
// choice for API-shape work). Loads real Schoology tests both ways and diffs what
// Prism stores:
//   "browser" = the pre-#141 reader (quizLoader.openReader: a headless page, /home,
//               then each GET as a fetch inside the page; still used by quizWriteback),
//   "http"    = the shipped reader (quizLoader.openHttpReader, plain HTTP with the
//               saved cookies).
// Each test is read into two fresh in-memory databases (seeded with the course,
// the test and the students' uids only), through readQuestionLists + createGroup +
// loadGroup, and the stored attempts and responses are compared. Nothing is written
// to Schoology or to any database on disk.
// Read-only GETs. Output is masked: ids show their last 3 digits, no names or answers.
// Usage (repo root): DB_PATH=<abs copy of students.db> node scripts/parity-quiz-reads.js [testId ...]
//   With no test ids: the latest past-due test of each active section with tests.
import Database from 'better-sqlite3';
import { getDb, migrate } from '../server/db/index.js';
import { sessionDeps } from '../server/services/schoologySession.js';
import { openReader, readQuestionLists, loadGroup } from '../server/services/quizLoader.js';
import { createGroup } from '../server/services/quizGroups.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to an absolute path of a copy of students.db'); process.exit(1); }
const src = getDb();
const mask = (id) => `…${String(id).slice(-3)}`;
const PAUSE_MS = 400; // loadGroup's own default

let tests = process.argv.slice(2).map((ext) => src.prepare(`SELECT a.schoology_assignment_id AS ext, a.course_id, c.schoology_section_id AS sid
  FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.schoology_assignment_id = ?`).get(ext)).filter(Boolean);
if (!tests.length) {
  tests = src.prepare(`SELECT a.schoology_assignment_id AS ext, a.course_id, c.schoology_section_id AS sid, MAX(a.due_date) AS due
    FROM assignments a JOIN courses c ON c.id = a.course_id
    WHERE a.is_test = 1 AND a.removed_at IS NULL AND c.archived = 0 AND c.excluded = 0 AND a.due_date < datetime('now')
    GROUP BY a.course_id`).all();
}
console.log(`Tests: ${tests.map((t) => mask(t.ext)).join(', ')}`);

const browserReader = ({ pauseMs }) => openReader({ openPage: () => sessionDeps.openPage(), pauseMs });

function seed(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES (?, 'C')`).run(t.sid).lastInsertRowid;
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, ?, 'T', 1)`).run(c, t.ext);
  const ins = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'S', ?)`);
  for (const r of src.prepare('SELECT schoology_uid FROM students WHERE schoology_uid IS NOT NULL').all()) ins.run(String(r.schoology_uid), String(r.schoology_uid));
  return { db, courseId: c };
}

// What a load stored, keyed by uid and question position (no row ids, no fetch times).
function dump(db) {
  const attempts = db.prepare(`SELECT s.schoology_uid AS uid, a.schoology_attempt_id, a.started_at, a.completed_at, a.score, a.max_score, a.attempt_count
    FROM quiz_attempts a JOIN students s ON s.id = a.student_id ORDER BY s.schoology_uid`).all();
  const responses = db.prepare(`SELECT s.schoology_uid AS uid, q.position, r.chosen_letter, r.is_correct, r.points, r.max_points, r.answer_html,
      r.schoology_rubric_cells_json, r.schoology_comment
    FROM quiz_responses r JOIN quiz_attempts a ON a.id = r.attempt_id JOIN students s ON s.id = a.student_id
    JOIN quiz_questions q ON q.id = r.question_id ORDER BY s.schoology_uid, q.position`).all();
  const questions = db.prepare(`SELECT position, kind, stem_html, options_json, max_points, schoology_rubric_json FROM quiz_questions ORDER BY position`).all();
  return { attempts, responses, questions };
}

const time = { browser: 0, http: 0 };
let mismatches = 0;
for (const t of tests) {
  const sides = {};
  // Question lists both ways first (the group needs one; both must agree).
  let s = Date.now();
  const qBrowser = await readQuestionLists(src, { assignmentRefs: [t.ext] }, { openReader: browserReader, pauseMs: PAUSE_MS }).catch((e) => ({ error: e.message }));
  const qBrowserMs = Date.now() - s;
  s = Date.now();
  const qHttp = await readQuestionLists(src, { assignmentRefs: [t.ext] }, { pauseMs: PAUSE_MS }).catch((e) => ({ error: e.message }));
  const qHttpMs = Date.now() - s;
  const qSame = JSON.stringify(qBrowser) === JSON.stringify(qHttp);
  if (!qSame) mismatches++;
  time.browser += qBrowserMs; time.http += qHttpMs;
  console.log(`${mask(t.ext)} questions: ${qSame ? 'same' : 'DIFFERS'} (${qHttp.error ? qHttp.error : `${qHttp[0].questions.length} questions`}); browser ${qBrowserMs} ms, http ${qHttpMs} ms`);
  if (qHttp.error) continue;

  for (const side of ['browser', 'http']) {
    const { db, courseId } = seed(t);
    const aid = db.prepare('SELECT id FROM assignments').get().id;
    const g = createGroup(db, { courseId, assignmentRefs: [t.ext], title: 'T', questionLists: [{ assignmentId: aid, questions: qHttp[0].questions }] });
    s = Date.now();
    const summary = await loadGroup(db, { groupId: g.id }, side === 'browser' ? { openReader: browserReader, pauseMs: PAUSE_MS } : { pauseMs: PAUSE_MS })
      .catch((e) => ({ error: `${e.code || ''} ${e.message}` }));
    const ms = Date.now() - s;
    time[side] += ms;
    sides[side] = { summary, stored: dump(db), ms };
    db.close();
  }
  const { browser: b, http: h } = sides;
  const sumSame = JSON.stringify(b.summary) === JSON.stringify(h.summary);
  const parts = ['attempts', 'responses', 'questions'].map((k) => [k, JSON.stringify(b.stored[k]) === JSON.stringify(h.stored[k])]);
  const same = sumSame && parts.every(([, ok]) => ok);
  if (!same) mismatches++;
  const frq = h.stored.responses.filter((r) => r.schoology_rubric_cells_json).length;
  console.log(`${mask(t.ext)} load: ${same ? 'same' : 'DIFFERS'} attempts=${h.stored.attempts.length} responses=${h.stored.responses.length} (FRQ with rubric cells ${frq}), `
    + `notTaken=${h.summary.notTaken}, failed browser=${b.summary.failed?.length ?? b.summary.error} http=${h.summary.failed?.length ?? h.summary.error}; `
    + `browser ${b.ms} ms, http ${h.ms} ms`);
  if (!same) console.log(`  summary same: ${sumSame}; ${parts.map(([k, ok]) => `${k} ${ok ? 'same' : 'DIFFER'}`).join(', ')}`);
}

console.log(`\nTiming (ms, both include loadGroup's ${PAUSE_MS} ms pause between requests): browser ${time.browser}, http ${time.http}`);
console.log(`${tests.length} test(s): ${mismatches} mismatch(es)`);
process.exit(mismatches ? 1 : 0);
