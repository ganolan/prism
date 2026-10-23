import { describe, it, expect, vi, afterEach } from 'vitest';
import * as api from './api.js';
import { getSyncRuns, getSyncRun, getSyncRunEvents, getCurrentSync, previewStatusLine, getStatusLineUntil, undoResubmission, undoExtension, recordExtension } from './api.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('sync run endpoints', () => {
  const ok = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it('getSyncRuns / getSyncRun / getSyncRunEvents / getCurrentSync hit the right URLs', async () => {
    const f = ok({});
    vi.stubGlobal('fetch', f);
    await getSyncRuns(30);
    await getSyncRuns();
    await getSyncRun(5);
    await getSyncRunEvents(5, 12);
    await getCurrentSync();
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      '/api/sync/runs?limit=30',
      '/api/sync/runs?limit=60', // the default: twice the server's KEEP_RUNS
      '/api/sync/runs/5',
      '/api/sync/runs/5/events?after=12',
      '/api/sync/current',
    ]);
  });
});

describe('triage status lines (Amendment B)', () => {
  const ok = (body = {}) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it('preview / until / undo-with-removeLine hit the right URLs', async () => {
    const f = ok();
    vi.stubGlobal('fetch', f);
    await previewStatusLine({ studentId: 7, assignmentId: 30, line: '⟳ Due Thu 08/10. a&b' });
    await getStatusLineUntil({ kind: 'ask', studentId: 7, assignmentId: 30, lessons: 3 });
    await getStatusLineUntil({ kind: 'grade_stands', resubmissionId: 41 });
    await undoResubmission(41, { removeLine: true });
    await undoResubmission(42);
    await undoExtension(9, { removeLine: true });
    await undoExtension(10);
    const urls = f.mock.calls.map((c) => c[0]);
    expect(new URL(urls[0], 'http://x').searchParams.get('line')).toBe('⟳ Due Thu 08/10. a&b');
    expect(urls.slice(1)).toEqual([
      '/api/triage/status-line/until?kind=ask&studentId=7&assignmentId=30&lessons=3',
      '/api/triage/status-line/until?kind=grade_stands&resubmissionId=41',
      '/api/triage/resubmissions/41?removeLine=1',
      '/api/triage/resubmissions/42',
      '/api/triage/extensions/9?removeLine=1',
      '/api/triage/extensions/10',
    ]);
    expect(f.mock.calls.slice(3).every((c) => c[1].method === 'DELETE')).toBe(true);
  });

  it('a failed write carries the server code and `published`, so the UI can say the comment WAS changed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ error: 'The comment WAS published…', code: 'RECORD_FAILED_AFTER_PUBLISH', published: true, comment: 'L1' }),
    }));
    await expect(recordExtension({ studentId: 1, assignmentId: 2, lessons: 3, commentLine: 'L1' }))
      .rejects.toMatchObject({ message: 'The comment WAS published…', code: 'RECORD_FAILED_AFTER_PUBLISH', published: true, status: 500 });
  });

  it('a failed write also carries the parity `differences` from the error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ error: 'Different questions', differences: [{ assignmentId: 2, title: 'B', missing: [], extra: ['Q?'] }] }),
    }));
    await expect(api.checkQuizParity(['1', '2']))
      .rejects.toMatchObject({ status: 409, differences: [{ assignmentId: 2, title: 'B', missing: [], extra: ['Q?'] }] });
  });

  it('the Reviewed call is gone', () => {
    expect(api.reviewResubmission).toBeUndefined();
  });
});

describe('the sync queue (background sync)', () => {
  it('startSync, ensureSync and resumeSync POST JSON and answer it', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push([url, opts.method, opts.body]);
      return { ok: true, status: 200, json: async () => ({ runId: 4, state: 'queued', joined: false }) };
    }));
    expect(await api.startSync({ courseIds: [5] })).toEqual({ runId: 4, state: 'queued', joined: false });
    await api.ensureSync({ kind: 'courses', courseIds: [5] });
    await api.resumeSync();
    expect(calls).toEqual([
      ['/api/sync', 'POST', JSON.stringify({ courseIds: [5] })],
      ['/api/sync/ensure', 'POST', JSON.stringify({ scope: { kind: 'courses', courseIds: [5] } })],
      ['/api/sync/resume', 'POST', '{}'],
    ]);
  });
});


describe('updateParent (#173)', () => {
  it('PUTs the teacher\'s extra phone and email to the parent', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 3 }) });
    vi.stubGlobal('fetch', f);
    await api.updateParent(7, 3, { phone: '0000 0001', extra_email: null });
    expect(f).toHaveBeenCalledWith('/api/students/7/parents/3', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ phone: '0000 0001', extra_email: null }),
    }));
  });
});

describe('getProficiencyScale', () => {
  it('requests once per page load, and again after a failure', async () => {
    const scale = { schoologyScaleId: 1, levels: [] };
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({ error: 'down' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => scale });
    vi.stubGlobal('fetch', f);
    await expect(api.getProficiencyScale()).rejects.toThrow('down');
    const [a, b] = await Promise.all([api.getProficiencyScale(), api.getProficiencyScale()]);
    expect(a).toEqual(scale);
    expect(b).toBe(a);
    expect(await api.getProficiencyScale()).toBe(a);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/proficiency-scale', '/api/proficiency-scale']);
  });
});

describe('assessment drafts', () => {
  it('getDraftsForAssignment reads the class, or with studentId that one student\'s draft', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    await api.getDraftsForAssignment('8');
    await api.getDraftsForAssignment('8', { studentId: 7 });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      '/api/assessment-drafts?assignment_id=8',
      '/api/assessment-drafts?assignment_id=8&student_id=7',
    ]);
  });
});
