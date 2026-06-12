import { describe, it, expect } from 'vitest';
import { draftBaseline } from './assessmentDraft.js';

describe('draftBaseline', () => {
  const topics = [{ id: 't1' }, { id: 't2' }];

  it('produces the same signature for equal synced state', () => {
    const s = { grade_comment: 'hi', comment_status: 1, exception: null, scores: { t1: { grade: 'ED' } } };
    expect(draftBaseline(s, topics)).toBe(draftBaseline({ ...s }, topics));
  });

  it('changes when the synced comment changes', () => {
    const a = { grade_comment: 'hi', comment_status: 1, exception: null, scores: {} };
    const b = { ...a, grade_comment: 'bye' };
    expect(draftBaseline(a, topics)).not.toBe(draftBaseline(b, topics));
  });

  it('changes when a synced topic score changes', () => {
    const a = { grade_comment: '', comment_status: 0, exception: null, scores: { t1: { grade: 'ED' } } };
    const b = { grade_comment: '', comment_status: 0, exception: null, scores: { t1: { grade: 'D' } } };
    expect(draftBaseline(a, topics)).not.toBe(draftBaseline(b, topics));
  });

  it('produces the same signature regardless of topic array order', () => {
    const student = {
      grade_comment: '', comment_status: 0, exception: null,
      scores: { t1: { grade: 'ED' }, t2: { grade: 'D' } },
    };
    const forward = [{ id: 't1' }, { id: 't2' }];
    const reversed = [{ id: 't2' }, { id: 't1' }];
    expect(draftBaseline(student, forward)).toBe(draftBaseline(student, reversed));
  });

  it('handles empty topics and a student with no scores', () => {
    const a = draftBaseline({ grade_comment: 'x', comment_status: 1, exception: null }, []);
    const b = draftBaseline({ grade_comment: 'x', comment_status: 1, exception: null, scores: {} }, []);
    expect(a).toBe(b);
  });
});
