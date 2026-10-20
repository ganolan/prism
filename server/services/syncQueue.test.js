import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { enqueue, currentSync, resumeHeld, queueDeps, resetQueue, idle, ensure, whenDone, waiterCount, SYNC_FRESH_MS } from './syncQueue.js';
import { markInterruptedRuns } from './syncRuns.js';

// A controllable run: each started run waits until the test finishes it.
function gatedRuns() {
  const started = [];
  queueDeps.runUnifiedSync = vi.fn((options, emit) => new Promise((resolve) => {
    started.push({ options, finish: (summary = { type: 'summary', mastery: [] }) => { emit(summary); resolve(); } });
  }));
  queueDeps.runTaskSync = vi.fn((request, emit) => new Promise((resolve) => {
    started.push({ request, finish: (summary = { type: 'summary', mastery: [] }) => { emit(summary); resolve(); } });
  }));
  return started;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const status = (runId) => getDb().prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId).status;

let a; let b;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM assignments; DELETE FROM courses;');
  a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sa', 'A')`).run().lastInsertRowid;
  b = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sb', 'B')`).run().lastInsertRowid;
  resetQueue();
  queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
});

describe('the sync queue', () => {
  test('an idle queue starts a request at once and records the run', async () => {
    const runs = gatedRuns();
    const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    expect(status(r.runId)).toBe('running');
    expect(runs[0].options).toMatchObject({ courseIds: [a], masteryCourseIds: [a], syncBlocks: false });
    expect(currentSync().running).toMatchObject({ runId: r.runId, courseIds: [a] });
    runs[0].finish();
    await idle();
    expect(status(r.runId)).toBe('completed');
    expect(currentSync().running).toBeNull();
  });

  test('two pages asking for the same course while it syncs share one run', async () => {
    const runs = gatedRuns();
    const first = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    const second = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    expect(second).toMatchObject({ runId: first.runId, joined: true });
    runs[0].finish();
    await idle();
    expect(queueDeps.runUnifiedSync).toHaveBeenCalledTimes(1);
  });

  test('a button press never joins a running run; it goes ahead of queued page requests', async () => {
    const runs = gatedRuns();
    const running = enqueue({ kind: 'all', trigger: 'page' });
    await tick();
    const page = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page', force: false });
    const button = enqueue({ kind: 'courses', courseIds: [a], trigger: 'button', force: true });
    expect(button.joined).toBe(false);
    expect(page.joined).toBe(true); // the running 'all' covers B for a page request
    expect(currentSync().queued.map((q) => q.runId)).toEqual([button.runId]);
    runs[0].finish();
    await tick();
    expect(runs[1].options.courseIds).toEqual([a]);
    expect(status(running.runId)).toBe('completed');
    runs[1].finish();
    await idle();
  });

  test('queued page requests run in order', async () => {
    const runs = gatedRuns();
    enqueue({ kind: 'courses', courseIds: [a], trigger: 'page', force: true });
    await tick();
    const q1 = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
    const q2 = enqueue({ kind: 'task', courseId: a, assignmentId: 'T9', trigger: 'page', force: true });
    expect(currentSync().queued.map((q) => q.runId)).toEqual([q1.runId, q2.runId]);
    runs[0].finish(); await tick();
    runs[1].finish(); await tick();
    expect(runs[2].request).toMatchObject({ kind: 'task', assignmentId: 'T9' });
    runs[2].finish();
    await idle();
  });

  test('an expired session holds the request; Schoology unreachable runs it; the nightly run never waits', async () => {
    const runs = gatedRuns();
    queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'expired' });
    const held = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await idle();
    expect(status(held.runId)).toBe('held');
    expect(currentSync().held.map((h) => h.runId)).toEqual([held.runId]);
    queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'unknown' });
    const tried = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
    await tick();
    expect(status(tried.runId)).toBe('running');
    runs[0].finish(); await idle();
    queueDeps.sessionStatus.mockClear();
    const nightly = enqueue({ kind: 'all', trigger: 'scheduled' });
    await tick();
    expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
    expect(status(nightly.runId)).toBe('running');
    runs[1].finish(); await idle();
  });

  test('while its session is being checked, a run still shows as queued (a page never thinks it ended)', async () => {
    const runs = gatedRuns();
    let release;
    queueDeps.sessionStatus = vi.fn(() => new Promise((r) => { release = () => r({ loggedIn: true, live: 'connected' }); }));
    const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    const cur = currentSync();
    expect([cur.running?.runId, ...cur.queued.map((q) => q.runId)]).toContain(r.runId);
    release();
    await tick();
    runs[0].finish();
    await idle();
  });

  test('a run whose mastery hit a sign-in error is held, and runs again after the sign-in', async () => {
    const runs = gatedRuns();
    const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    runs[0].finish({ type: 'summary', mastery: [{ courseId: a, status: 'error', errorKind: 'login' }] });
    await idle();
    expect(status(r.runId)).toBe('held');
    resumeHeld();
    await tick();
    expect(status(r.runId)).toBe('running');
    runs[1].finish();
    await idle();
    expect(status(r.runId)).toBe('completed');
  });

  test('a task request joins a course run covering its course; a forced one waits for its own', async () => {
    const runs = gatedRuns();
    const course = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    expect(enqueue({ kind: 'task', courseId: a, assignmentId: 'T1', trigger: 'page' })).toMatchObject({ runId: course.runId, joined: true });
    expect(enqueue({ kind: 'task', courseId: a, assignmentId: 'T1', trigger: 'button', force: true }).joined).toBe(false);
    runs[0].finish(); await tick();
    runs[1].finish(); await idle();
  });

  // #171: an 'all' run's mastery list is taken after its section phase (it may discover courses);
  // a course list keeps its own.
  test('a kind \'all\' request passes masteryCourseIds null; a kind \'courses\' request passes its list', async () => {
    const runs = gatedRuns();
    enqueue({ kind: 'all', trigger: 'button', force: true });
    await tick();
    expect(runs[0].options).toMatchObject({ courseIds: null, masteryCourseIds: null });
    runs[0].finish(); await idle();
    enqueue({ kind: 'courses', courseIds: [b], trigger: 'button', force: true });
    await tick();
    expect(runs[1].options).toMatchObject({ courseIds: [b], masteryCourseIds: [b] });
    runs[1].finish(); await idle();
  });

  test('a mastery-only retry covers nothing', async () => {
    const runs = gatedRuns();
    enqueue({ kind: 'courses', courseIds: [a], masteryCourseIds: [a], skipSchoology: true, trigger: 'button', force: true });
    await tick();
    expect(enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' }).joined).toBe(false);
    runs[0].finish(); await tick();
    runs[1].finish(); await idle();
  });

  test('a restart marks queued and held runs interrupted', () => {
    const db = getDb();
    for (const s of ['queued', 'held', 'running']) {
      db.prepare(`INSERT INTO sync_runs (started_at, status, options_json) VALUES (datetime('now'), ?, '{}')`).run(s);
    }
    markInterruptedRuns(db);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'interrupted'`).get().n).toBe(3);
  });

  describe('ensure: pages ask for their scope', () => {
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const setCourse = (id, cols) => getDb().prepare(`UPDATE courses SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), id);

    test('a course synced within 10 minutes is fresh; an older one is queued', async () => {
      const runs = gatedRuns();
      setCourse(a, { course_synced_at: iso(60_000) });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'fresh' });
      setCourse(a, { course_synced_at: iso(SYNC_FRESH_MS + 1000) });
      const r = ensure({ kind: 'courses', courseIds: [a] });
      expect(r).toMatchObject({ state: 'queued', runId: expect.any(Number) });
      await tick();
      runs[0].finish(); await idle();
    });

    test('a failed attempt within the window counts too (a failing course is not retried on every visit)', () => {
      setCourse(a, { course_synced_at: null, sync_attempted_at: iso(60_000) });
      // Not queued again within the window; the chip shows the failure.
      expect(ensure({ kind: 'courses', courseIds: [a] })).toMatchObject({ state: 'failed' });
      expect(currentSync().queued).toEqual([]);
    });

    test('the dashboard queues only its stale courses', async () => {
      const runs = gatedRuns();
      setCourse(a, { course_synced_at: iso(60_000) });
      ensure({ kind: 'all' });
      await tick();
      expect(runs[0].options.courseIds).toEqual([b]);
      runs[0].finish(); await idle();
    });

    test('an archived course or its task is fresh for a page (only the button re-reads it)', () => {
      setCourse(a, { archived: 1 });
      const t = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'TA', 'T')`).run(a).lastInsertRowid;
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'fresh' });
      expect(ensure({ kind: 'task', courseId: a, assignmentId: 'TA' })).toEqual({ state: 'fresh' });
      expect(t).toBeGreaterThan(0);
    });

    test('a task synced by its course\'s sync is fresh; a stale one is queued as a task run', async () => {
      const runs = gatedRuns();
      getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, task_synced_at) VALUES (?, 'T1', 'T', ?)`).run(a, iso(1000));
      expect(ensure({ kind: 'task', courseId: a, assignmentId: 'T1' })).toEqual({ state: 'fresh' });
      getDb().prepare(`UPDATE assignments SET task_synced_at = ? WHERE schoology_assignment_id = 'T1'`).run(iso(SYNC_FRESH_MS + 1000));
      ensure({ kind: 'task', courseId: a, assignmentId: 'T1' });
      await tick();
      expect(runs[0].request).toMatchObject({ kind: 'task', assignmentId: 'T1', trigger: 'page' });
      runs[0].finish(); await idle();
    });

    test('a page whose scope is already syncing follows that run', async () => {
      const runs = gatedRuns();
      const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'button', force: true });
      await tick();
      setCourse(a, { course_synced_at: iso(60_000) });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'running', runId: r.runId });
      runs[0].finish(); await idle();
    });
  });

  describe('review fixes', () => {
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const errorCount = (id) => getDb().prepare('SELECT error_count FROM sync_runs WHERE id = ?').get(id).error_count;

    test('#1: while the session is down, page visits join the held run instead of piling up', async () => {
      gatedRuns();
      queueDeps.sessionStatus.mockResolvedValue({ loggedIn: true, live: 'expired' });
      const first = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      await idle();
      expect(enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' })).toMatchObject({ runId: first.runId, state: 'held', joined: true });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'held', runId: first.runId });
      expect(currentSync().held).toHaveLength(1);
    });

    test('#1: a run whose session check passes also releases the held runs', async () => {
      const runs = gatedRuns();
      queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'expired' });
      const held = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      await idle();
      enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' }); // the session works again
      await tick();
      runs[0].finish(); await tick();
      expect(status(held.runId)).toBe('running');
      runs[1].finish(); await idle();
    });

    test('#2: a held run that succeeds after the sign-in ends completed, not with errors', async () => {
      queueDeps.runUnifiedSync = vi.fn()
        .mockImplementationOnce(async (o, emit) => {
          emit({ phase: 'mastery', courseId: a, status: 'error', errorKind: 'login', message: 'expired' });
          emit({ type: 'summary', mastery: [{ courseId: a, status: 'error', errorKind: 'login' }] });
        })
        .mockImplementation(async (o, emit) => { emit({ type: 'summary', mastery: [{ courseId: a, status: 'done' }] }); });
      const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      await idle();
      expect(status(r.runId)).toBe('held');
      expect(errorCount(r.runId)).toBe(1);
      resumeHeld();
      await idle();
      expect(status(r.runId)).toBe('completed');
      expect(errorCount(r.runId)).toBe(0);
    });

    test('#3: a request needing more than a queued run does (PowerSchool, quizzes) queues its own', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
      await tick();
      enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      const button = enqueue({ kind: 'courses', courseIds: [a], trigger: 'button', force: true, syncBlocks: true });
      expect(button.joined).toBe(false);
      const nightly = enqueue({ kind: 'all', trigger: 'scheduled', refreshQuizzes: true, syncBlocks: true });
      expect(nightly.joined).toBe(false);
      runs[0].finish(); await tick();
      runs[1].finish(); await tick();
      runs[2].finish(); await tick();
      runs[3].finish(); await idle();
    });

    test('#3: a button joining a queued page run moves it ahead of the other page runs', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'courses', courseIds: [a], trigger: 'page', force: true });
      await tick();
      const p1 = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
      const c = getDb().prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sc', 'C')`).run().lastInsertRowid;
      const p2 = enqueue({ kind: 'courses', courseIds: [c], trigger: 'page' });
      const button = enqueue({ kind: 'courses', courseIds: [c], trigger: 'button', force: true });
      expect(button).toMatchObject({ runId: p2.runId, joined: true });
      expect(currentSync().queued.map((q) => q.runId)).toEqual([p2.runId, p1.runId]);
      for (const _ of [0, 1, 2]) { runs.at(-1)?.finish(); await tick(); }
      runs.forEach((r) => r.finish());
      await idle();
    });

    test('#4: a revisit after a failed attempt answers failed, with that run', async () => {
      const run = getDb().prepare(`INSERT INTO sync_runs (started_at, status, options_json) VALUES (datetime('now'), 'completed_with_errors', ?)`)
        .run(JSON.stringify({ kind: 'courses', courseIds: [a], coveredCourseIds: [a] })).lastInsertRowid;
      getDb().prepare('UPDATE courses SET course_synced_at = ?, sync_attempted_at = ? WHERE id = ?').run(iso(SYNC_FRESH_MS * 3), iso(60_000), a);
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'failed', runId: run });
    });

    test('#5: the dashboard leaves out a course that is syncing right now', async () => {
      const runs = gatedRuns();
      const own = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      await tick();
      const dash = ensure({ kind: 'all' });
      expect(dash.runId).not.toBe(own.runId);
      expect(currentSync().queued[0].courseIds).toEqual([b]);
      runs[0].finish(); await tick();
      runs[1].finish(); await idle();
    });

    test('#8: a run that throws still records the attempt (no retry on every visit)', async () => {
      queueDeps.runUnifiedSync = vi.fn(async () => { throw new Error('Schoology API 503'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      await idle();
      errSpy.mockRestore();
      expect(getDb().prepare('SELECT sync_attempted_at FROM courses WHERE id = ?').get(a).sync_attempted_at).not.toBeNull();
      expect(ensure({ kind: 'courses', courseIds: [a] }).state).toBe('failed');
    });

    test('#170 item 8: a course scope\'s "Sync failed" chip ignores failed task and quiz runs', () => {
      const add = (status, o) => getDb().prepare(`INSERT INTO sync_runs (started_at, status, options_json) VALUES (datetime('now'), ?, ?)`)
        .run(status, JSON.stringify(o)).lastInsertRowid;
      const courseRun = add('failed', { kind: 'courses', courseIds: [a], coveredCourseIds: [a] });
      add('failed', { kind: 'task', courseId: a, assignmentId: 'T1', coveredCourseIds: [a] });
      add('failed', { kind: 'quiz', groupId: 3, coveredCourseIds: [a] });
      getDb().prepare('UPDATE courses SET course_synced_at = ?, sync_attempted_at = ? WHERE id = ?').run(iso(SYNC_FRESH_MS * 3), iso(60_000), a);
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'failed', runId: courseRun });
    });

    test('#170 item 8: a task scope still finds its own failed run', () => {
      const t = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, task_sync_attempted_at) VALUES (?, 'T1', 'T', ?)`)
        .run(a, iso(60_000)).lastInsertRowid;
      const run = getDb().prepare(`INSERT INTO sync_runs (started_at, status, options_json) VALUES (datetime('now'), 'failed', ?)`)
        .run(JSON.stringify({ kind: 'task', courseId: a, assignmentId: 'T1', coveredCourseIds: [a] })).lastInsertRowid;
      expect(ensure({ kind: 'task', courseId: a, assignmentId: 'T1' })).toEqual({ state: 'failed', runId: run });
      expect(t).toBeGreaterThan(0);
    });

    test('#170 item 9: a waiter that gives up is removed', async () => {
      gatedRuns();
      const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      const w = whenDone(r.runId);
      whenDone(r.runId);
      expect(waiterCount(r.runId)).toBe(2);
      w.cancel();
      expect(waiterCount(r.runId)).toBe(1);
    });

    test('minor: a PowerSchool-only retry reads every course (not an empty list)', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'courses', courseIds: [], masteryCourseIds: [], skipSchoology: true, syncBlocks: true, trigger: 'button', force: true });
      await tick();
      expect(runs[0].options.courseIds).toBeNull();
      runs[0].finish(); await idle();
    });
  });

  describe('quiz loads (#131)', () => {
    const quiz = { kind: 'quiz', groupId: 7, trigger: 'button', noHold: true };
    beforeEach(() => { queueDeps.runQuizLoad = vi.fn(async (request, emit) => emit({ type: 'summary', quiz: {} })); });

    test('a quiz request joins only a queued or running quiz run of the same group', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'courses', courseIds: [a], trigger: 'page', force: true });
      await tick();
      const x = enqueue(quiz);
      expect(enqueue(quiz)).toMatchObject({ runId: x.runId, joined: true });
      expect(enqueue({ ...quiz, groupId: 8 }).joined).toBe(false);
      expect(currentSync().queued.map((q) => [q.kind, q.groupId, q.courseIds])).toEqual([['quiz', 7, []], ['quiz', 8, []]]);
      runs[0].finish();
      await tick();
    });

    test('a quiz run covers no course or task: ensure queues its own', async () => {
      queueDeps.runQuizLoad = vi.fn(() => new Promise(() => {}));
      enqueue(quiz);
      await tick();
      expect(currentSync().running).toMatchObject({ kind: 'quiz', groupId: 7, courseIds: [] });
      const quizRunId = currentSync().running.runId;
      const task = enqueue({ kind: 'task', courseId: a, assignmentId: 'T1', trigger: 'page' });
      expect(task.joined).toBe(false);
      const ensured = ensure({ kind: 'courses', courseIds: [b] });
      expect(ensured.state).toBe('queued');
      expect([task.runId, ensured.runId]).not.toContain(quizRunId);
      expect(enqueue({ kind: 'all', trigger: 'page' }).joined).toBe(false);
    });

    test('a quiz run records no attempt stamp and runs through queueDeps.runQuizLoad', async () => {
      queueDeps.runQuizLoad = vi.fn(async (request, emit) => emit({ type: 'summary', quiz: { attempts: 2 } }));
      const r = enqueue(quiz);
      await idle();
      expect(queueDeps.runQuizLoad).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quiz', groupId: 7 }), expect.any(Function));
      expect(status(r.runId)).toBe('completed');
      expect(getDb().prepare('SELECT COUNT(*) n FROM courses WHERE sync_attempted_at IS NOT NULL').get().n).toBe(0);
      expect(JSON.parse(getDb().prepare('SELECT summary_json FROM sync_runs WHERE id = ?').get(r.runId).summary_json)).toMatchObject({ quiz: { attempts: 2 } });
    });

    test('a noHold run whose session check fails finishes failed (never held)', async () => {
      queueDeps.runQuizLoad = vi.fn();
      queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'expired' });
      const r = enqueue(quiz);
      await idle();
      expect(status(r.runId)).toBe('failed');
      expect(queueDeps.runQuizLoad).not.toHaveBeenCalled();
      expect(currentSync().held).toEqual([]);
      expect(JSON.parse(getDb().prepare('SELECT summary_json FROM sync_runs WHERE id = ?').get(r.runId).summary_json))
        .toMatchObject({ fatal: true, quizError: { code: 'NO_SESSION' } });
    });

    test('a noHold run still runs when Schoology was not reached (unknown)', async () => {
      queueDeps.runQuizLoad = vi.fn(async (request, emit) => emit({ type: 'summary', quiz: {} }));
      queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'unknown' });
      const r = enqueue(quiz);
      await idle();
      expect(status(r.runId)).toBe('completed');
    });
  });

  describe('grading sync (#131)', () => {
    const grading = { kind: 'task', assignmentId: '950', grading: true, trigger: 'button' };

    test('a grading request joins only a grading run of the same task', () => {
      gatedRuns();
      const x = enqueue({ ...grading, courseId: a });
      const y = enqueue({ ...grading, courseId: a });
      expect(y).toMatchObject({ runId: x.runId, joined: true });
      expect(enqueue({ ...grading, courseId: a, assignmentId: '951' }).joined).toBe(false);
    });

    // #170: this test also covered a QUEUED plain task run, which a grading request now upgrades
    // and joins (item 1 below); a RUNNING plain run is still never joined.
    test('a grading request never joins a course run', () => {
      gatedRuns();
      const course = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
      const g = enqueue({ ...grading, courseId: a });
      expect(g.joined).toBe(false);
      expect(g.runId).not.toBe(course.runId);
    });

    test('#170 item 1: a grading request upgrades a QUEUED plain run of the task (joins it, lifts it as a button)', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' }); // runs, so the next ones wait
      await tick();
      const c = getDb().prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sc', 'C')`).run().lastInsertRowid;
      const other = enqueue({ kind: 'courses', courseIds: [c], trigger: 'page' });
      const plain = enqueue({ kind: 'task', courseId: a, assignmentId: '950', trigger: 'page' });
      const g = enqueue({ ...grading, courseId: a });
      expect(g).toMatchObject({ runId: plain.runId, state: 'queued', joined: true });
      expect(currentSync().queued.map((q) => q.runId)).toEqual([plain.runId, other.runId]);
      expect(JSON.parse(getDb().prepare('SELECT options_json FROM sync_runs WHERE id = ?').get(plain.runId).options_json))
        .toMatchObject({ grading: true, trigger: 'button' });
      runs[0].finish(); await tick();
      expect(runs[1].request).toMatchObject({ kind: 'task', assignmentId: '950', grading: true, trigger: 'button' });
      runs[1].finish(); await tick();
      runs[2].finish(); await idle();
    });

    test('#170 item 1: a RUNNING plain run of the task is not joined', async () => {
      const runs = gatedRuns();
      const plain = enqueue({ kind: 'task', courseId: a, assignmentId: '950', trigger: 'page' });
      await tick();
      expect(status(plain.runId)).toBe('running');
      const g = enqueue({ ...grading, courseId: a });
      expect(g.joined).toBe(false);
      expect(runs[0].request.grading).toBeUndefined();
      runs[0].finish(); await tick();
      expect(runs[1].request).toMatchObject({ grading: true });
      runs[1].finish(); await idle();
    });

    test('#170 item 6: a request whose session was checked under 60 s ago is not checked again', async () => {
      const runs = gatedRuns();
      enqueue({ ...grading, courseId: a, sessionCheckedAt: Date.now() - 5_000, sessionLive: 'connected' });
      await tick();
      expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
      expect(runs).toHaveLength(1);
      runs[0].finish(); await idle();
      enqueue({ ...grading, courseId: a, sessionCheckedAt: Date.now() - 61_000, sessionLive: 'connected' });
      await tick();
      expect(queueDeps.sessionStatus).toHaveBeenCalledTimes(1);
      runs[1].finish(); await idle();
    });

    test('#170 review 3: the session check stays on the in-memory request, never in options_json', async () => {
      gatedRuns();
      const options = (id) => JSON.parse(getDb().prepare('SELECT options_json FROM sync_runs WHERE id = ?').get(id).options_json);
      enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' }); // runs, so the next ones wait
      await tick();
      const g = enqueue({ ...grading, courseId: a, sessionCheckedAt: Date.now(), sessionLive: 'connected' });
      expect(options(g.runId)).toMatchObject({ grading: true });
      expect(options(g.runId)).not.toHaveProperty('sessionCheckedAt');
      expect(options(g.runId)).not.toHaveProperty('sessionLive');
      const plain = enqueue({ kind: 'task', courseId: a, assignmentId: '951', trigger: 'page' });
      enqueue({ ...grading, courseId: a, assignmentId: '951', sessionCheckedAt: Date.now(), sessionLive: 'unknown' }); // absorbed
      expect(options(plain.runId)).toMatchObject({ grading: true });
      expect(options(plain.runId)).not.toHaveProperty('sessionCheckedAt');
      expect(options(plain.runId)).not.toHaveProperty('sessionLive');
      expect(currentSync().queued.map((q) => q.runId)).toContain(plain.runId);
    });

    test('#170 item 6: a scheduled run is never checked, whatever it carries', async () => {
      const runs = gatedRuns();
      enqueue({ kind: 'all', trigger: 'scheduled' });
      await tick();
      expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
      runs[0].finish(); await idle();
    });

    test('a plain task request joins a queued grading run (it reads more)', async () => {
      gatedRuns();
      enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' }); // holds the queue so the next ones wait
      await tick();
      const g = enqueue({ ...grading, courseId: a });
      expect(g.state).toBe('queued');
      expect(enqueue({ kind: 'task', courseId: a, assignmentId: '950', trigger: 'page' })).toMatchObject({ runId: g.runId, joined: true });
    });

    test('a grading request joins a RUNNING grading run of the same task', async () => {
      const runs = gatedRuns();
      const x = enqueue({ ...grading, courseId: a });
      await tick();
      expect(status(x.runId)).toBe('running');
      expect(enqueue({ ...grading, courseId: a })).toMatchObject({ runId: x.runId, state: 'running', joined: true });
      runs[0].finish();
      await idle();
      expect(queueDeps.runTaskSync).toHaveBeenCalledTimes(1);
    });
  });
});

