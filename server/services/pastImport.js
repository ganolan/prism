// The background import of the teacher's past (archived) courses: after a first run (#171), and
// after every full run when a past section is missing (#178).
//
// Once per install: the first run on an empty database marks it due (markPastImportDue, 'waiting':
// syncQueue's ensure, and any kind 'all' run that starts with no course; it lives in
// pastImportState.js so the queue need not import this file). After the next finished
// `kind: 'all'` run, the archived sections are discovered (getArchivedSections: REST, no session
// needed; Schoology unreadable → it stays waiting for a later run), and each one not yet held (and
// with a course code: a section with none is a template or a "not taught" one, as GET
// /api/courses/archived/discover marks them) is imported, newest school year first. One queue run
// per course ({ kind: 'import', sectionId }, archivedImportRun.js), one at a time, so page syncs
// interleave: when an import run finishes, the queue's onRunFinished listener queues the next.
//
// #178: a set of linked sections is one course, imported by its parent section (`linked` keeps each
// parent's linked sections); it is missing until every one of its sections is held (courses or
// linked_sections). And every finished `kind: 'all'` run with no pass going (no state, or 'done')
// discovers again and starts a new pass for the sections still missing (recheckPastImport), so a
// section Prism never held (prod's past courses were imported by hand, and Schoology's own past
// page, the old source, hid linked sections) is imported without anyone asking.
//
// A section whose run did not finish 'completed' (or did, and left no course row) is listed as
// failed and the import moves on: a run can fail after writing the course row, so the row alone
// does not prove the import. When the list is through, each failed section is tried once more
// (`retried`; the import's upsert makes a second try safe), then the pass is 'done'. A section
// still missing then is given up (`gaveUp`): later passes leave it out, the Archived tab's Import
// list still offers it, and `node scripts/check-past-courses.js` reports it.
// The section whose run is queued or going is kept as `current`: a restart (which marks that run
// interrupted, and no listener hears it) counts it as an interrupted run. In the first pass it
// joins the failed list (and is retried at the end), and the import resumes with the sections
// still missing, never the ones already imported. In the retry pass it was already its retry: the
// import resumes with the failed section after it. The state is one settings row:
//   PAST_IMPORT_KEY → { state: 'waiting' | 'importing' | 'done', total, sectionIds, failed,
//                       retried, current, linked: { sectionId: [linked section ids] }, gaveUp }
// with sectionIds in import order. GET /api/sync/status reports pastImportStatus.
import { enqueue as queueRequest, onRunFinished } from './syncQueue.js';
import { getArchivedSections } from './archivedCourses.js';
import { academicYearStart } from '../lib/schoolYear.js';
import { PAST_IMPORT_KEY, markPastImportDue } from './pastImportState.js';
import { heldSectionIds } from './courseSections.js';

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
      current: s.current == null ? null : String(s.current),
      linked: s.linked && typeof s.linked === 'object' ? s.linked : {},
      gaveUp: Array.isArray(s.gaveUp) ? s.gaveUp.map(String) : [],
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

// The section ids of `sectionIds` that Prism does not hold in full yet: the section, or one of its
// linked sections (`linked`), is in neither courses nor linked_sections.
function missingOf(db, sectionIds, linked = {}) {
  if (!sectionIds.length) return new Set();
  const held = heldSectionIds(db);
  return new Set(sectionIds.filter((id) => ![id, ...(linked[id] || [])].every((x) => held.has(String(x)))));
}

// → { state: 'none' | 'waiting' | 'importing' | 'done', done, total }: done counts the sections
// now in courses (a failed one never counts).
export function pastImportStatus(db) {
  const s = readState(db);
  if (!s) return { state: 'none', done: 0, total: 0 };
  return { state: s.state, done: s.total - missingOf(db, s.sectionIds, s.linked).size, total: s.total };
}

