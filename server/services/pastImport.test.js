import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { queueDeps, resetQueue, idle, enqueue as queueRequest } from './syncQueue.js';
import {
  PAST_IMPORT_KEY, markPastImportDue, pastImportStatus, continuePastImport, startPastImport, recheckPastImport,
} from './pastImport.js';

const db = () => getDb();
const row = (sectionId, gradingPeriod, courseCode = 'X', linkedSectionIds = []) => ({
  courseTitle: `Course ${sectionId}`, courseCode, sectionId, sectionTitle: null, gradingPeriod, linkedSectionIds,
});
const addLinked = (sectionId, parentId) => db().prepare(
  `INSERT INTO linked_sections (schoology_section_id, course_id) SELECT ?, id FROM courses WHERE schoology_section_id = ?`,
).run(String(sectionId), String(parentId));
const addCourse = (sectionId) => db().prepare(
  `INSERT INTO courses (schoology_section_id, course_name, archived) VALUES (?, ?, 1)`,
).run(String(sectionId), `Course ${sectionId}`);
const readState = () => {
  const r = db().prepare('SELECT value FROM settings WHERE key = ?').get(PAST_IMPORT_KEY);
  return r ? JSON.parse(r.value) : null;
};
const writeState = (state) => db().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  .run(PAST_IMPORT_KEY, JSON.stringify(state));
const importing = (sectionIds, extra = {}) => writeState({
  state: 'importing', total: sectionIds.length, sectionIds, failed: [], retried: false, ...extra,
});
const queued = (enqueue) => enqueue.mock.calls.map(([r]) => r);

beforeEach(() => {
  db().exec('DELETE FROM settings; DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM linked_sections; DELETE FROM courses;');
  resetQueue();
});

describe('markPastImportDue and pastImportStatus', () => {
  test('no state: none; marking it due sets waiting once', () => {
    expect(pastImportStatus(db())).toEqual({ state: 'none', done: 0, total: 0 });
    markPastImportDue(db());
    expect(readState()).toEqual({ state: 'waiting', total: 0, sectionIds: [], failed: [], retried: false });
    expect(pastImportStatus(db())).toEqual({ state: 'waiting', done: 0, total: 0 });
    importing(['1', '2']);
    markPastImportDue(db());
    expect(readState().state).toBe('importing');
  });

  test('done counts the sections no longer missing from courses', () => {
    importing(['1', '2', '3']);
    addCourse('2');
    expect(pastImportStatus(db())).toEqual({ state: 'importing', done: 1, total: 3 });
  });
});

