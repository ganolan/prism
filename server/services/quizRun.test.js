import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { queueDeps, resetQueue, idle, currentSync, enqueue, waiterCount } from './syncQueue.js';
import { runQuizLoad } from './quizLoadRun.js';
import { loadQuizQueued } from './quizRun.js';
import { QuizError } from './quizError.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const runs = () => getDb().prepare('SELECT * FROM sync_runs ORDER BY id').all();

let g; let course;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM assignments; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'Ep 1')`).run(course).lastInsertRowid;
  resetQueue();
  queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
  queueDeps.runQuizLoad = vi.fn(async (request, emit) => emit({ type: 'summary', quiz: { attempts: 1 } }));
});

describe('runQuizLoad (a quiz load as a queued run)', () => {
  const request = () => ({ kind: 'quiz', groupId: g, trigger: 'button', noHold: true });

  test('emits the loadGroup summary', async () => {
    const events = [];
    const loadGroup = vi.fn().mockResolvedValue({ attempts: 18 });
    await runQuizLoad(request(), (e) => events.push(e), { db: getDb(), deps: { loadGroup } });
    expect(loadGroup).toHaveBeenCalledWith(getDb(), { groupId: g });
    expect(events).toEqual([{ type: 'summary', quiz: { attempts: 18 } }]);
  });

  test('a QuizError ends the run with a fatal summary that carries its code', async () => {
    const events = [];
    const loadGroup = vi.fn().mockRejectedValue(new QuizError('BUSY', 'already loading'));
    await runQuizLoad(request(), (e) => events.push(e), { db: getDb(), deps: { loadGroup } });
    expect(events).toEqual([{ type: 'summary', fatal: true, quizError: { code: 'BUSY', message: 'already loading' } }]);
  });

  test('any other error is left for the queue to log', async () => {
    const loadGroup = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runQuizLoad(request(), () => {}, { db: getDb(), deps: { loadGroup } })).rejects.toThrow('boom');
  });
});

describe('loadQuizQueued', () => {
  test('a lapsed session answers NO_SESSION at once and queues nothing', async () => {
    queueDeps.sessionStatus.mockResolvedValue({ loggedIn: true, live: 'expired' });
    await expect(loadQuizQueued(getDb(), g)).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(runs()).toHaveLength(0);
    expect(currentSync().running).toBeNull();
    expect(currentSync().queued).toEqual([]);
  });

  test('no saved session is NO_SESSION too', async () => {
    queueDeps.sessionStatus.mockResolvedValue({ loggedIn: false, live: 'none' });
    await expect(loadQuizQueued(getDb(), g)).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(runs()).toHaveLength(0);
  });

  test('an unknown group is NOT_FOUND and queues nothing', async () => {
    await expect(loadQuizQueued(getDb(), 9999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(runs()).toHaveLength(0);
  });

  test('a load waits its turn behind a running sync, then returns the loadGroup summary', async () => {
    let release;
    queueDeps.runUnifiedSync = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    enqueue({ kind: 'courses', courseIds: [course], trigger: 'page' });
    await tick();
    expect(queueDeps.runUnifiedSync).toHaveBeenCalled();
    const pending = loadQuizQueued(getDb(), g, { waitMs: 2000 });
    await tick();
    expect(queueDeps.runQuizLoad).not.toHaveBeenCalled();
    expect(currentSync().queued).toMatchObject([{ kind: 'quiz', groupId: g, courseIds: [] }]);
    release();
    await expect(pending).resolves.toEqual({ attempts: 1 });
    expect(queueDeps.runQuizLoad).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quiz', groupId: g }), expect.any(Function));
    await idle();
    const quiz = runs().find((r) => JSON.parse(r.options_json).kind === 'quiz');
    expect(quiz.status).toBe('completed');
  });

  test('a loadGroup QuizError becomes the answer (BUSY keeps its meaning)', async () => {
    queueDeps.runQuizLoad = vi.fn(async (request, emit) => emit({ type: 'summary', fatal: true, quizError: { code: 'BUSY', message: 'already loading' } }));
    const err = await loadQuizQueued(getDb(), g).catch((e) => e);
    expect(err).toBeInstanceOf(QuizError);
    expect([err.code, err.message]).toEqual(['BUSY', 'already loading']);
    expect(runs().at(-1).status).toBe('failed');
  });

  test('a run that dies without a summary is a plain error', async () => {
    queueDeps.runQuizLoad = vi.fn(async () => { throw new Error('boom'); });
    const err = await loadQuizQueued(getDb(), g).catch((e) => e);
    expect(err).not.toBeInstanceOf(QuizError);
    expect(err.message).toMatch(/did not finish/);
  });

  test('#170 item 9: a load that times out removes its waiter', async () => {
    queueDeps.runQuizLoad = vi.fn(() => new Promise(() => {}));
    const err = await loadQuizQueued(getDb(), g, { waitMs: 20 }).catch((e) => e);
    expect(err.code).toBe('PENDING');
    expect(waiterCount(err.runId)).toBe(0);
  });

  test('a wait past waitMs answers PENDING with the run id; loading again joins that run', async () => {
    let release;
    queueDeps.runQuizLoad = vi.fn((request, emit) => new Promise((resolve) => {
      release = () => { emit({ type: 'summary', quiz: { attempts: 4 } }); resolve(); };
    }));
    const err = await loadQuizQueued(getDb(), g, { waitMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(QuizError);
    expect(err.code).toBe('PENDING');
    expect(err.runId).toBe(runs()[0].id);
    const again = loadQuizQueued(getDb(), String(g), { waitMs: 2000 });
    await tick();
    release();
    await expect(again).resolves.toEqual({ attempts: 4 });
    expect(runs()).toHaveLength(1);
    expect(queueDeps.runQuizLoad).toHaveBeenCalledTimes(1);
  });
});
