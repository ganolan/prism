import { describe, it, expect } from 'vitest';
import { parseGraderHeaderData, buildSubmissionLookup } from './parseGraderHeaderData.js';

// Fixture mirrors the VERIFIED grader_header_data shape (2026-05-31 live probe;
// see parseGraderHeaderData.js header). Values are synthetic — no real PII.
// Outer `grades` key = uid; inner key = assignmentId (= schoology_assignment_id).
const FIXTURE = {
  response_code: 200,
  body: {
    grade_item_data: {
      // An LTI/OneDrive dropbox assignment
      '8030139105': {
        id: '8030139105', item_nid: 12345, title: 'OneDrive Essay',
        link: '/assignment/8030139105', max_points: 16,
        is_lti_assignment: true, option_dropbox: true, has_assessment: false,
      },
      // A native (non-LTI) assignment graded manually
      '7957396459': {
        id: '7957396459', item_nid: 67890, title: 'Manual Quiz',
        max_points: 10, is_lti_assignment: false, option_dropbox: false,
      },
    },
    grades: {
      // uid 700001 — submitted+graded (drop), and a manual grade on the quiz
      '700001': {
        '8030139105': { uid: '700001', grade_item_nid: 12345, submission: 'drop', grade: '14', comment: 'nice work' },
        '7957396459': { uid: '700001', grade_item_nid: 67890, grade: '9' },
      },
      // uid 700002 — submitted but UNGRADED on the OneDrive item (the #62 case);
      // bare cell on the quiz (never opened)
      '700002': {
        '8030139105': { uid: '700002', grade_item_nid: 12345, submission: 'drop' },
        '7957396459': { uid: '700002', grade_item_nid: 67890 },
      },
      // uid 700003 — Schoology assessment submission; not assigned the quiz (#54)
      '700003': {
        '8030139105': { uid: '700003', grade_item_nid: 12345, submission: 'assessment' },
        '7957396459': { uid: '700003', grade_item_nid: 67890, not_assigned: 1 },
      },
    },
  },
};

describe('parseGraderHeaderData', () => {
  it('parses item metadata with LTI/dropbox flags keyed by assignment id', () => {
    const { items } = parseGraderHeaderData(FIXTURE);
    const lti = items.find((i) => i.assignmentId === '8030139105');
    expect(lti).toEqual({ assignmentId: '8030139105', title: 'OneDrive Essay', isLti: true, optionDropbox: true });
    const native = items.find((i) => i.assignmentId === '7957396459');
    expect(native).toEqual({ assignmentId: '7957396459', title: 'Manual Quiz', isLti: false, optionDropbox: false });
  });

  it('marks submission present (drop or assessment) as submitted with its type', () => {
    const { cells } = parseGraderHeaderData(FIXTURE);
    const drop = cells.find((c) => c.uid === '700001' && c.assignmentId === '8030139105');
    expect(drop).toMatchObject({ submitted: true, submissionType: 'drop', graded: true });
    const assessment = cells.find((c) => c.uid === '700003' && c.assignmentId === '8030139105');
    expect(assessment).toMatchObject({ submitted: true, submissionType: 'assessment', graded: false });
  });

  it('treats a submission-present, grade-absent cell as submitted-but-ungraded (#62)', () => {
    const { cells } = parseGraderHeaderData(FIXTURE);
    const cell = cells.find((c) => c.uid === '700002' && c.assignmentId === '8030139105');
    expect(cell.submitted).toBe(true);
    expect(cell.graded).toBe(false);
    expect(cell.submissionType).toBe('drop');
  });

  it('treats a bare cell (no grade, no submission) as not submitted', () => {
    const { cells } = parseGraderHeaderData(FIXTURE);
    const cell = cells.find((c) => c.uid === '700002' && c.assignmentId === '7957396459');
    expect(cell.submitted).toBe(false);
    expect(cell.graded).toBe(false);
    expect(cell.submissionType).toBeNull();
  });

  it('flags a graded cell with no submission (manual entry) as graded, not submitted', () => {
    const { cells } = parseGraderHeaderData(FIXTURE);
    const cell = cells.find((c) => c.uid === '700001' && c.assignmentId === '7957396459');
    expect(cell.graded).toBe(true);
    expect(cell.submitted).toBe(false);
  });

  it('detects not_assigned (#54)', () => {
    const { cells } = parseGraderHeaderData(FIXTURE);
    const cell = cells.find((c) => c.uid === '700003' && c.assignmentId === '7957396459');
    expect(cell.notAssigned).toBe(true);
    expect(cell.submitted).toBe(false);
  });

  it('accepts a bare body (no response envelope)', () => {
    const { cells } = parseGraderHeaderData(FIXTURE.body);
    expect(cells.length).toBe(6);
  });

  it('returns empty arrays for missing/empty input', () => {
    expect(parseGraderHeaderData(null)).toEqual({ items: [], cells: [] });
    expect(parseGraderHeaderData({})).toEqual({ items: [], cells: [] });
    expect(parseGraderHeaderData({ body: {} })).toEqual({ items: [], cells: [] });
  });
});

describe('buildSubmissionLookup', () => {
  it('returns the cell for a (uid, assignmentId) pair', () => {
    const lookup = buildSubmissionLookup(FIXTURE);
    expect(lookup.get('700002', '8030139105')).toMatchObject({ submitted: true, graded: false });
    expect(lookup.get('700002', '7957396459')).toMatchObject({ submitted: false });
  });

  it('returns undefined for an unknown pair', () => {
    const lookup = buildSubmissionLookup(FIXTURE);
    expect(lookup.get('999999', '8030139105')).toBeUndefined();
  });

  it('exposes item metadata by id for LTI/dropbox checks', () => {
    const lookup = buildSubmissionLookup(FIXTURE);
    expect(lookup.itemsById.get('8030139105')).toMatchObject({ isLti: true, optionDropbox: true });
    expect(lookup.cellCount).toBe(6);
  });
});
