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

  it('includes the score when asked, even with topics (feedback rows)', () => {
    const s = { grade_comment: '', comment_status: 0, exception: null, scores: {}, score: 75 };
    expect(draftBaseline(s, topics, { includeScore: true })).not.toBe(draftBaseline({ ...s, score: 50 }, topics, { includeScore: true }));
    expect(draftBaseline(s, topics)).toBe(draftBaseline({ ...s, score: 50 }, topics));
  });

  describe('row levels (feedback rows)', () => {
    const s = { grade_comment: 'c', comment_status: 1, exception: null, scores: {}, score: 75 };

    it('empty or missing row levels give the plain score-scale signature', () => {
      const plain = draftBaseline(s, [], { includeScore: true });
      expect(draftBaseline(s, [], { includeScore: true, rowLevels: {} })).toBe(plain);
      expect(draftBaseline(s, [], { includeScore: true, rowLevels: undefined })).toBe(plain);
      expect(draftBaseline(s, [], { includeScore: true, rowLevels: null })).toBe(plain);
    });

    it('row finals change the signature', () => {
      const plain = draftBaseline(s, [], { includeScore: true });
      const a = draftBaseline(s, [], { includeScore: true, rowLevels: { Playtesting: 'EX' } });
      const b = draftBaseline(s, [], { includeScore: true, rowLevels: { Playtesting: 'D' } });
      expect(a).not.toBe(plain);
      expect(a).not.toBe(b);
    });

    it('row key order does not change the signature', () => {
      const a = draftBaseline(s, [], { includeScore: true, rowLevels: { Playtesting: 'EX', 'Features and Code': 'D' } });
      const b = draftBaseline(s, [], { includeScore: true, rowLevels: { 'Features and Code': 'D', Playtesting: 'EX' } });
      expect(a).toBe(b);
    });
  });
});

// Triage's Loose ends checks draft validity on the server with a mirror of this module.
import * as server from '../../../server/lib/assessmentDraft.js';

describe('parity with server/lib/assessmentDraft.js', () => {
  const student = {
    scores: { t2: { grade: 'EX' }, t1: { grade: 'D' } }, grade_comment: 'Good', comment_status: 1,
    exception: 0, score: 3, row_levels: { Design: 'EX', Build: 'D' },
  };
  const topics = [{ id: 't2' }, { id: 't1' }];
  it.each([
    ['aligned', [student, topics, {}]],
    ['score scale with rows', [student, [], { includeScore: true, rowLevels: student.row_levels }]],
    ['score scale, no rows', [student, [], { includeScore: true, rowLevels: {} }]],
    ['no topics, default', [{}, []]],
    ['includeScore false', [student, [], { includeScore: false }]],
  ])('%s', (_name, args) => {
    expect(server.draftBaseline(...args)).toBe(draftBaseline(...args));
  });
});
