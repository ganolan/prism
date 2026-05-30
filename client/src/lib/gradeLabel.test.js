import { describe, it, expect } from 'vitest';
import { submissionStatus, gradeLabel } from './gradeLabel.js';

const PAST = '2020-01-01 00:00:00';
const FUTURE = '2999-01-01 00:00:00';

const kinds = (badges) => badges.map((b) => b.kind);

describe('submissionStatus — submission_type (#62)', () => {
  it('shows "Submitted" for an ungraded OneDrive cell with submission_type, even past due', () => {
    const badges = submissionStatus({ score: null, submission_type: 'drop', submitted_at: 0, due_date: PAST });
    expect(kinds(badges)).toContain('submitted');
    expect(kinds(badges)).not.toContain('not-started');
    expect(kinds(badges)).not.toContain('missing');
  });

  it('shows "Submitted" for a submission_type cell that is not yet due', () => {
    const badges = submissionStatus({ score: null, submission_type: 'assessment', submitted_at: 0, due_date: FUTURE });
    expect(kinds(badges)).toEqual(['submitted']);
  });

  it('still falls back to submitted_at when submission_type is absent', () => {
    const badges = submissionStatus({ score: null, submitted_at: 1700000000, due_date: PAST });
    expect(kinds(badges)).toContain('submitted');
  });

  it('shows "Missing • Not Started" only when neither submission_type nor submitted_at is set', () => {
    const badges = submissionStatus({ score: null, submission_type: null, submitted_at: 0, due_date: PAST });
    expect(kinds(badges)).toEqual(['missing', 'not-started']);
  });

  it('a graded cell shows no submitted badge regardless of submission_type', () => {
    const badges = submissionStatus({ score: 14, submission_type: 'drop', submitted_at: 0, due_date: PAST });
    expect(kinds(badges)).not.toContain('submitted');
  });

  it('a non-late teacher exception takes precedence over submission state', () => {
    const badges = submissionStatus({ score: null, exception: 1, submission_type: 'drop', due_date: PAST });
    expect(badges).toEqual([{ kind: 'exception', label: 'Excused', tone: 'blue' }]);
  });
});

describe('gradeLabel', () => {
  it('returns Pending for an ungraded row', () => {
    expect(gradeLabel({ score: null })).toEqual({ text: 'Pending', kind: 'pending' });
  });

  it('renders numeric score / max when the scale has no levels', () => {
    expect(gradeLabel({ score: 8, max_points: 10 })).toEqual({ text: '8 / 10', kind: 'numeric' });
  });
});
