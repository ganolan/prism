import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import AssessmentSummaryPage from './AssessmentSummaryPage.jsx';
import { getQuizGroupFor, loadQuizResults, getMasteryForAssignment, getSyncRun } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';

vi.mock('../lib/assessmentDraftSaver.js', () => ({ makeDraftSaver: () => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() }) }));
vi.mock('../components/quiz/QuestionsTab.jsx', () => ({ default: ({ groupId }) => <div>Questions for group {groupId}</div> }));
vi.mock('../components/quiz/FreeResponseTab.jsx', () => ({ default: ({ groupId }) => <div>Free response for group {groupId}</div> }));
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'not_lti', links: {} }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getQuizGroupFor: vi.fn(),
  getFeatures: vi.fn().mockResolvedValue({ quizzes: true }),
  loadQuizResults: vi.fn(),
  getSyncRun: vi.fn(),
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

const GROUP = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' }, members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }], loaded_at: null, canonical_schoology_id: '950' };

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/course/5/assessment/960">go to B</Link>
      <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  getMasteryForAssignment.mockResolvedValue({ assignment: { title: 'Ep 1 - Result (S)', is_test: 0 }, topics: [], students: [], course: { course_name: 'AP CSP' } });
});

describe('AssessmentSummaryPage with a quiz group', () => {
  it('shows the chip, Load results and the Questions tab', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    loadQuizResults.mockResolvedValue({ summary: { attempts: 18, failed: [] }, group: { ...GROUP, loaded_at: '2026-10-12 14:02:00' } });
    renderAt('/course/5/assessment/950');
    expect(await screen.findByText(/1 linked test/)).toBeInTheDocument();
    expect(screen.getByText('not loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load results' }));
    expect(await screen.findByText('18 attempts loaded')).toBeInTheDocument();
    expect(loadQuizResults).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole('tab', { name: 'Questions' }));
    expect(await screen.findByText('Questions for group 7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Grading' }));
    expect(screen.queryByText('Questions for group 7')).toBeNull();
  });

  it('reports failed attempts in the load line', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    loadQuizResults.mockResolvedValue({ summary: { attempts: 18, failed: [{ uid: 'u1' }] }, group: GROUP });
    renderAt('/course/5/assessment/950');
    fireEvent.click(await screen.findByRole('button', { name: 'Load results' }));
    expect(await screen.findByText('18 attempts loaded, 1 failed')).toBeInTheDocument();
  });

  it('a load that outlasts the server wait (202 with a run id) is followed until the run finishes', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    loadQuizResults.mockResolvedValue({ runId: 41 });
    getSyncRun
      .mockResolvedValueOnce({ id: 41, status: 'queued', summary: null })
      .mockResolvedValue({ id: 41, status: 'completed', summary: { type: 'summary', quiz: { attempts: 18, failed: [] } } });
    renderAt('/course/5/assessment/950');
    fireEvent.click(await screen.findByRole('button', { name: 'Load results' }));
    await waitFor(() => expect(getSyncRun).toHaveBeenCalledWith(41));
    expect(screen.queryByText('18 attempts loaded')).toBeNull();
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, loaded_at: '2026-10-20 07:00:00' } });
    expect(await screen.findByText('18 attempts loaded', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(getSyncRun).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Load results' })).toBeEnabled();
  });

  it('a followed load that fails shows the run\'s error', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    loadQuizResults.mockResolvedValue({ runId: 42 });
    getSyncRun.mockResolvedValue({ id: 42, status: 'failed', summary: { type: 'summary', fatal: true, quizError: { code: 'UNREACHABLE', message: 'Could not reach Schoology: try again' } } });
    renderAt('/course/5/assessment/950');
    fireEvent.click(await screen.findByRole('button', { name: 'Load results' }));
    expect(await screen.findByText('Could not reach Schoology: try again')).toBeInTheDocument();
  });

  it('shows load warnings above the tabs, and on the Questions tab too', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, loaded_at: '2026-10-12 14:02:00', parity_status: 'mismatch',
      parity_detail: ['Question 4: a different key'], load_summary: { failed: [], unknownUids: ['9'], multipleAttempts: [] } } });
    renderAt('/course/5/assessment/950');
    const warnings = await screen.findByTestId('quiz-load-warnings');
    expect(warnings).toHaveTextContent('Question 4: a different key');
    expect(warnings).toHaveTextContent('1 student Prism does not know');
    expect(warnings.compareDocumentPosition(screen.getByRole('tablist', { name: 'Quiz views' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Questions' }));
    expect(await screen.findByText(/Questions for group 7/)).toBeInTheDocument();
    expect(screen.getByTestId('quiz-load-warnings')).toBeInTheDocument();
  });

  it('shows no warning block for a clean group', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, parity_status: 'ok', load_summary: { failed: [], unknownUids: [], multipleAttempts: [] } } });
    renderAt('/course/5/assessment/950');
    await screen.findByText(/1 linked test/);
    expect(screen.queryByTestId('quiz-load-warnings')).toBeNull();
  });

  it('a member test redirects to the result task', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    renderAt('/course/5/assessment/900');
    await waitFor(() => expect(getMasteryForAssignment).toHaveBeenCalledWith('5', '950'));
  });

  it('offers Quiz setup on a test with no group, and nothing on a plain assignment', async () => {
    getQuizGroupFor.mockResolvedValue({ group: null });
    getMasteryForAssignment.mockResolvedValue({ assignment: { title: 'Ep 2', is_test: 1 }, topics: [], students: [], course: { course_name: 'AP CSP' } });
    const { unmount } = renderAt('/course/5/assessment/910');
    expect(await screen.findByRole('button', { name: /Quiz setup/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Questions' })).toBeNull();
    unmount();
    getMasteryForAssignment.mockResolvedValue({ assignment: { title: 'Essay', is_test: 0 }, topics: [], students: [], course: { course_name: 'AP CSP' } });
    renderAt('/course/5/assessment/911');
    await screen.findByText(/Essay/);
    expect(screen.queryByRole('button', { name: /Quiz setup/ })).toBeNull();
  });
  it('stays on an unrelated assignment after navigating from a grouped one', async () => {
    getQuizGroupFor.mockImplementation(async (id) => ({ group: String(id) === '950' ? GROUP : null }));
    getMasteryForAssignment.mockImplementation(async (c, id) => ({
      assignment: { title: String(id) === '950' ? 'Ep 1 - Result (S)' : 'Essay B', is_test: 0 }, topics: [], students: [], course: { course_name: 'AP CSP' },
    }));
    renderAt('/course/5/assessment/950');
    expect(await screen.findByText(/1 linked test/)).toBeInTheDocument();
    getMasteryForAssignment.mockClear();
    fireEvent.click(screen.getByText('go to B'));
    expect(await screen.findByText(/Essay B/)).toBeInTheDocument();
    await waitFor(() => expect(getMasteryForAssignment).toHaveBeenCalledWith('5', '960'));
    expect(getMasteryForAssignment).not.toHaveBeenCalledWith('5', '950');
    expect(screen.queryByText(/1 linked test/)).toBeNull();
  });

  it('shows the loaded time as UTC converted to local', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, loaded_at: '2026-10-12 06:02:00' } });
    renderAt('/course/5/assessment/950');
    const expected = formatDateTime(new Date('2026-10-12T06:02:00Z'));
    expect(await screen.findByText(`loaded ${expected}`)).toBeInTheDocument();
  });

  it('a member redirect keeps ?tab= so the canonical page opens on Questions', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    renderAt('/course/5/assessment/900?tab=questions');
    expect(await screen.findByText('Questions for group 7')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a numeric canonical id does not cause a redirect loop', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, canonical_schoology_id: 950 } });
    renderAt('/course/5/assessment/950');
    expect(await screen.findByText(/1 linked test/)).toBeInTheDocument();
  });

  it('shows a Free response tab only when the group has an FRQ', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, frq_count: 1 } });
    renderAt('/course/5/assessment/950');
    fireEvent.click(await screen.findByRole('tab', { name: 'Free response' }));
    expect(await screen.findByText('Free response for group 7')).toBeInTheDocument();
  });

  it('no Free response tab without an FRQ', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, frq_count: 0 } });
    renderAt('/course/5/assessment/950');
    await screen.findByRole('tab', { name: 'Questions' });
    expect(screen.queryByRole('tab', { name: 'Free response' })).toBeNull();
  });
});
