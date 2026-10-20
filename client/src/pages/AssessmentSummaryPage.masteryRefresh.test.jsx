// #52: the assessment page refreshes its levels and comments from Schoology after it loads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AssessmentSummaryPage from './AssessmentSummaryPage.jsx';
import { getMasteryForAssignment, getFeedbackForAssignment, syncMasteryForAssignment, ensureSync, getCurrentSync, getSyncRun } from '../services/api.js';

vi.mock('../lib/assessmentDraftSaver.js', () => ({ makeDraftSaver: () => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() }) }));
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  ensureSync: vi.fn(),
  getCurrentSync: vi.fn(),
  getSyncRun: vi.fn(),
  getSyncRunEvents: vi.fn(),
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
const SYNCED = new Date().toISOString();
const page = (comment, { archived = 0, at = OLD, taskSyncedAt = SYNCED } = {}) => ({
  assignment: { title: 'Project', is_test: 0, task_synced_at: taskSyncedAt }, topics: [], students: [student(comment)],
  course: { course_name: 'AP CSP', archived }, masterySyncedAt: at,
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/course/5/assessment/950']}>
    <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
  </MemoryRouter>,
);
const IDLE = { running: null, runId: null, queued: [], held: [] };

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  ensureSync.mockResolvedValue({ state: 'fresh' });
  getCurrentSync.mockResolvedValue(IDLE);
  getSyncRun.mockResolvedValue({ id: 4, status: 'completed', summary: { comments: { queued: 0 } } });
});

describe('AssessmentSummaryPage background sync', () => {
  it('asks the queue for this task after loading; no partial reads; one "Synced" time', async () => {
    getMasteryForAssignment.mockResolvedValue(page('Same'));
    renderPage();
    await waitFor(() => expect(ensureSync).toHaveBeenCalledWith({ kind: 'task', courseId: 5, assignmentId: '950' }));
    expect(await screen.findByText(/^Synced \d\d:\d\d today$/)).toBeInTheDocument();
    expect(screen.queryByText(/new work/)).toBeNull();
  });

  it('a background sync that ends swaps the new data in, without the Loading screen, when nothing is unsaved', async () => {
    getMasteryForAssignment.mockResolvedValueOnce(page('Old')).mockResolvedValue(page('New from Schoology', { at: NEW }));
    ensureSync.mockResolvedValue({ state: 'running', runId: 4 });
    renderPage();
    await waitFor(() => expect(getFeedbackForAssignment).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an archived course is not synced in the background', async () => {
    getMasteryForAssignment.mockResolvedValue(page('Done', { archived: 1 }));
    renderPage();
    await screen.findByText(/^Synced /);
    expect(ensureSync).not.toHaveBeenCalled();
  });

  it('Sync Assignment queues the task and follows its run (the chip shows it)', async () => {
    getMasteryForAssignment.mockResolvedValue(page('Same'));
    syncMasteryForAssignment.mockResolvedValue({ runId: 12, state: 'queued', joined: false });
    getCurrentSync.mockResolvedValue({ ...IDLE, running: { runId: 12 }, runId: 12 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Assignment' }));
    await waitFor(() => expect(syncMasteryForAssignment).toHaveBeenCalledWith('5', '950'));
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeInTheDocument();
  });

  it('a task deleted in Schoology says so', async () => {
    getMasteryForAssignment.mockResolvedValue({ ...page('Same'), assignment: { title: 'Project', is_test: 0, removed_at: '2026-10-20T00:00:00Z' } });
    renderPage();
    expect(await screen.findByText('This task was deleted in Schoology.')).toBeInTheDocument();
  });
});
