import { describe, it, expect } from 'vitest';
import { sameInSchoology, afterRefresh } from './assessmentFreshness.js';

const data = (over = {}) => ({
  topics: [{ id: 't1' }, { id: 't2' }],
  students: [
    { schoology_uid: '2', scores: { t1: { grade: 'EX' } }, grade_comment: 'Good', comment_status: 1, exception: 0, resubmit_flag: null },
    { schoology_uid: '1', scores: {}, grade_comment: '', comment_status: null, exception: 0 },
  ],
  ...over,
});

describe('sameInSchoology (#52)', () => {
  it('ignores order and Prism-only fields', () => {
    const b = data();
    b.students = [{ ...b.students[1] }, { ...b.students[0], resubmit_flag: { id: 3 } }];
    b.topics = [{ id: 't2' }, { id: 't1' }];
    expect(sameInSchoology(data(), b)).toBe(true);
  });

  it('a changed level, comment, display status, exception or topic list is a change', () => {
    const level = data(); level.students[0] = { ...level.students[0], scores: { t1: { grade: 'ED' } } };
    const comment = data(); comment.students[0] = { ...comment.students[0], grade_comment: 'Better' };
    const shown = data(); shown.students[0] = { ...shown.students[0], comment_status: 0 };
    const excused = data(); excused.students[1] = { ...excused.students[1], exception: 1 };
    const topics = data({ topics: [{ id: 't1' }] });
    for (const b of [level, comment, shown, excused, topics]) expect(sameInSchoology(data(), b)).toBe(false);
  });
});

describe('afterRefresh (#52)', () => {
  const changed = () => { const b = data(); b.students[0] = { ...b.students[0], grade_comment: 'Better' }; return b; };
  it('unchanged or unreadable: nothing to do', () => {
    expect(afterRefresh(data(), data(), { 2: true })).toBe('none');
    expect(afterRefresh(data(), null, {})).toBe('none');
  });
  it('changed: reload when nothing is unsaved, ask when a card holds unsaved changes', () => {
    expect(afterRefresh(data(), changed(), {})).toBe('reload');
    expect(afterRefresh(data(), changed(), { 1: false })).toBe('reload');
    expect(afterRefresh(data(), changed(), { 2: true })).toBe('ask');
  });
});