describe('continuePastImport', () => {
  let enqueue;
  beforeEach(() => { enqueue = vi.fn(() => ({ runId: 1, state: 'queued', joined: false })); });

  test('no state (prod before #171, or a dev clone): nothing happens', async () => {
    const discover = vi.fn();
    await continuePastImport({ db: db(), discover, enqueue });
    expect(discover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(readState()).toBeNull();
  });

  test('waiting with no session (discover answers null): stays waiting, nothing queued', async () => {
    markPastImportDue(db());
    await continuePastImport({ db: db(), discover: vi.fn().mockResolvedValue(null), enqueue });
    expect(readState().state).toBe('waiting');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('waiting and a discover throws: stays waiting', async () => {
    markPastImportDue(db());
    await continuePastImport({ db: db(), discover: vi.fn().mockRejectedValue(new Error('down')), enqueue });
    expect(readState().state).toBe('waiting');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('waiting and a list: importing, known and code-less sections dropped, newest year first, one request', async () => {
    markPastImportDue(db());
    addCourse('6');
    const discover = vi.fn().mockResolvedValue([
      row('1', '2022-2023: Full Year'),
      row('2', null),
      row('3', 'Semester 1: 08/14/2024 - 01/11/2025'),
      row('4', '24-25 YR'),
      row('5', '2024-2025', null),
      row('6', '2021-2022'),
      row(7, '2023-2024'),
      row('3', 'Semester 1: 08/14/2024 - 01/11/2025'),
    ]);
    await continuePastImport({ db: db(), discover, enqueue });
    expect(readState()).toEqual({
      state: 'importing', total: 5, sectionIds: ['3', '4', '7', '1', '2'], failed: [], retried: false, current: '3', linked: {}, gaveUp: [],
    });
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '3', trigger: 'page' }]);
    expect(pastImportStatus(db())).toEqual({ state: 'importing', done: 0, total: 5 });
  });

  test('nothing to import: done at once', async () => {
    markPastImportDue(db());
    await continuePastImport({ db: db(), discover: vi.fn().mockResolvedValue([]), enqueue });
    expect(readState()).toMatchObject({ state: 'done', total: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('after an import run, the next missing section is queued', async () => {
    importing(['1', '2', '3']);
    addCourse('1');
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'completed' });
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '2', trigger: 'page' }]);
    expect(readState().failed).toEqual([]);
  });

  test('a section still missing after its run goes to failed and the next is queued', async () => {
    importing(['1', '2', '3']);
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'failed' });
    expect(readState().failed).toEqual(['1']);
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '2', trigger: 'page' }]);
  });

  test('a run that failed after writing the course row is failed, and retried once at the end; a completed one is not', async () => {
    importing(['1', '2']);
    addCourse('1'); // the row was written, then the run failed
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'failed' });
    expect(readState().failed).toEqual(['1']);
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '2', trigger: 'page' }]);
    addCourse('2');
    await continuePastImport({ db: db(), enqueue, finished: '2', status: 'completed' });
    expect(readState()).toMatchObject({ state: 'importing', failed: ['1'], retried: true });
    expect(queued(enqueue).at(-1)).toEqual({ kind: 'import', sectionId: '1', trigger: 'page' });
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'completed' });
    expect(enqueue).toHaveBeenCalledTimes(2); // 2 completed: never queued again
    expect(readState().state).toBe('done');
  });

  test('a completed_with_errors run counts as failed too', async () => {
    importing(['1', '2']);
    addCourse('1');
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'completed_with_errors' });
    expect(readState().failed).toEqual(['1']);
  });

  test('when none remain, the failed ones are queued once more, then done', async () => {
    importing(['1', '2', '3'], { failed: ['1'] });
    addCourse('2');
    // 3's run fails too: the first pass is over, so 1 is retried.
    await continuePastImport({ db: db(), enqueue, finished: '3', status: 'failed' });
    expect(readState()).toMatchObject({ state: 'importing', failed: ['1', '3'], retried: true });
    expect(queued(enqueue).at(-1)).toEqual({ kind: 'import', sectionId: '1', trigger: 'page' });
    // 1 fails again: 3 is retried.
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'failed' });
    expect(queued(enqueue).at(-1)).toEqual({ kind: 'import', sectionId: '3', trigger: 'page' });
    // 3 works this time: nothing is retried twice, the import is done.
    addCourse('3');
    await continuePastImport({ db: db(), enqueue, finished: '3', status: 'completed' });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(readState()).toMatchObject({ state: 'done', retried: true });
    expect(pastImportStatus(db())).toEqual({ state: 'done', done: 2, total: 3 });
    // Done is final.
    await continuePastImport({ db: db(), enqueue });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  // #178: a linked set is one row; it is missing until every one of its sections is held.
  test('a linked set is imported by its parent, and counts as missing while a linked section is', async () => {
    markPastImportDue(db());
    addCourse('4');
    addCourse('8');
    addLinked('9', '8');
    const discover = vi.fn().mockResolvedValue([
      row('4', '2023-2024', 'X', ['6']), // parent held, its linked section is not
      row('8', '2023-2024', 'X', ['9']), // every section held
    ]);
    await continuePastImport({ db: db(), discover, enqueue });
    expect(readState()).toMatchObject({ state: 'importing', sectionIds: ['4'], linked: { 4: ['6'] }, current: '4' });
    expect(pastImportStatus(db())).toEqual({ state: 'importing', done: 0, total: 1 });
    addLinked('6', '4');
    expect(pastImportStatus(db())).toEqual({ state: 'importing', done: 1, total: 1 });
    await continuePastImport({ db: db(), enqueue, finished: '4', status: 'completed' });
    expect(readState().state).toBe('done');
  });

  test('when the import is done, a section still missing after its retry is given up', async () => {
    importing(['1', '2'], { failed: ['1'], retried: true, current: '1' });
    addCourse('2');
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'failed' });
    expect(readState()).toMatchObject({ state: 'done', gaveUp: ['1'] });
  });

  test('resume: importing with two of five already in courses queues the third, never the first two', async () => {
    importing(['1', '2', '3', '4', '5']);
    addCourse('1');
    addCourse('2');
    await continuePastImport({ db: db(), enqueue });
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '3', trigger: 'page' }]);
    expect(readState().failed).toEqual([]);
  });
});

