import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { cardInputs } from '../../lib/cardInputs.js';
import { draftBaseline } from '../../lib/assessmentDraft.js';
import { makeDraftSaver } from '../../lib/assessmentDraftSaver.js';
import { getProficiencyScale, deleteAssessmentDraft } from '../../services/api.js';
import StudentRubricCard from './StudentRubricCard.jsx';
import { rowScores } from '../../lib/feedbackRows.js';
import { TOPICS, makeStudent, renderCard } from './testFixtures.js';

// Stub the DB saver so tests assert wiring, not I/O.
let mockSaver;
vi.mock('../../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: vi.fn(() => {
    mockSaver = { save: vi.fn(), remove: vi.fn(), flush: vi.fn(), settle: vi.fn(async () => {}), dispose: vi.fn() };
    return mockSaver;
  }),
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
  deleteAssessmentDraft: vi.fn().mockResolvedValue({}),
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

  it('on a named grading scale, `scales` names the level (the student page passes grading_scales)', () => {
    const scales = { 77: { levels: [{ name: 'Meets', average: 50 }, { name: 'Exceeds', average: 100 }] } };
    renderCard({
      topics: [], assignmentRow: { id: 50, max_points: 100, grading_scale_id: 77 },
      student: studentWith({ score: 50 }), scales,
    });
    expect(screen.getByText('Meets')).toBeInTheDocument();
    expect(screen.queryByText('50 / 100')).not.toBeInTheDocument();
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

describe('StudentRubricCard: Add update on the comment', () => {
  const commentBox = () => screen.getByPlaceholderText(/Teacher comment/);

  it('Add update inserts the line and focuses after the colon', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 23, 12, 0, 0)); // local time, so the day is stable in any zone
    try {
      renderCard({ student: studentWith({ grade_comment: 'Good work.' }) });
      fireEvent.click(screen.getByRole('button', { name: 'Add update' }));
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      const box = commentBox();
      expect(box.value).toBe('Update (23/10/2026): \n\nGood work.');
      expect(document.activeElement).toBe(box);
      expect(box.selectionStart).toBe(21);
      expect(box.selectionEnd).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the line below a Prism status line', async () => {
    const line = 'Resubmission received 20/10 - regraded.';
    renderCard({ student: studentWith({ grade_comment: `${line}\n\nGood work.`, status_line: { line } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Add update' }));
    await act(async () => {});
    const lines = commentBox().value.split('\n');
    expect(lines[0]).toBe(line);
    expect(lines[2]).toMatch(/^Update \(\d\d\/\d\d\/\d{4}\): $/);
    expect(lines[4]).toBe('Good work.');
  });

  it('no Add update with an empty comment', () => {
    renderCard({ student: studentWith({ grade_comment: '' }) });
    expect(screen.queryByRole('button', { name: 'Add update' })).not.toBeInTheDocument();
  });

  it('no Add update in view mode', () => {
    renderCard({ mode: 'view', student: studentWith({ grade_comment: 'Good work.' }) });
    expect(screen.getByText('Good work.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add update' })).not.toBeInTheDocument();
  });
});

describe('StudentRubricCard: view mode', () => {
  const ONE_TOPIC = { topics: [T1], rubric: { ...RUBRIC, topicByCriterion: [RUBRIC.topicByCriterion[0]] } };
  const setTitles = () => [...document.querySelectorAll('[title]')].filter((el) => /^Set /.test(el.title));

  it('view mode draws the grid read-only', () => {
    const { unmount } = renderCard({ ...ONE_TOPIC, student: studentWith({ scores: { t1: { grade: 'EX' } } }) });
    expect(setTitles().length).toBeGreaterThan(0); // edit mode offers the cells (so the next checks prove something)
    unmount();
    renderCard({ ...ONE_TOPIC, mode: 'view', student: studentWith({ scores: { t1: { grade: 'EX' } } }) });
    expect(setTitles()).toHaveLength(0);
    const awarded = screen.getByText('Clear and usable.').closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    fireEvent.click(screen.getByText('Polished and intuitive.'));
    expect(screen.getByText('Polished and intuitive.').closest('td')).not.toHaveAttribute('data-awarded');
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
  });

  it('showDue puts the due date in the timeline; by default (the assessment page) it is left out', () => {
    const timeline = {
      due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
      submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-12T09:00:00').getTime() / 1000), latestAt: null, late: true, day: 4, lateMinutes: null, schoologyLate: true },
      overdue: null, resubmission: null, referral: null, limit: 8,
    };
    const { unmount } = renderCard({ mode: 'view', student: studentWith({ timeline }) });
    expect(screen.getByTestId('submission-timeline')).not.toHaveTextContent('Due 06/10');
    unmount();
    renderCard({ mode: 'view', showDue: true, student: studentWith({ timeline }) });
    const row = screen.getByTestId('submission-timeline');
    expect(row).toHaveTextContent('Due 06/10 15:00');
    expect(row).toHaveTextContent('Submitted 12/10 09:00 (3 school days late)');
  });

  it('view mode draws the compact grid read-only too', () => {
    renderCard({ topics: [T1], viewMode: 'compact', mode: 'view', student: studentWith({ scores: { t1: { grade: 'EX' } } }) });
    expect(setTitles()).toHaveLength(0);
    const row = screen.getByText('Select, analyze').closest('tr');
    fireEvent.click(within(row).getAllByRole('cell')[1]);
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('');
    expect(within(row).getByText('EX')).toBeInTheDocument();
  });

  it('view mode locks the overall scale picker', () => {
    renderCard(rowCard({ scale_level: 'EX' }, { mode: 'view' }));
    const group = screen.getByRole('group', { name: SCALE.name });
    within(group).getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
    expect(screen.queryByRole('button', { name: /Use the rubric average/ })).not.toBeInTheDocument();
  });

  it('view mode shows the comment as text, with no textarea or Publish', () => {
    renderCard({ mode: 'view', student: studentWith({ grade_comment: 'Good work.\nKeep going.', comment_status: 1 }) });
    const view = document.querySelector('.grade-card__comment-view');
    expect(view).not.toBeNull();
    expect(within(view).getByText('Comment:')).toBeInTheDocument();
    expect(view).toHaveTextContent('Good work. Keep going.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard/ })).not.toBeInTheDocument();
  });

  it('view mode shows the published grade and comment, not a draft', () => {
    const student = studentWith({ grade_comment: 'Published words.', scores: { t1: { grade: 'EX' } } });
    const base = draftBaseline(student, [T1], { includeScore: false });
    renderCard({
      ...ONE_TOPIC, mode: 'view', student,
      draftRow: { base, pending: { t1: 'ED' }, comment: 'Draft words.', display: false, displayTouched: false },
    });
    expect(screen.getByText('Published words.')).toBeInTheDocument();
    expect(screen.queryByText('Draft words.')).not.toBeInTheDocument();
    expect(screen.getByText('Clear and usable.').closest('td')).toHaveAttribute('data-awarded', 'true');
  });

  it('switching a view card to edit in place starts the editor from the draft, and its saver', () => {
    const student = studentWith({ grade_comment: 'Published words.' });
    const draftRow = { base: draftBaseline(student, TOPICS, { includeScore: false }), pending: {}, comment: 'Draft words.', display: false, displayTouched: false };
    const props = { student, topics: TOPICS, courseId: '4', assignmentId: '8', assignmentRow: { id: 50 }, onSaved: () => {}, draftRow };
    const tree = (mode) => createElement(MemoryRouter, null, createElement(StudentRubricCard, { ...props, mode }));
    const { rerender } = render(tree('view'));
    expect(makeDraftSaver).not.toHaveBeenCalled();
    rerender(tree('edit'));
    expect(screen.getByPlaceholderText(/Teacher comment/).value).toBe('Draft words.');
    expect(makeDraftSaver).toHaveBeenCalledTimes(1);
    rerender(tree('view'));
    expect(mockSaver.dispose).toHaveBeenCalled();
    expect(screen.getByText('Published words.')).toBeInTheDocument();
  });

  it('view mode with no comment draws no comment block', () => {
    renderCard({ mode: 'view' });
    expect(document.querySelector('.grade-card__comment-view')).toBeNull();
  });

  it('view mode hides the restore box', () => {
    const saved_grade = { topics: { t1: 'D' }, savedAt: '2026-10-20 01:00:00', summary: 'Developing', restoreSummary: 'Developing' };
    const { unmount } = renderCard({ topics: [T1], student: studentWith({ saved_grade }) });
    expect(screen.getByRole('button', { name: 'Restore saved grade' })).toBeInTheDocument();
    unmount();
    renderCard({ topics: [T1], mode: 'view', student: studentWith({ saved_grade }) });
    expect(screen.queryByText(/Grade saved in Prism/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore saved grade' })).not.toBeInTheDocument();
  });

  it('view mode starts no draft saver', async () => {
    const legacyKey = 'prism:assessment-draft:4:8:enr-1';
    localStorage.setItem(legacyKey, JSON.stringify({ base: 'whatever', pending: {}, comment: 'old' }));
    const onPendingChange = vi.fn();
    const onDisplayChange = vi.fn();
    const registerCard = vi.fn();
    const { unmount } = renderCard({
      mode: 'view', onPendingChange, onDisplayChange, registerCard, unregisterCard: vi.fn(),
      // A stale draft: edit mode would delete it on mount.
      draftRow: { base: 'stale', pending: {}, comment: 'x' },
    });
    await act(async () => {});
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    expect(makeDraftSaver).not.toHaveBeenCalled();
    expect(deleteAssessmentDraft).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacyKey)).not.toBeNull(); // the legacy migration did not run
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(onDisplayChange).not.toHaveBeenCalled();
    expect(registerCard).not.toHaveBeenCalled();
  });

  it('view mode shows the Flags menu only', () => {
    const props = {
      topics: [T1],
      assignmentRow: { id: 50, due_date: '2026-10-01 23:59:00', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      student: studentWith({ late_work: { tone: 'red' } }),
    };
    const controls = () => ({
      refer: screen.queryByTitle('Refer to the academic office') != null,
      flags: screen.queryByRole('button', { name: /Flags/ }) != null,
      extend: screen.queryByRole('button', { name: 'Extend' }) != null,
      resubmit: screen.queryByRole('button', { name: /Ask to resubmit/ }) != null,
    });
    const { unmount } = renderCard(props);
    expect(controls()).toEqual({ refer: true, flags: true, extend: true, resubmit: true });
    unmount();
    renderCard({ ...props, mode: 'view' });
    expect(controls()).toEqual({ refer: false, flags: true, extend: false, resubmit: false });
  });

  it('view mode with resubmitEnabled false shows no Flags menu either', () => {
    renderCard({ mode: 'view', resubmitEnabled: false });
    expect(screen.queryByRole('button', { name: /Flags/ })).not.toBeInTheDocument();
  });

  it('Edit calls onEdit; Done calls onDone', async () => {
    const onEdit = vi.fn();
    const { unmount } = renderCard({ mode: 'view', onEdit });
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toHaveClass('secondary', 'btn-sm');
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    unmount();

    const order = [];
    const onDone = vi.fn(() => order.push('done'));
    renderCard({ onDone });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    mockSaver.settle.mockImplementation(async () => { order.push('settled'); });
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toHaveClass('ghost');
    await act(async () => { fireEvent.click(done); });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['settled', 'done']);
  });

  it('no Edit without onEdit, and no Done without onDone', () => {
    const { unmount } = renderCard({ mode: 'view' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    unmount();
    renderCard();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('hasDraft shows the draft mark', () => {
    const { unmount } = renderCard({ mode: 'view' });
    expect(screen.queryByText('● Draft - not published')).not.toBeInTheDocument();
    unmount();
    renderCard({ mode: 'view', hasDraft: true });
    expect(screen.getByText('● Draft - not published')).toBeInTheDocument();
  });

  it('heading replaces the name; false draws none', () => {
    const { unmount } = renderCard({ mode: 'view' });
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toBeInTheDocument();
    unmount();
    const second = renderCard({ mode: 'view', heading: createElement('span', null, 'Unit 3 project') });
    expect(screen.getByText('Unit 3 project')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ada Lovelace' })).not.toBeInTheDocument();
    second.unmount();
    renderCard({ mode: 'view', heading: false });
    expect(screen.queryByRole('link', { name: 'Ada Lovelace' })).not.toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
  });

  describe('the proficiency scale', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('twenty view cards request the proficiency scale once', async () => {
      // The real (memoised) request behind the mocked export: the card asks per mount, the
      // network sees one request.
      const actual = await vi.importActual('../../services/api.js');
      getProficiencyScale.mockImplementation(actual.getProficiencyScale);
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schoologyScaleId: 1, levels: [] }) }));
      vi.stubGlobal('fetch', fetchMock);
      const cards = Array.from({ length: 20 }, (_, i) => createElement(StudentRubricCard, {
        key: i, mode: 'view', student: { ...makeStudent(), id: i + 1, enrollment_id: `enr-${i + 1}`, schoology_uid: `uid-${i + 1}` },
        topics: TOPICS, courseId: '4', assignmentId: '8', assignmentRow: { id: 50 }, onSaved: () => {},
      }));
      render(createElement(MemoryRouter, null, createElement(Fragment, null, ...cards)));
      await act(async () => {});
      expect(getProficiencyScale).toHaveBeenCalledTimes(20);
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/proficiency-scale')).toHaveLength(1);
    });
  });
});
