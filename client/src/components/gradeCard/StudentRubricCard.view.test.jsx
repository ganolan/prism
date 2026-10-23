import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { cardInputs } from '../../lib/cardInputs.js';
import { rowScores } from '../../lib/feedbackRows.js';
import { TOPICS, makeStudent, renderCard } from './testFixtures.js';

// Stub the DB saver so tests assert wiring, not I/O.
let mockSaver;
vi.mock('../../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: () => {
    mockSaver = { save: vi.fn(), remove: vi.fn(), flush: vi.fn(), settle: vi.fn(async () => {}), dispose: vi.fn() };
    return mockSaver;
  },
}));

vi.mock('../../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getAssignmentFileSummaries: vi.fn().mockRejectedValue(Object.assign(new Error('off'), { status: 403 })),
  getSubmissionFiles: vi.fn(),
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
  getSettings: vi.fn().mockResolvedValue({ triage: { resubmitLessonsDefault: 3 } }),
  getTriagePair: vi.fn().mockResolvedValue(null),
  getGradeFlags: vi.fn(),
  setGradeFlag: vi.fn(),
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


beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mockSaver = undefined;
});

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const missingSymbols = (root) => within(root).queryAllByRole('img', { name: 'Missing' });

const NO_LEVEL_LINE = 'Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.';
const LEVEL_LINE = 'Marked Missing. These levels still count in the topic averages.';
// Feedback-row levels live only in Prism (#40 review I4): the lines say so.
const ROW_NO_LEVEL_LINE = 'Shown as IE because the work is marked Missing. No rubric rows are scored for this task yet.';
const ROW_LEVEL_LINE = 'Marked Missing. These are the rubric rows Prism holds for this task.';

const T1 = { id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing' };
const T2 = { id: 't2', title: 'Reflect', external_id: 'ART.6.1', category_title: 'HS Art: Responding' };
const RUBRIC = {
  criteria: [
    { id: 'c1', position: 1, criterion_name: 'UI/UX', descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } },
    { id: 'c2', position: 2, criterion_name: 'Reflection', descriptors: { ED: 'Deep.', EX: 'Clear.', D: 'Some.', EM: 'Thin.' } },
  ],
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }, { criterion_id: 'c2', topic_id: 't2' }],
};
const studentWith = (props) => ({ ...makeStudent(), ...props });

const SCALE = {
  name: 'General Academic Scale',
  levels: [
    { code: 'ED', label: 'Exhibiting Depth', points: 100 },
    { code: 'EX', label: 'Exhibiting', points: 75 },
    { code: 'D', label: 'Developing', points: 50 },
    { code: 'EM', label: 'Emerging', points: 25 },
    { code: 'IE', label: 'Insufficient Evidence', points: 0 },
  ],
};
const ROW_CRITERIA = [
  { id: 'r1', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work', reporting_category: 'Producing',
    descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } },
  { id: 'r2', position: 2, criterion_name: 'Polish', standard_title: 'Present work', reporting_category: 'Producing',
    descriptors: { ED: 'Seamless.', EX: 'Tidy.', D: 'Rough.', EM: 'Unfinished.' } },
];
// The props a feedback-row task's card gets from cardInputs (topics are the rows).
function rowCard(student, extra = {}) {
  const inputs = cardInputs({
    topics: [], scoreScale: SCALE, rubricData: { rubric: { criteria: ROW_CRITERIA }, topicByCriterion: [] },
    student: { ...studentWith(student), row_levels: student.row_levels ?? {} },
  });
  return { ...inputs, scoreScale: SCALE, ...extra };
}