// #178: after every full run, any past section still missing is imported (the import heals itself).
describe('recheckPastImport', () => {
  let enqueue;
  beforeEach(() => { enqueue = vi.fn(() => ({ runId: 1, state: 'queued', joined: false })); });

  test('no state (prod, a dev clone): the missing sections are imported, newest first', async () => {
    addCourse('1');
    const discover = vi.fn().mockResolvedValue([row('1', '2023-2024'), row('2', '2022-2023'), row('3', '2024-2025')]);
    await recheckPastImport({ db: db(), discover, enqueue });
    expect(readState()).toMatchObject({ state: 'importing', sectionIds: ['3', '2'], current: '3', gaveUp: [] });
    expect(queued(enqueue)).toEqual([{ kind: 'import', sectionId: '3', trigger: 'page' }]);
  });

  test('nothing missing: no state is written, nothing queued', async () => {
    addCourse('1');
    await recheckPastImport({ db: db(), discover: vi.fn().mockResolvedValue([row('1', '2023-2024')]), enqueue });
    expect(readState()).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('done: a new pass for the sections missing now, leaving out those given up', async () => {
    writeState({ state: 'done', total: 1, sectionIds: ['1'], failed: ['1'], retried: true, current: null, gaveUp: ['1'] });
    const discover = vi.fn().mockResolvedValue([row('1', '2023-2024'), row('5', '2023-2024')]);
    await recheckPastImport({ db: db(), discover, enqueue });
    expect(readState()).toMatchObject({ state: 'importing', total: 1, sectionIds: ['5'], failed: [], retried: false, gaveUp: ['1'] });
    expect(pastImportStatus(db())).toEqual({ state: 'importing', done: 0, total: 1 });
  });

  test('waiting or importing: left to that pass, nothing discovered', async () => {
    const discover = vi.fn();
    markPastImportDue(db());
    await recheckPastImport({ db: db(), discover, enqueue });
    importing(['1']);
    await recheckPastImport({ db: db(), discover, enqueue });
    expect(discover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('Schoology cannot be read: nothing changes', async () => {
    await recheckPastImport({ db: db(), discover: vi.fn().mockResolvedValue(null), enqueue });
    await recheckPastImport({ db: db(), discover: vi.fn().mockRejectedValue(new Error('down')), enqueue });
    expect(readState()).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('startPastImport (through the real queue)', () => {
  let stop;
  beforeEach(() => {
    queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
    // An import run adds its course; section 2's run writes its row, then fails, every time.
    queueDeps.runPastImport = vi.fn(async (request, emit) => {
      db().prepare(`INSERT OR IGNORE INTO courses (schoology_section_id, course_name, archived) VALUES (?, 'x', 1)`).run(request.sectionId);
      if (request.sectionId === '2') throw new Error('mastery read failed');
      emit({ type: 'summary', import: { sectionId: request.sectionId } });
    });
    queueDeps.runUnifiedSync = vi.fn(async (options, emit) => emit({ type: 'summary', mastery: [] }));
  });
  afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); });

  const settled = async () => {
    for (let i = 0; i < 50 && readState()?.state !== 'done'; i += 1) {
      await idle();
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  test('a finished kind all run starts a waiting import; each import run queues the next until done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    markPastImportDue(db());
    const discover = vi.fn().mockResolvedValue([row('1', '2023-2024'), row('2', '2024-2025'), row('3', '2022-2023')]);
    stop = startPastImport({ db: db(), discover });
    expect(discover).not.toHaveBeenCalled(); // waiting: the first run comes first
    queueRequest({ kind: 'all', trigger: 'button' });
    await settled();
    expect(readState()).toMatchObject({ state: 'done', sectionIds: ['2', '1', '3'], failed: ['2'], retried: true });
    expect(queueDeps.runPastImport.mock.calls.map(([r]) => r.sectionId)).toEqual(['2', '1', '3', '2']);
    const kinds = db().prepare('SELECT options_json FROM sync_runs ORDER BY id').all().map((r) => JSON.parse(r.options_json).kind);
    expect(kinds).toEqual(['all', 'import', 'import', 'import', 'import']);
  });

  test('a restart mid-import resumes with the sections still missing', async () => {
    importing(['1', '3']);
    addCourse('1');
    stop = startPastImport({ db: db(), discover: vi.fn() });
    await settled();
    expect(queueDeps.runPastImport.mock.calls.map(([r]) => r.sectionId)).toEqual(['3']);
    expect(readState().state).toBe('done');
  });

  test('final review #2: each queued section is kept as current, and cleared when the import is done', async () => {
    importing(['1']);
    const enqueue = vi.fn(() => ({ runId: 1, state: 'queued', joined: false }));
    await continuePastImport({ db: db(), enqueue });
    expect(readState().current).toBe('1');
    addCourse('1');
    await continuePastImport({ db: db(), enqueue, finished: '1', status: 'completed' });
    expect(readState()).toMatchObject({ state: 'done', current: null });
  });

  test('final review #2: a restart cut off a section\'s run after it wrote its row: failed, and retried', async () => {
    importing(['2', '3'], { current: '2' });
    addCourse('2'); // the run wrote the course row, then the server stopped before it finished
    queueDeps.runPastImport = vi.fn(async (request, emit) => {
      db().prepare(`INSERT OR IGNORE INTO courses (schoology_section_id, course_name, archived) VALUES (?, 'x', 1)`).run(request.sectionId);
      emit({ type: 'summary', import: { sectionId: request.sectionId } });
    });
    stop = startPastImport({ db: db(), discover: vi.fn() });
    await settled();
    expect(readState()).toMatchObject({ state: 'done', failed: ['2'], retried: true, current: null });
    expect(queueDeps.runPastImport.mock.calls.map(([r]) => r.sectionId)).toEqual(['3', '2']);
  });

  test('a finished kind all run with no import state imports the missing past sections (#178)', async () => {
    const discover = vi.fn().mockResolvedValue([row('1', '2023-2024')]);
    stop = startPastImport({ db: db(), discover });
    queueRequest({ kind: 'all', trigger: 'button' });
    await settled();
    expect(queueDeps.runPastImport.mock.calls.map(([r]) => r.sectionId)).toEqual(['1']);
    expect(readState()).toMatchObject({ state: 'done', sectionIds: ['1'] });
  });

  test('a page sync finishing does not touch a waiting import', async () => {
    markPastImportDue(db());
    const discover = vi.fn();
    stop = startPastImport({ db: db(), discover });
    addCourse('9');
    queueRequest({ kind: 'courses', courseIds: [db().prepare('SELECT id FROM courses').get().id], trigger: 'page' });
    await idle();
    await new Promise((r) => setTimeout(r, 5));
    expect(discover).not.toHaveBeenCalled();
    expect(readState().state).toBe('waiting');
  });
});
