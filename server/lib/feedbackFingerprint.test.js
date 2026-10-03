import { describe, test, expect } from 'vitest';
import { fingerprint, hasPriorFeedback } from './feedbackFingerprint.js';

describe('fingerprint', () => {
  test('stable JSON shape with sorted levels', () => {
    const fp = fingerprint({
      score: 80,
      exception: 0,
      comment: 'Nice work',
      commentStatus: 1,
      levels: [{ topic_id: 'T2', grade: 'M' }, { topic_id: 'T1', grade: 'E' }],
    });
    expect(fp).toBe('{"s":80,"e":0,"l":["T1:E","T2:M"],"c":"Nice work"}');
  });

  test('is stable for equivalent input', () => {
    const input = { score: 0, exception: 2, comment: 'x', commentStatus: 1, levels: [] };
    expect(fingerprint(input)).toBe(fingerprint({ ...input }));
  });

  test('a hidden comment (commentStatus 0) is ignored', () => {
    const fp = fingerprint({ score: null, exception: 0, comment: 'secret note', commentStatus: 0, levels: [] });
    expect(fp).toBe('{"s":null,"e":0,"l":[],"c":""}');
  });

  test('a hidden comment (commentStatus null) is ignored', () => {
    const fp = fingerprint({ score: null, exception: 0, comment: 'secret note', commentStatus: null, levels: [] });
    expect(fp).toBe('{"s":null,"e":0,"l":[],"c":""}');
  });

  test('strips the stored status line from a visible comment', () => {
    const fp = fingerprint({
      score: 80,
      exception: 0,
      comment: 'L1\n\nGreat work.',
      commentStatus: 1,
      storedLine: 'L1',
      levels: [],
    });
    expect(fp).toBe('{"s":80,"e":0,"l":[],"c":"Great work."}');
  });

  test('a comment that is only the stored line yields empty teacher text', () => {
    const fp = fingerprint({ score: null, exception: 0, comment: 'L1', commentStatus: 1, storedLine: 'L1', levels: [] });
    expect(fp).toBe('{"s":null,"e":0,"l":[],"c":""}');
  });
});

describe('hasPriorFeedback', () => {
  test('true for a score of 0', () => {
    expect(hasPriorFeedback(fingerprint({ score: 0, exception: 0, comment: '', commentStatus: 0, levels: [] }))).toBe(true);
  });
  test('true for an exception', () => {
    expect(hasPriorFeedback(fingerprint({ score: null, exception: 3, comment: '', commentStatus: 0, levels: [] }))).toBe(true);
  });
  test('true for rubric levels', () => {
    expect(
      hasPriorFeedback(fingerprint({ score: null, exception: 0, comment: '', commentStatus: 0, levels: [{ topic_id: 'T1', grade: 'M' }] }))
    ).toBe(true);
  });
  test('true for visible teacher text', () => {
    expect(hasPriorFeedback(fingerprint({ score: null, exception: 0, comment: 'Fix this', commentStatus: 1, levels: [] }))).toBe(true);
  });
  test('false when score, exception, levels and comment are all empty', () => {
    expect(hasPriorFeedback(fingerprint({ score: null, exception: 0, comment: '', commentStatus: 0, levels: [] }))).toBe(false);
  });
  test('false for a hidden comment with no other feedback', () => {
    expect(hasPriorFeedback(fingerprint({ score: null, exception: 0, comment: 'hidden note', commentStatus: 0, levels: [] }))).toBe(false);
  });
  test('false for falsy fingerprint input', () => {
    expect(hasPriorFeedback('')).toBe(false);
    expect(hasPriorFeedback(null)).toBe(false);
    expect(hasPriorFeedback(undefined)).toBe(false);
  });
});
