import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/api.js', () => ({
  saveAssessmentDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAssessmentDraft: vi.fn(() => Promise.resolve({ ok: true })),
  draftBeaconBody: (d) => JSON.stringify(d),
  DRAFTS_PATH: '/api/assessment-drafts',
}));

import { saveAssessmentDraft, deleteAssessmentDraft } from '../services/api.js';
import { makeDraftSaver } from './assessmentDraftSaver.js';

const target = { assignmentId: 'sa-1', studentId: 7, enrollmentId: 'enr-1' };
// The route's snake_case wire contract that the saver maps the target into.
const wire = (draft) => ({ assignment_id: 'sa-1', student_id: 7, enrollment_id: 'enr-1', draft });

beforeEach(() => {
  vi.useFakeTimers();
  saveAssessmentDraft.mockClear();
  deleteAssessmentDraft.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('makeDraftSaver', () => {
  it('debounces a save: one POST after the delay, not per call', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'a' });
    s.save({ comment: 'ab' });
    s.save({ comment: 'abc' });
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
    expect(saveAssessmentDraft).toHaveBeenCalledWith(wire({ comment: 'abc' }));
  });

  it('immediate save fires synchronously with no timer wait', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ pending: { t1: 'ED' } }, { immediate: true });
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('remove() debounces a DELETE', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.remove();
    vi.advanceTimersByTime(500);
    expect(deleteAssessmentDraft).toHaveBeenCalledWith(target);
  });

  it('a newer save supersedes a queued delete', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.remove();
    s.save({ comment: 'back' });
    vi.advanceTimersByTime(500);
    expect(deleteAssessmentDraft).not.toHaveBeenCalled();
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('flush() sends a pending save immediately via keepalive when no beacon', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'x' });
    s.flush();
    expect(saveAssessmentDraft).toHaveBeenCalledWith(wire({ comment: 'x' }), { keepalive: true });
  });

  // #40 review: a flag write can restore a saved grade into the server draft, so the card first
  // settles a queued save (or delete) and waits for it: a debounced one landing later would
  // overwrite the restored draft.
  it('settle() sends a queued save now, returns its promise, and leaves nothing for the timer', async () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'typing' });
    const p = s.settle();
    expect(saveAssessmentDraft).toHaveBeenCalledWith(wire({ comment: 'typing' }));
    await expect(p).resolves.toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('settle() sends a queued delete now', async () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.remove();
    await s.settle();
    expect(deleteAssessmentDraft).toHaveBeenCalledWith(target);
    vi.advanceTimersByTime(1000);
    expect(deleteAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('settle() with nothing queued resolves and sends nothing', async () => {
    const s = makeDraftSaver(target, { delay: 500 });
    await expect(s.settle()).resolves.toBeUndefined();
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
    expect(deleteAssessmentDraft).not.toHaveBeenCalled();
  });

  it('settle() resolves even when the save fails (best effort)', async () => {
    saveAssessmentDraft.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'x' });
    await expect(s.settle()).resolves.toBeUndefined();
  });

  it('flush() is a no-op when nothing is pending', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.flush();
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
  });

  it('flush({ beacon: true }) uses navigator.sendBeacon when available', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'x' });
    s.flush({ beacon: true });
    expect(beacon).toHaveBeenCalledWith('/api/assessment-drafts', JSON.stringify(wire({ comment: 'x' })));
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
