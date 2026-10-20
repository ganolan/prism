// The background import of the teacher's past (archived) courses after a first run (#171).
//
// Once per install: the first run on an empty database marks it due (markPastImportDue,
// 'waiting', from syncQueue's ensure; it lives in pastImportState.js so the queue need not import
// this file). After the next finished `kind: 'all'` run, the archived sections are discovered
// (getArchivedSections; no session → it stays waiting for a later run), and each one not yet in
// `courses` (and with a course code: a section with none is a template or a "not taught" one, as
// GET /api/courses/archived/discover marks them) is imported, newest school year first. One queue
// run per course ({ kind: 'import', sectionId }, archivedImportRun.js), one at a time, so page syncs
// interleave: when an import run finishes, the queue's onRunFinished listener queues the next.
//
// A section whose run did not finish 'completed' (or that is still missing after it) is listed as
// failed and the import moves on: a run can fail after writing the course row, so the row alone
// does not prove the import. When the list is through, each failed section is tried once more
// (`retried`; the import's upsert makes a second try safe), then the import is 'done' for good. A restart resumes it (startPastImport): the sections still missing are queued, never
// the ones already imported. The state is one settings row:
//   PAST_IMPORT_KEY → { state: 'waiting' | 'importing' | 'done', total, sectionIds, failed, retried }
// with sectionIds in import order. GET /api/sync/status reports pastImportStatus.
import { enqueue as queueRequest, onRunFinished } from './syncQueue.js';
import { getArchivedSections } from './archivedCourses.js';
import { academicYearStart } from '../lib/schoolYear.js';
import { PAST_IMPORT_KEY, markPastImportDue } from './pastImportState.js';

export { PAST_IMPORT_KEY, markPastImportDue };

function readState(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PAST_IMPORT_KEY);
  if (!row) return null;
  try {
    const s = JSON.parse(row.value);
    if (!s || typeof s !== 'object') return null;
    return {
      state: s.state,
      total: Number(s.total) || 0,
      sectionIds: Array.isArray(s.sectionIds) ? s.sectionIds.map(String) : [],
      failed: Array.isArray(s.failed) ? s.failed.map(String) : [],
      retried: !!s.retried,
    };
  } catch {
    return null;
  }
}

function writeState(db, state) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(PAST_IMPORT_KEY, JSON.stringify(state));
}

// The section ids of `sectionIds` that are not in courses yet.
function missingOf(db, sectionIds) {
  if (!sectionIds.length) return new Set();
  const known = new Set(db.prepare(`SELECT schoology_section_id AS id FROM courses
    WHERE schoology_section_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(sectionIds)).map((r) => String(r.id)));
  return new Set(sectionIds.filter((id) => !known.has(id)));
}

// → { state: 'none' | 'waiting' | 'importing' | 'done', done, total }: done counts the sections
// now in courses (a failed one never counts).
export function pastImportStatus(db) {
  const s = readState(db);
  if (!s) return { state: 'none', done: 0, total: 0 };
  return { state: s.state, done: s.total - missingOf(db, s.sectionIds).size, total: s.total };
}

// The discovered sections to import, newest school year first (a section whose year cannot be
// read goes last); within a year, the page's order.
function importOrder(db, sections) {
  const seen = new Set();
  const rows = [];
  for (const s of sections) {
    const id = s?.sectionId == null ? '' : String(s.sectionId);
    if (!id || !s.courseCode || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, year: academicYearStart(s.gradingPeriod ?? null) });
  }
  const missing = missingOf(db, rows.map((r) => r.id));
  return rows.filter((r) => missing.has(r.id))
    .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
    .map((r) => r.id);
}

// The next section to import, updating `s` (failed, retried). `finished`: the section whose import
// run just ended, and `status` that run's final status.
function nextSection(s, missing, finished, status) {
  const failedRun = finished != null && ((status != null && status !== 'completed') || missing.has(finished));
  if (failedRun && !s.retried && s.sectionIds.includes(finished) && !s.failed.includes(finished)) {
    s.failed.push(finished);
  }
  if (!s.retried) {
    const next = s.sectionIds.find((id) => missing.has(id) && !s.failed.includes(id));
    if (next) return next;
    s.retried = true;
    return s.failed[0] ?? null;
  }
  // The retry pass goes through the failed list once, in order, whether or not a section's row
  // exists. A restart in this pass starts it again from the first failed section.
  const from = finished != null && s.failed.includes(finished) ? s.failed.indexOf(finished) + 1 : 0;
  return s.failed[from] ?? null;
}

async function step({ db, discover, enqueue, finished, status }) {
  let s = readState(db);
  if (!s || s.state === 'done') return;
  if (s.state === 'waiting') {
    let sections = null;
    try { sections = await discover(); } catch { sections = null; }
    if (!sections) return; // no session: a later run tries again
    const sectionIds = importOrder(db, sections);
    s = { state: 'importing', total: sectionIds.length, sectionIds, failed: [], retried: false };
    console.log(`[past import] ${sectionIds.length} past course(s) to import`);
  }
  const next = nextSection(s, missingOf(db, s.sectionIds), finished == null ? null : String(finished), status);
  if (!next) {
    s.state = 'done';
    writeState(db, s);
    return;
  }
  writeState(db, s);
  enqueue({ kind: 'import', sectionId: next, trigger: 'page' });
}

let chain = Promise.resolve();

// Take the import one step: start it (waiting), queue the next section (importing), or finish it.
// After an import run: `finished` is its section and `status` its final status. Steps run one
// after another, so two runs finishing together never queue twice.
export function continuePastImport({ db, discover = getArchivedSections, enqueue = queueRequest, finished = null, status = null }) {
  const run = chain.then(() => step({ db, discover, enqueue, finished, status }));
  chain = run.catch(() => {});
  return run;
}

// At server start: listen for finished runs, and resume an import a restart cut off. → unsubscribe.
export function startPastImport({ db, discover = getArchivedSections }) {
  const stop = onRunFinished((request, status) => {
    if (request.kind === 'import') return continuePastImport({ db, discover, finished: request.sectionId, status });
    if (request.kind === 'all' && readState(db)?.state === 'waiting') return continuePastImport({ db, discover });
    return undefined;
  });
  if (readState(db)?.state === 'importing') {
    continuePastImport({ db, discover }).catch((err) => console.error('[past import] Could not resume:', err.message));
  }
  return stop;
}
