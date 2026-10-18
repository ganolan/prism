import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StudentRubricCard } from './AssessmentSummaryPage.jsx';
import { writeMasteryComment } from '../services/api.js';

// Undo / redo in the card's comment box (#75). The box writes its own value on
// paste, the chip line and Use suggestion, which breaks the browser's undo, so
// it keeps its own history (useUndoableText).

let mockSaver;
vi.mock('../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: () => {
    mockSaver = { save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
    return mockSaver;
  },
}));

vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'not_lti', links: {} }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getFeatures: vi.fn().mockResolvedValue({}),
  getQuizGroupFor: vi.fn().mockResolvedValue({ group: null }),
  getQuizResults: vi.fn().mockResolvedValue({ students: [] }),
  rebuildQuizOverall: vi.fn(),
  setSuggestionState: vi.fn().mockResolvedValue({}),
  getFeedbackForAssignment: vi.fn().mockResolvedValue({}),
  getAssessmentAnalysis: vi.fn().mockResolvedValue(null),
  getDraftsForAssignment: vi.fn().mockResolvedValue({}),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  sendAllGrades: vi.fn().mockResolvedValue({ results: [] }),
  createFlag: vi.fn().mockResolvedValue({ id: 99, flag_reason: 'Check citations' }),
  deleteFlag: vi.fn().mockResolvedValue({ success: true }),
  getSettings: vi.fn().mockResolvedValue({ triage: { resubmitLessonsDefault: 3 } }),
  getTriagePair: vi.fn().mockResolvedValue(null),
  requestResubmission: vi.fn(),
  updateResubmission: vi.fn(),
  undoResubmission: vi.fn(),
  previewStatusLine: vi.fn().mockResolvedValue({ currentComment: '', visible: true, storedLine: null, hiddenWarning: false }),
  getLessonPlan: vi.fn().mockResolvedValue(null), getStatusLineUntil: vi.fn().mockResolvedValue({ until: '2026-10-15', lessons: 3 }),
  getRubricForAssignment: vi.fn().mockResolvedValue(null),
  saveRowLevels: vi.fn().mockResolvedValue({ ok: true, row_levels: {} }),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  rubricTemplateUrl: vi.fn(() => '/api/rubrics/template'),
  uploadRubricCsv: vi.fn().mockResolvedValue({ id: 1 }),
  attachRubric: vi.fn().mockResolvedValue({ unmatched: [] }),
  listRubrics: vi.fn().mockResolvedValue([]),
  deleteRubric: vi.fn().mockResolvedValue({ ok: true }),
  setRubricMapping: vi.fn().mockResolvedValue({ ok: true }),
  reorderRubricCriteria: vi.fn().mockResolvedValue({ ok: true }),
  rubricExportUrl: vi.fn((id) => `/api/rubrics/${id}/export`),
  getProficiencyScale: vi.fn().mockResolvedValue({
    schoologyScaleId: 21337256,
    levels: [
      { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
      { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
      { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
      { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
      { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
    ],
  }),
}));

const TOPICS = [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }];

function makeStudent(extra = {}) {
  return {
    id: 1, enrollment_id: 'enr-1', schoology_uid: 'uid-1',
    first_name: 'Ada', last_name: 'Lovelace', preferred_name: null, preferred_name_teacher: null,
    grade_comment: '', comment_status: 0, exception: null, scores: {},
    ...extra,
  };
}

function renderCard({ student, ...rest } = {}) {
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={student || makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...rest}
      />
    </MemoryRouter>
  );
}

const box = () => screen.getByPlaceholderText(/Teacher comment/i);
// One change event per character, as typing produces.
function typeChars(chars) {
  for (const c of chars) fireEvent.change(box(), { target: { value: box().value + c } });
}
function paste(text) {
  const el = box();
  el.setSelectionRange(el.value.length, el.value.length);
  fireEvent.paste(el, { clipboardData: { getData: () => text } });
}
const undo = () => fireEvent.keyDown(box(), { key: 'z', metaKey: true });
const redo = () => fireEvent.keyDown(box(), { key: 'z', metaKey: true, shiftKey: true });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mockSaver = undefined;
});

describe('StudentRubricCard comment box undo (#75)', () => {
  it('undoes and redoes a burst of typing', () => {
    renderCard({ student: makeStudent({ grade_comment: 'Good.' }) });
    typeChars(' More.');
    expect(box()).toHaveValue('Good. More.');
    undo();
    expect(box()).toHaveValue('Good.');
    redo();
    expect(box()).toHaveValue('Good. More.');
  });

  it('a paste is one step of its own', () => {
    renderCard();
    typeChars('Start ');
    paste('pasted​ text');
    expect(box()).toHaveValue('Start pasted text');
    undo();
    expect(box()).toHaveValue('Start ');
    undo();
    expect(box()).toHaveValue('');
  });

  it('the "resubmission received" line is one step', () => {
    renderCard({ student: makeStudent({ grade_comment: 'Body text.', resubmission: { state: 'arrived', request: null }, arrived_on: '2026-10-03' }) });
    fireEvent.click(screen.getByRole('button', { name: /insert "resubmission received" line/i }));
    expect(box()).toHaveValue('Resubmission received 03/10 - regraded.\n\nBody text.');
    undo();
    expect(box()).toHaveValue('Body text.');
    redo();
    expect(box()).toHaveValue('Resubmission received 03/10 - regraded.\n\nBody text.');
  });

  it('Use suggestion is one step', () => {
    renderCard({ feedbackRow: { id: 7, feedback_parsed: { narrative_feedback: 'Excellent work, Ada!' } } });
    typeChars('My own words');
    fireEvent.click(screen.getByRole('button', { name: /use suggestion/i }));
    expect(box()).toHaveValue('Excellent work, Ada!');
    undo();
    expect(box()).toHaveValue('My own words');
  });

  it('Ctrl+Z undoes and Ctrl+Y redoes', () => {
    renderCard();
    typeChars('abc');
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    expect(box()).toHaveValue('');
    fireEvent.keyDown(box(), { key: 'y', ctrlKey: true });
    expect(box()).toHaveValue('abc');
  });

  it('the draft saver receives an undo like any other change', () => {
    renderCard();
    typeChars('abc');
    paste('X');
    mockSaver.save.mockClear();
    undo();
    expect(mockSaver.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ comment: 'abc' }),
      expect.anything()
    );
  });

  it('undo does not cross a Discard', () => {
    renderCard({ student: makeStudent({ grade_comment: 'Synced.' }) });
    typeChars(' edit');
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(box()).toHaveValue('Synced.');
    undo();
    expect(box()).toHaveValue('Synced.');
    redo();
    expect(box()).toHaveValue('Synced.');
  });

  it('undo does not cross a Publish', async () => {
    renderCard();
    typeChars('Final words');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to Schoology' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));
    await waitFor(() => expect(writeMasteryComment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to Schoology' })).toBeEnabled());
    undo();
    expect(box()).toHaveValue('Final words');
  });

  it('undo does not cross a Send all publish either', () => {
    const cards = {};
    renderCard({ registerCard: (uid, api) => { cards[uid] = api; }, unregisterCard: () => {} });
    typeChars('Sent in bulk');
    act(() => cards['uid-1'].applyResult(true));
    undo();
    expect(box()).toHaveValue('Sent in bulk');
  });
});