// The discovered sections to import, newest school year first (a section whose year cannot be
// read goes last); within a year, the page's order. Leaves out `skip` (given up). → { sectionIds,
// linked }: linked holds each listed section's linked sections (only those that have some).
function importOrder(db, sections, skip = []) {
  const seen = new Set(skip.map(String));
  const rows = [];
  const linked = {};
  for (const s of sections) {
    const id = s?.sectionId == null ? '' : String(s.sectionId);
    if (!id || !s.courseCode || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, year: academicYearStart(s.gradingPeriod ?? null) });
    if (s.linkedSectionIds?.length) linked[id] = s.linkedSectionIds.map(String);
  }
  const missing = missingOf(db, rows.map((r) => r.id), linked);
  const sectionIds = rows.filter((r) => missing.has(r.id))
    .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
    .map((r) => r.id);
  return { sectionIds, linked: Object.fromEntries(sectionIds.filter((id) => linked[id]).map((id) => [id, linked[id]])) };
}

// A new pass over the discovered `sections`, leaving out `gaveUp`.
function newPass(db, sections, gaveUp) {
  const { sectionIds, linked } = importOrder(db, sections, gaveUp);
  return { state: 'importing', total: sectionIds.length, sectionIds, failed: [], retried: false, current: null, linked, gaveUp };
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
  // exists. A restart in this pass resumes after the section whose run it cut off (`current`),
  // which gets no second retry; a state with no `current` starts the pass again from the first.
  const from = finished != null && s.failed.includes(finished) ? s.failed.indexOf(finished) + 1 : 0;
  return s.failed[from] ?? null;
}

async function discoverSafely(discover) {
  try { return await discover(); } catch { return null; }
}

async function step({ db, discover, enqueue, finished, status }) {
  let s = readState(db);
  if (!s || s.state === 'done') return;
  if (s.state === 'waiting') {
    const sections = await discoverSafely(discover);
    if (!sections) return; // Schoology unreadable: a later run tries again
    s = newPass(db, sections, s.gaveUp);
    console.log(`[past import] ${s.total} past course(s) to import`);
  }
  advance(db, s, enqueue, { finished, status });
}

// Queue the next section of pass `s`, or end it: a section still missing then is given up.
function advance(db, s, enqueue, { finished = null, status = null } = {}) {
  const missing = missingOf(db, s.sectionIds, s.linked);
  const next = nextSection(s, missing, finished == null ? null : String(finished), status);
  // Kept before the run is queued, so a restart knows which section's run it cut off.
  s.current = next;
  if (!next) {
    s.state = 'done';
    const lost = s.failed.filter((id) => missing.has(id) && !s.gaveUp.includes(id));
    if (lost.length) console.log(`[past import] given up after a retry: section(s) ${lost.join(', ')}`);
    s.gaveUp = [...s.gaveUp, ...lost];
  }
  writeState(db, s);
  if (next) enqueue({ kind: 'import', sectionId: next, trigger: 'page' });
}

// #178: with no pass going (no state, or 'done'), discover the past sections and start a pass for
// the ones still missing (leaving out those given up). Nothing missing → the state is left as it is.
async function recheck({ db, discover, enqueue }) {
  const before = readState(db);
  if (before && before.state !== 'done') return;
  const sections = await discoverSafely(discover);
  if (!sections) return;
  const s = newPass(db, sections, before?.gaveUp ?? []);
  if (!s.total) return;
  console.log(`[past import] ${s.total} past course(s) missing: importing them`);
  advance(db, s, enqueue);
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

// After a finished full run (#178): import the past sections Prism does not hold. Steps run one
// after another with continuePastImport's.
export function recheckPastImport({ db, discover = getArchivedSections, enqueue = queueRequest }) {
  const run = chain.then(() => recheck({ db, discover, enqueue }));
  chain = run.catch(() => {});
  return run;
}

// At server start: listen for finished runs, and resume an import a restart cut off. The section
// whose run the restart cut off (`current`; markInterruptedRuns marked its run interrupted) counts
// as an interrupted run. → unsubscribe.
export function startPastImport({ db, discover = getArchivedSections }) {
  const stop = onRunFinished((request, status) => {
    if (request.kind === 'import') return continuePastImport({ db, discover, finished: request.sectionId, status });
    if (request.kind !== 'all') return undefined;
    if (readState(db)?.state === 'waiting') return continuePastImport({ db, discover });
    return recheckPastImport({ db, discover });
  });
  const s = readState(db);
  if (s?.state === 'importing') {
    const cutOff = s.current == null ? {} : { finished: s.current, status: 'interrupted' };
    continuePastImport({ db, discover, ...cutOff }).catch((err) => console.error('[past import] Could not resume:', err.message));
  }
  return stop;
}
