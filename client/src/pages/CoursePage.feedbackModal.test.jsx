// Gradebook pop-up = the shared grade card (#176), read-only, with Edit and Done in place on a course
// Prism can write. Its one card comes from GET /api/students/:id/grade-cards?assignmentId=, this
// student's data only. Full rubric descriptors widen the pop-up (so does edit mode); points-only
// cells ("50 / 100") open it too. The pop-up keeps its own header and "Open full grading page".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Edit mode's draft saver: tests assert wiring, not I/O.
vi.mock('../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: vi.fn(() => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), settle: vi.fn(async () => {}), dispose: vi.fn() })),
}));
vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getGradeCards: vi.fn(),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'ok', links: {} }),
  getSubmissionFiles: vi.fn().mockResolvedValue({ revisions: [], summary: { revisions: 0, files: 0 }, read_at: null }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getQuizGroups: vi.fn().mockResolvedValue({ groups: [] }),
  getCourseCommentSummaries: vi.fn().mockResolvedValue({ assignments: {} }),
  getRubricsForAssignments: vi.fn().mockResolvedValue({ attachments: {} }),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: { produc: '#B4A7D6' } }),
  getSettings: vi.fn().mockResolvedValue({ triage: { resubmitLessonsDefault: 4 } }),
  getTriagePair: vi.fn().mockResolvedValue(null),
  getFeedbackForAssignment: vi.fn().mockResolvedValue({}),
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
  getGradeFlags: vi.fn(),
  setGradeFlag: vi.fn(),
}));

import { RubricModal, GradebookView } from './CoursePage.jsx';
import { draftBaseline } from '../lib/assessmentDraft.js';
import {
  getGradeCards, getRubricsForAssignments, getCourseCommentSummaries, getGradeFlags, setGradeFlag, getFeedbackForAssignment,
} from '../services/api.js';

