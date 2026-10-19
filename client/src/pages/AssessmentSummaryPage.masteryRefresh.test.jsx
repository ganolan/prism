// #52: the assessment page refreshes its levels and comments from Schoology after it loads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AssessmentSummaryPage from './AssessmentSummaryPage.jsx';
import { getMasteryForAssignment, refreshMasteryForAssignment, getFeedbackForAssignment } from '../services/api.js';

vi.mock('../lib/assessmentDraftSaver.js', () => ({ makeDraftSaver: () => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() }) }));
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  refreshMasteryForAssignment: vi.fn(),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'not_lti', links: {} }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getQuizGroupFor: vi.fn().mockResolvedValue({ group: null }),
  getFeatures: vi.fn().mockResolvedValue({ quizzes: true }),
  loadQuizResults: vi.fn(),
  getQuizCandidates: vi.fn().mockResolvedValue({ tests: [], summatives: [] }),
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
  requestResubmission: vi.fn(),
  updateResubmission: vi.fn(),
  undoResubmission: vi.fn(),
  previewStatusLine: vi.fn().mockResolvedValue({ currentComment: '', visible: true, storedLine: null, hiddenWarning: false }),
  getLessonPlan: vi.fn().mockResolvedValue(null), getStatusLineUntil: vi.fn().mockResolvedValue({ until: '2026-10-15', lessons: 3 }),
  getRubricForAssignment: vi.fn().mockResolvedValue(null),
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

const OLD = '2026-10-18T19:02:00.000Z';
const NEW = '2026-10-19T06:00:00.000Z';
const student = (comment) => ({ id: 1, schoology_uid: '701', first_name: 'Ada', last_name: 'Lee', enrollment_id: 'e1', scores: {}, grade_comment: comment, exception: 0, comment_status: 1 });
const page = (comment, { archived = 0, at = OLD } = {}) => ({
  assignment: { title: 'Project', is_test: 0 }, topics: [], students: [student(comment)],
  course: { course_name: 'AP CSP', archived }, masterySyncedAt: at,
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/course/5/assessment/950']}>
    <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
  </MemoryRouter>,
);
const freshness = () => screen.getByText(/Mastery levels|Could not refresh mastery/);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('AssessmentSummaryPage mastery refresh (#52)', () => {
  it('Schoology changed and nothing is unsaved: the new data swaps in without the Loading screen', async () => {
    getMasteryForAssignment.mockResolvedValueOnce(page('Old')).mockResolvedValue(page('New from Schoology', { at: NEW }));
    refreshMasteryForAssignment.mockResolvedValue({ refreshed: true, syncedAt: NEW });
    renderPage();
    await waitFor(() => expect(refreshMasteryForAssignment).toHaveBeenCalledWith('5', '950'));
    // The compare read, then the quiet reload (which fetches the rest of the page again).
    await waitFor(() => expect(getFeedbackForAssignment).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Loading...')).toBeNull();
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('nothing changed in Schoology: only the time moves, no reload', async () => {
    getMasteryForAssignment.mockResolvedValue(page('Same'));
    refreshMasteryForAssignment.mockResolvedValue({ refreshed: true, syncedAt: NEW });
    renderPage();
    await waitFor(() => expect(getMasteryForAssignment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
    expect(getFeedbackForAssignment).toHaveBeenCalledTimes(1);
  });

  it('an archived course is not refreshed', async () => {
    getMasteryForAssignment.mockResolvedValue(page('Done', { archived: 1 }));
    renderPage();
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
    expect(refreshMasteryForAssignment).not.toHaveBeenCalled();
  });
});
