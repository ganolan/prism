import { describe, it, expect, beforeEach, vi } from 'vitest';
import { draftKey, readDraft, writeDraft, clearDraft } from './assessmentDraft.js';

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