describe('StudentRubricCard: a points-only task', () => {
  it('shows its score as "50 / 100" with no table', () => {
    renderCard({
      topics: [], assignmentRow: { id: 50, max_points: 100 },
      student: studentWith({ score: 50 }),
    });
    expect(screen.getByText('Score:')).toBeInTheDocument();
    expect(screen.getByText('50 / 100')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a flag shows its symbol in the score\'s place', () => {
    renderCard({
      topics: [], assignmentRow: { id: 50, max_points: 100 },
      student: studentWith({ score: null, exception: 1 }),
    });
    expect(screen.getByText('Score:')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Exempt' }).length).toBeGreaterThan(0);
  });

  it('an aligned task shows no Score line', () => {
    renderCard({ student: studentWith({ score: 50 }) });
    expect(screen.queryByText('Score:')).not.toBeInTheDocument();
  });
});

describe('StudentRubricCard: Missing shows IE on every topic (#40)', () => {
  it('with no topic levels, every topic of the descriptor grid shows IE with the Missing symbol, under the no-levels line', () => {
    renderCard({ topics: [T1, T2], rubric: RUBRIC, student: studentWith({ exception: 3 }) });
    const table = screen.getByRole('table');
    const awarded = table.querySelectorAll('td[data-awarded="true"]');
    expect(awarded).toHaveLength(2);
    awarded.forEach((td) => {
      expect(td.cellIndex).toBe(5); // topic column, then ED EX D EM IE
      expect(missingSymbols(td)).toHaveLength(1);
      expect(within(td).queryByText('MISSING')).toBeNull(); // no name beside the symbol
    });
    expect(screen.getByText(NO_LEVEL_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/rubric hidden/)).not.toBeInTheDocument();
    expect(follows(screen.getByText(NO_LEVEL_LINE), table)).toBe(true);
  });

  it('with no topic levels, the compact grid shows IE on every topic too', () => {
    renderCard({ topics: [T1, T2], viewMode: 'compact', student: studentWith({ exception: 3 }) });
    const table = screen.getByRole('table');
    for (const title of ['Select, analyze', 'Reflect']) {
      const row = screen.getByText(title).closest('tr');
      const cells = within(row).getAllByRole('cell');
      expect(cells[5]).toHaveTextContent('IE');
      expect(missingSymbols(cells[5])).toHaveLength(1);
      expect(cells.slice(1, 5).every((c) => c.textContent === '')).toBe(true);
    }
    expect(missingSymbols(table)).toHaveLength(2);
    expect(screen.getByText(NO_LEVEL_LINE)).toBeInTheDocument();
  });

  it('with topic levels, the real levels show as they are, under the other line', () => {
    renderCard({
      topics: [T1], rubric: { ...RUBRIC, topicByCriterion: [RUBRIC.topicByCriterion[0]] },
      student: studentWith({ exception: 3, scores: { t1: { grade: 'EX' } } }),
    });
    const table = screen.getByRole('table');
    expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
    expect(screen.queryByText(NO_LEVEL_LINE)).not.toBeInTheDocument();
    expect(screen.getByText('Clear and usable.').closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(table.querySelectorAll('td[data-awarded="true"]')).toHaveLength(1);
    expect(missingSymbols(table)).toHaveLength(0);
    expect(follows(screen.getByText(LEVEL_LINE), table)).toBe(true);
  });

  it('the compact grid keeps the real levels too', () => {
    renderCard({ topics: [T1], viewMode: 'compact', student: studentWith({ exception: 3, scores: { t1: { grade: 'EX' } } }) });
    const row = screen.getByText('Select, analyze').closest('tr');
    expect(within(row).getByText('EX')).toBeInTheDocument();
    expect(within(row).queryByText('IE')).toBeNull();
    expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
  });

  it('with levels on only some topics, those show as they are and the rest show none, never IE (#177)', () => {
    renderCard({ topics: [T1, T2], viewMode: 'compact', student: studentWith({ exception: 3, scores: { t1: { grade: 'EX' } } }) });
    expect(within(screen.getByText('Select, analyze').closest('tr')).getByText('EX')).toBeInTheDocument();
    const ungraded = within(screen.getByText('Reflect').closest('tr')).getAllByRole('cell');
    expect(ungraded.slice(1).every((c) => c.textContent === '')).toBe(true);
    expect(missingSymbols(screen.getByRole('table'))).toHaveLength(0);
    expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
    expect(screen.queryByText(NO_LEVEL_LINE)).not.toBeInTheDocument();
  });

  it('the line carries the Missing symbol with its name', () => {
    renderCard({ topics: [T1, T2], viewMode: 'compact', student: studentWith({ exception: 3 }) });
    expect(within(screen.getByText(NO_LEVEL_LINE).parentElement).getByText('MISSING')).toBeInTheDocument();
  });

  it('is a display transform: the rubric stays locked and the topics given are not changed', () => {
    const topics = [{ ...T1 }, { ...T2 }];
    const student = studentWith({ exception: 3 });
    renderCard({ topics, viewMode: 'compact', student });
    expect(student.scores).toEqual({});
    expect(screen.getByText('Missing, rubric locked')).toBeInTheDocument();
    expect(screen.getByRole('table').parentElement).toHaveStyle({ pointerEvents: 'none' });
  });

  it('on a feedback-row task with no row levels, every row shows IE', () => {
    renderCard(rowCard({ exception: 3 }));
    const table = screen.getByRole('table');
    const awarded = table.querySelectorAll('td[data-awarded="true"]');
    expect(awarded).toHaveLength(2);
    awarded.forEach((td) => expect(missingSymbols(td)).toHaveLength(1));
    expect(screen.getByText(ROW_NO_LEVEL_LINE)).toBeInTheDocument();
    expect(screen.queryByText(NO_LEVEL_LINE)).not.toBeInTheDocument();
    expect(follows(screen.getByText(ROW_NO_LEVEL_LINE), table)).toBe(true);
  });

  it('on a feedback-row task with row levels, they show as they are', () => {
    renderCard(rowCard({ exception: 3, row_levels: { Playtesting: 'EX', Polish: 'D' } }));
    expect(screen.getByText('Tests and fixes.').closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(screen.getByText('Rough.').closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(missingSymbols(screen.getByRole('table'))).toHaveLength(0);
    expect(screen.getByText(ROW_LEVEL_LINE)).toBeInTheDocument();
    expect(screen.queryByText(LEVEL_LINE)).not.toBeInTheDocument();
  });

  it('a Missing student with a saved grade shows the saved levels, not IE', () => {
    renderCard({
      topics: [T1], viewMode: 'compact',
      student: studentWith({ exception: 3, saved_grade: { topics: { t1: 'D' }, savedAt: '2026-10-20 01:00:00', summary: 'Developing' } }),
    });
    const row = screen.getByText('Select, analyze').closest('tr');
    expect(within(row).getByText('D')).toBeInTheDocument();
    expect(within(row).queryByText('IE')).toBeNull();
    expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
  });

  it.each([0, 2, 5, 6])('exception %i shows no IE and neither line', (exception) => {
    renderCard({ topics: [T1, T2], viewMode: 'compact', student: studentWith({ exception }) });
    expect(screen.queryByText(/Shown as IE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Marked Missing/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('cell').filter((c) => c.textContent === 'IE')).toHaveLength(0);
  });

  it('Exempt keeps the card\'s own lock and shows no IE', () => {
    renderCard({ topics: [T1, T2], viewMode: 'compact', student: studentWith({ exception: 1 }) });
    expect(screen.getByText('Exempt, rubric locked')).toBeInTheDocument();
    expect(screen.queryByText(/Shown as IE/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('cell').filter((c) => c.textContent === 'IE')).toHaveLength(0);
  });
});

describe('StudentRubricCard: meeting', () => {
  const PICTURE = 'https://example.test/ada.jpg';
  const FEEDBACK = {
    id: 9,
    suggestion_state: null,
    feedback_parsed: {
      narrative_feedback: 'A warm, specific comment.',
      rubric_scores: { Playtesting: 'EX', Polish: 'D' },
      scale_level: 'EX',
      evidence: 'Tested twice.',
      reviewer_flags: 'Check the second playtest.',
      strengths: ['Clear loop'],
      suggestions: ['Polish the menu'],
    },
  };
  const card = (extra = {}) => ({ ...rowCard({ picture_url: PICTURE }), feedbackRow: FEEDBACK, ...extra });
  const initials = () => screen.queryByText((_, el) => el.tagName === 'DIV' && el.textContent === 'AL');
  const suggestionsShown = () => ({
    photo: document.querySelector(`img[src="${PICTURE}"]`) != null,
    narrative: screen.queryByText('Suggested feedback') != null,
    notes: screen.queryAllByText('Reviewer notes').length > 0,
    sparkles: screen.queryAllByTestId('ai-sparkle').length > 0,
    suggested: screen.queryAllByText(/Suggested/).length > 0,
  });

  it('without meeting the photo and every suggestion show (so the next test proves something)', () => {
    renderCard(card());
    expect(suggestionsShown()).toEqual({ photo: true, narrative: true, notes: true, sparkles: true, suggested: true });
  });

  it('meeting hides the photo and every suggestion', () => {
    renderCard(card({ meeting: true }));
    expect(suggestionsShown()).toEqual({ photo: false, narrative: false, notes: false, sparkles: false, suggested: false });
    expect(screen.queryByText('Use suggestion')).not.toBeInTheDocument();
    // The student's name is still there.
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toBeInTheDocument();
  });

  it('meeting also hides the initials circle when there is no picture', () => {
    renderCard({ ...card({ meeting: true }), student: studentWith({ first_name: 'Ada', last_name: 'Lovelace' }) });
    expect(initials()).toBeNull();
  });

  it('without meeting the initials circle shows when there is no picture', () => {
    renderCard({ ...card(), student: studentWith({ first_name: 'Ada', last_name: 'Lovelace' }) });
    expect(initials()).not.toBeNull();
  });

  it('meeting hides the suggested cells of an aligned task\'s compact grid too', () => {
    const aligned = {
      topics: [T1], viewMode: 'compact', feedbackRow: { id: 9, feedback_parsed: { rubric_scores: { 'ART.5.1': 'EX' } } },
    };
    const { unmount } = renderCard(aligned);
    expect(screen.queryAllByTestId('ai-sparkle').length).toBeGreaterThan(0);
    unmount();
    renderCard({ ...aligned, meeting: true });
    expect(screen.queryAllByTestId('ai-sparkle')).toHaveLength(0);
  });
});

// rowScores is what cardInputs puts into student.scores for a feedback-row task.
it('cardInputs gives a feedback-row student the row levels as scores', () => {
  expect(rowScores({ Playtesting: 'EX' })).toEqual({ 'row:Playtesting': { grade: 'EX' } });
  expect(TOPICS).toHaveLength(1);
});