// ── Card fixtures, in the shape GET /api/students/:id/grade-cards returns ───────────────────────
const STUDENT = { id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' };
const TOPICS = [{ id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing' }];
const RUBRIC = {
  id: 1,
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};
const ROWS_RUBRIC = {
  id: 4, topicByCriterion: [],
  rubric: { criteria: [{ id: 'c9', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work',
    descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } }] },
};
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
const PICTURE = 'https://example.test/ada.jpg';
const WRITABLE = { id: 5, archived: 0, excluded: 0, writable: true };

const cardStudent = (over = {}) => ({
  id: 10, schoology_uid: 'u1', enrollment_id: 'e1', first_name: 'Ada', last_name: 'Lovelace',
  preferred_name: null, preferred_name_teacher: null, picture_url: PICTURE,
  scores: { t1: { grade: 'EX' } }, grade_comment: 'Great use of evidence.', comment_status: 1, exception: 0,
  score: 75, submission_type: null, submitted_at: 0, late: 0, draft: 0, timeline: null,
  attention: { handedIn: true, reasons: [] }, row_levels: {}, scale_level: null, saved_grade: null, ...over,
});
const makeCard = ({ assignment = {}, student = {}, topics = TOPICS, scoreScale = null, rubric = null, draft = null, hasDraft = false } = {}) => ({
  assignment: {
    id: 3, schoology_assignment_id: 'sa-1', course_id: 5, title: 'Project', due_date: null,
    max_points: 100, grading_scale_id: null, accepts_submissions: 1, is_test: 0, is_lti_submission: 0,
    mastery_grading_period_id: 1, mastery_grading_category_id: 2, ...assignment,
  },
  topics, scoreScale, student: cardStudent(student), rubric, draft, hasDraft,
});
// The server's answer for the pop-up's one task.
const serve = (card, course = WRITABLE) => getGradeCards.mockResolvedValue({
  course, cards: { [card.assignment.schoology_assignment_id]: card },
});

const ASSIGNMENT = { id: 3, title: 'Project', schoology_assignment_id: 'sa-1', due_date: null, is_lti_submission: 0, aligned: 1 };
const GRADE = { score: 75, exception: 0, resubmit_requested: false, resubmitted: false };

function renderModal(props = {}) {
  return render(
    <MemoryRouter>
      <RubricModal student={STUDENT} assignment={ASSIGNMENT} courseId="5" grade={GRADE} onClose={() => {}} {...props} />
    </MemoryRouter>
  );
}
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => vi.clearAllMocks());

describe('RubricModal: the grade card, read-only (#176)', () => {
  it('reads this one task\'s card and shows the full descriptors, the awarded level, the comment below, wide', async () => {
    serve(makeCard({ rubric: RUBRIC }));
    renderModal();
    const awarded = (await screen.findByText('Clear and usable.')).closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    expect(getGradeCards).toHaveBeenCalledWith(10, { courseId: '5', assignmentId: 'sa-1' });
    expect(getGradeCards).toHaveBeenCalledTimes(1);
    expect(getRubricsForAssignments).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveClass('feedback-modal--wide');
    expect(follows(awarded, screen.getByText('Great use of evidence.'))).toBe(true);
    // The pop-up's own header and footer stay; the card has no heading of its own.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getByText('S')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open full grading page/ })).toHaveAttribute('href', '/course/5/assessment/sa-1');
    expect(within(dialog).queryByRole('link', { name: 'Ada Lovelace' })).toBeNull();
  });

  it('without an attached rubric keeps the compact grid at the narrow width', async () => {
    serve(makeCard());
    renderModal();
    expect(await screen.findByText('Measurement Topic')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveClass('feedback-modal--wide');
  });

  it('shows the header at once and "Loading…" until the card arrives; a failed read says so', async () => {
    getGradeCards.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = renderModal();
    expect(within(screen.getByRole('dialog')).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();
    getGradeCards.mockRejectedValueOnce(new Error('boom'));
    renderModal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this grade. Reload the page.');
  });

  it('never shows a portrait or a suggestion, in view or edit mode', async () => {
    serve(makeCard({ rubric: RUBRIC }));
    renderModal();
    await screen.findByText('Clear and usable.');
    const shown = () => ({
      photo: document.querySelector(`img[src="${PICTURE}"]`) != null,
      suggested: screen.queryAllByText(/Suggested/).length > 0,
      notes: screen.queryAllByText('Reviewer notes').length > 0,
      sparkles: screen.queryAllByTestId('ai-sparkle').length > 0,
    });
    const none = { photo: false, suggested: false, notes: false, sparkles: false };
    expect(shown()).toEqual(none);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(shown()).toEqual(none);
    expect(getFeedbackForAssignment).not.toHaveBeenCalled();
  });
});

describe('RubricModal: points-only task', () => {
  it('shows the score, the comment and F, with no rubric, narrow', async () => {
    serve(makeCard({
      topics: [], assignment: { schoology_assignment_id: 'sa-2', title: 'Ep 1 Result' },
      student: { score: 50, scores: {}, grade_comment: 'Revise question 3.' },
    }));
    renderModal({ assignment: { ...ASSIGNMENT, title: 'Ep 1 Result', schoology_assignment_id: 'sa-2', aligned: 0 } });
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('50 / 100')).toBeInTheDocument();
    expect(within(dialog).getByText('Score:')).toBeInTheDocument();
    expect(within(dialog).getByText('Revise question 3.')).toBeInTheDocument();
    // A formative task is marked F, not S.
    expect(within(dialog).getByText('F')).toBeInTheDocument();
    expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();
    expect(dialog).not.toHaveClass('feedback-modal--wide');
  });

  it('on a named grading scale shows the level name (the gradebook\'s grading_scales)', async () => {
    serve(makeCard({ topics: [], assignment: { grading_scale_id: 77 }, student: { score: 50, scores: {} } }));
    const scales = { 77: { levels: [{ name: 'Meets', average: 50 }, { name: 'Exceeds', average: 100 }] } };
    renderModal({ assignment: { ...ASSIGNMENT, aligned: 0 }, scales });
    expect(await screen.findByText('Meets')).toBeInTheDocument();
    expect(screen.queryByText('50 / 100')).not.toBeInTheDocument();
  });
});

describe('RubricModal: feedback rows on an unaligned task', () => {
  it('shows the rows with this student\'s levels, then the overall level, and widens', async () => {
    serve(makeCard({
      topics: [], scoreScale: SCALE, rubric: ROWS_RUBRIC,
      assignment: { schoology_assignment_id: 'sa-3', title: 'Flappy Bird (F)' },
      student: { scores: {}, row_levels: { Playtesting: 'D' }, scale_level: 'D' },
    }));
    renderModal({ assignment: { ...ASSIGNMENT, title: 'Flappy Bird (F)', schoology_assignment_id: 'sa-3', aligned: 0 } });
    expect((await screen.findByText('Tests once.')).closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(getGradeCards).toHaveBeenCalledWith(10, { courseId: '5', assignmentId: 'sa-3' });
    const overall = screen.getByRole('group', { name: 'General Academic Scale' });
    expect(within(overall).getByRole('button', { pressed: true })).toHaveTextContent('Developing');
    expect(screen.getByRole('dialog')).toHaveClass('feedback-modal--wide');
  });
});

describe('RubricModal: submission comments in the card\'s header', () => {
  it('shows the comments chip beside the status pill when the feature is on', async () => {
    serve(makeCard({ student: { score: null, submitted_at: 1, submission_type: 'drop' } }));
    renderModal({
      grade: { ...GRADE, score: null, submitted_at: 1, submission_type: 'drop' },
      commentSummary: { count: 2, read_at: '2026-10-17T02:00:00.000Z' }, onCommentSummary: () => {},
    });
    const chip = await screen.findByRole('button', { name: /2 submission comments/ });
    expect(follows(screen.getByText('Submitted'), chip)).toBe(true);
    expect(follows(chip, screen.getByText('Measurement Topic'))).toBe(true);
  });

  it('shows no chip when the feature is off (no summary callback)', async () => {
    serve(makeCard());
    renderModal();
    await screen.findByText('Measurement Topic');
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
  });
});

describe('GradebookView: points-only cells open the pop-up', () => {
  const data = {
    assignments: [{ id: 1, title: 'Ep 1 Result', schoology_assignment_id: 'sa-2', aligned: 0, is_lti_submission: 0, max_points: 100, due_date: '2020-01-01 00:00:00' }],
    students: [STUDENT],
    grades: { 10: { 1: { score: 50, exception: 0, grade_comment: 'Revise question 3.', submitted_at: 1, submission_type: 'drop' } } },
    grading_scales: {},
  };

  it('opens the grade card from a "50 / 100" cell', async () => {
    serve(makeCard({
      topics: [], assignment: { id: 1, schoology_assignment_id: 'sa-2', title: 'Ep 1 Result' },
      student: { score: 50, scores: {}, grade_comment: 'Revise question 3.', submitted_at: 1, submission_type: 'drop' },
    }));
    render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
    await screen.findByRole('button', { name: /50 \/ 100/ });
    expect(getCourseCommentSummaries).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /50 \/ 100/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(await within(dialog).findByText('50 / 100')).toBeInTheDocument();
    expect(within(dialog).getByText('Revise question 3.')).toBeInTheDocument();
    expect(getGradeCards).toHaveBeenCalledWith(10, { courseId: '5', assignmentId: 'sa-2' });
  });

  it('the open pop-up reads its card again when the gradebook data is replaced', async () => {
    serve(makeCard({ topics: [], assignment: { id: 1, schoology_assignment_id: 'sa-2' }, student: { score: 50, scores: {} } }));
    const { rerender } = render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /50 \/ 100/ }));
    await within(await screen.findByRole('dialog')).findByText('Score:');
    expect(getGradeCards).toHaveBeenCalledTimes(1);
    rerender(<MemoryRouter><GradebookView data={{ ...data }} courseId="5" mastery={null} /></MemoryRouter>);
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// #40: work marked Missing shows IE on every topic (the card's Missing view).
describe('RubricModal: Missing shows IE (#40)', () => {
  it('no topic levels: IE with the Missing symbol and the line above the rubric', async () => {
    serve(makeCard({ student: { exception: 3, score: null, scores: {} } }));
    renderModal({ grade: { ...GRADE, score: null, exception: 3 } });
    const line = await screen.findByText('Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.');
    const dialog = screen.getByRole('dialog');
    const cell = within(dialog).getByText('Select, analyze').closest('tr').querySelectorAll('td')[5];
    expect(cell).toHaveTextContent('IE');
    expect(within(cell).getByRole('img', { name: 'Missing' })).toBeInTheDocument();
    expect(follows(line, within(dialog).getByRole('table'))).toBe(true);
  });
});

// #40: a marker (Late, Incomplete, Absent) keeps the symbol in the cell and the pop-up shows the
// rubric with the marker line; Exempt shows the card's lock; Missing shows IE on every topic.
describe('GradebookView: flagged cells on an aligned task (#40)', () => {
  const mastery = {
    alignments: [{ assignment_schoology_id: 'sa-1', topic_id: 't1', topic_title: 'Select, analyze', topic_external_id: 'ART.5.1', category_title: 'HS Art: Producing' }],
    scores: [{ student_uid: 'u1', assignment_schoology_id: 'sa-1', topic_id: 't1', grade: 'EX' }],
  };
  const dataWith = (exception) => ({
    assignments: [{ id: 3, title: 'Project', schoology_assignment_id: 'sa-1', aligned: 1, is_lti_submission: 0, max_points: 100, due_date: '2020-01-01 00:00:00' }],
    students: [STUDENT],
    grades: { 10: { 3: { score: null, exception, grade_comment: '', submitted_at: 1, submission_type: 'drop' } } },
    grading_scales: {},
  });

  it.each([[6, 'Late'], [2, 'Incomplete'], [5, 'Absent']])('marker %i: the cell keeps the symbol and opens the pop-up with the rubric', async (exception, name) => {
    serve(makeCard({ student: { exception, score: null, grade_comment: '' } }));
    render(<MemoryRouter><GradebookView data={dataWith(exception)} courseId="5" mastery={mastery} /></MemoryRouter>);
    const button = await screen.findByRole('button', { name: new RegExp(`${name}: show feedback`) });
    expect(button.querySelector('.flag-symbol')).not.toBeNull();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Measurement Topic')).toBeInTheDocument();
    expect(within(dialog).getByText(`Grading this work clears ${name}.`)).toBeInTheDocument();
  });

  it('Missing: the cell keeps the symbol and the pop-up shows IE on every topic (no levels in Schoology)', async () => {
    serve(makeCard({ student: { exception: 3, score: null, scores: {}, grade_comment: '' } }));
    render(<MemoryRouter><GradebookView data={dataWith(3)} courseId="5" mastery={{ ...mastery, scores: [] }} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Missing: show feedback/ }));
    const dialog = await screen.findByRole('dialog');
    const cell = (await within(dialog).findByText('Select, analyze')).closest('tr').querySelectorAll('td')[5];
    expect(cell).toHaveTextContent('IE');
    expect(within(cell).getByRole('img', { name: 'Missing' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Shown as IE because the work is marked Missing/)).toBeInTheDocument();
  });

  it('a final flag (Exempt): the pop-up shows the card\'s locked rubric', async () => {
    serve(makeCard({ student: { exception: 1, score: null, grade_comment: '' } }));
    render(<MemoryRouter><GradebookView data={dataWith(1)} courseId="5" mastery={mastery} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Exempt: show feedback/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Exempt, rubric locked')).toBeInTheDocument();
  });
});

// #40 flags and #176 Edit: only where Prism can write the course (course.writable).
describe('RubricModal: the Flags menu (#40)', () => {
  it('on a writable course: clearing a flag with no copy writes, reads the card again and refreshes the gradebook', async () => {
    getGradeFlags.mockResolvedValue({ exception: 6, score: null, graded: false, gradeText: null, savedGrade: null, openRecords: [], hasDraft: false });
    setGradeFlag.mockResolvedValue({ exception: 0, saved: false, withdrawn: [], line: null, restored: null });
    serve(makeCard({ student: { exception: 6, score: null, grade_comment: 'Seen.' } }));
    const onFlagChange = vi.fn().mockResolvedValue(undefined);
    renderModal({ grade: { ...GRADE, score: null, exception: 6, grade_comment: 'Seen.' }, onFlagChange });
    const pill = await screen.findByRole('button', { name: /Late/ });
    expect(pill).toHaveClass('flags-pill--late');
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Late/ }));
    await waitFor(() => expect(setGradeFlag).toHaveBeenCalledWith({
      studentId: 10, assignmentId: 3, code: 0, expected: { exception: 6, score: null, comment: 'Seen.' }, reason: null, restore: false,
    }));
    await waitFor(() => expect(onFlagChange).toHaveBeenCalled());
    expect(getGradeFlags).toHaveBeenCalledWith(10, 3);
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['archived', { id: 5, archived: 1, excluded: 0, writable: false }],
    ['excluded', { id: 5, archived: 0, excluded: 1, writable: false }],
    ['linked', { id: 5, archived: 0, excluded: 0, writable: false }],
  ])('no Flags and no Edit on an %s course', async (_, course) => {
    serve(makeCard({ rubric: RUBRIC }), course);
    renderModal({ onFlagChange: vi.fn() });
    await screen.findByText('Clear and usable.');
    expect(screen.queryByRole('button', { name: /Flags/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('RubricModal: Edit and Done (#176)', () => {
  // The task's draft as the server holds it when Edit is pressed.
  const withDraft = (comment) => {
    const c = makeCard();
    return { ...c, hasDraft: true, draft: { base: draftBaseline(c.student, c.topics, { includeScore: false }), pending: {}, comment, display: true, displayTouched: false } };
  };

  it('Edit in the pop-up switches the card to edit mode; Done refreshes the gradebook', async () => {
    serve(makeCard());
    const onFlagChange = vi.fn().mockResolvedValue(undefined);
    renderModal({ onFlagChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Great use of evidence.');
    expect(getGradeCards).toHaveBeenCalledTimes(2); // read again before edit mode
    // Edit mode takes the wide pop-up.
    expect(screen.getByRole('dialog')).toHaveClass('feedback-modal--wide');
    expect(onFlagChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    await waitFor(() => expect(onFlagChange).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveClass('feedback-modal--wide');
  });

  it('Edit, Done, Edit again starts from the server\'s newer draft', async () => {
    serve(makeCard());
    renderModal({ onFlagChange: vi.fn().mockResolvedValue(undefined) });
    const edit = await screen.findByRole('button', { name: 'Edit' });
    getGradeCards.mockResolvedValueOnce({ course: WRITABLE, cards: { 'sa-1': withDraft('First pass.') } });
    fireEvent.click(edit);
    expect(await screen.findByRole('textbox')).toHaveValue('First pass.');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());

    getGradeCards.mockResolvedValueOnce({ course: WRITABLE, cards: { 'sa-1': withDraft('Second pass, saved since.') } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox')).toHaveValue('Second pass, saved since.');
    expect(getGradeCards).toHaveBeenLastCalledWith(10, { courseId: '5', assignmentId: 'sa-1' });
  });

  it('a failed read on Edit keeps the read-only card and says so', async () => {
    serve(makeCard());
    renderModal({ onFlagChange: vi.fn() });
    const edit = await screen.findByRole('button', { name: 'Edit' });
    getGradeCards.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(edit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this task. Reload the page.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('closing the pop-up in edit mode refreshes the gradebook', async () => {
    serve(makeCard());
    const onFlagChange = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderModal({ onFlagChange, onClose });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(onFlagChange).toHaveBeenCalledTimes(1));
  });

  it('closing a read-only pop-up refreshes nothing', async () => {
    serve(makeCard());
    const onFlagChange = vi.fn();
    const onClose = vi.fn();
    renderModal({ onFlagChange, onClose });
    await screen.findByRole('button', { name: 'Edit' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(onFlagChange).not.toHaveBeenCalled();
  });
});
