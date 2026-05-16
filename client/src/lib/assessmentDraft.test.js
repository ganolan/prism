import { describe, it, expect, beforeEach, vi } from 'vitest';
import { draftKey, readDraft, writeDraft, clearDraft, draftBaseline } from './assessmentDraft.js';

beforeEach(() => {
  localStorage.clear();
});

describe('draftKey', () => {
  it('builds a namespaced key from course, assignment, and enrollment ids', () => {
    expect(draftKey('4', '8216461388', '99')).toBe(
      'prism:assessment-draft:4:8216461388:99'
    );
  });
});

describe('writeDraft / readDraft', () => {
  it('round-trips a draft object', () => {
    const key = draftKey('4', '8', '1');
    const draft = { pending: { t1: 'ED' }, comment: 'hi', display: true };
    writeDraft(key, draft);
    expect(readDraft(key)).toEqual(draft);
  });

  it('returns null when no draft is stored', () => {
    expect(readDraft(draftKey('4', '8', '1'))).toBeNull();
  });

  it('returns null when the stored value is not valid JSON', () => {
    const key = draftKey('4', '8', '1');
    localStorage.setItem(key, '{not json');
    expect(readDraft(key)).toBeNull();
  });

  it('does not throw when localStorage.setItem fails', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const key = draftKey('4', '8', '1');
    expect(() => writeDraft(key, { pending: {}, comment: 'x', display: true })).not.toThrow();
    spy.mockRestore();
  });
});

describe('clearDraft', () => {
  it('removes a stored draft', () => {
    const key = draftKey('4', '8', '1');
    writeDraft(key, { pending: {}, comment: 'x', display: false });
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });
});

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
