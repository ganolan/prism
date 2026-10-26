import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AttemptsTab from './AttemptsTab.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getQuizAttempts: vi.fn(), getMasteryForAssignment: vi.fn(), getFeedbackForAssignment: vi.fn(),
  getFeatures: vi.fn(), getDraftsForAssignment: vi.fn(), rebuildQuizOverall: vi.fn(), sendAllGrades: vi.fn(), saveFrqMark: vi.fn(), postFrqWritebacks: vi.fn(),
}));
// The grade card has its own tests: here a stub that shows which task it draws and registers for Publish all.
vi.mock('../gradeCard/StudentRubricCard.jsx', async () => {
  const { useEffect } = await import('react');
  return {
    default: function CardStub({ student, assignmentId, assignmentRow, feedbackRow, draftRow, quizResult, onRebuildQuiz, registerCard, unregisterCard, onPendingChange }) {
      useEffect(() => {
        registerCard(student.schoology_uid, { getEntry: () => ({ entry: { uid: student.schoology_uid, assignmentId }, patch: {} }), applyResult: () => {} });
        onPendingChange(student.schoology_uid, 'publish');
        return () => unregisterCard(student.schoology_uid);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <div data-testid="test-card" data-assignment={assignmentId} data-is-test={assignmentRow?.is_test} data-quiz-line={quizResult ? 'shown' : 'none'}>
          {feedbackRow?.feedback_parsed?.narrative_feedback}
          {draftRow && <span>{`Draft: ${draftRow.comment}`}</span>}
          {quizResult?.overall?.stale && <button type="button" onClick={() => onRebuildQuiz(quizResult.student_id)}>Update numbers</button>}
        </div>
      );
    },
  };
});

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'x' }, { points: 2, name: 'Developing', descriptionHtml: 'x' }] }] };
const OPTIONS = ['A', 'B', 'C', 'D'].map(l => ({ letter: l, html: `<p>${l}. Option ${l}</p>`, is_key: l === 'C', count: l === 'C' ? 11 : 3 }));
const MEMBERS = [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }];
const mcq = (letter, key = 'C') => ({ kind: 'mcq', chosen_letter: letter, key_letter: key, is_correct: letter === key, points: letter === key ? 1 : 0, max_points: 1 });
const frq = (html) => ({ kind: 'frq', answer_html: html, schoology: null, mark: null });
const student = (id, uid, last, member, extra = {}) => ({
  student_id: id, name: `Ana ${last}`, schoology_uid: uid, member, attempt_id: 100 + id, attempt_url: `https://s/attempt/${uid}`,
  score: 13, max_score: 20, started_at: '2026-10-09 06:00:00', completed_at: '2026-10-09 06:35:00',
  mcq: { correct: 13, total: 20, percent: 65 }, frq: [{ question: 21, has_rubric: true, max_points: 4, confirmed: true, levels: [{ row: 'Content Knowledge', level: 'Developing', points: 2 }], points: 2 }],
  by_tag: [{ tag: 'AAP-1.A', correct: 1, total: 2, percent: 50 }], ready: true, blocked: [], overall: null,
  responses: { 1: mcq('B'), 21: frq(`<p>answer ${last}</p>`) }, ...extra,
});
const DATA = () => ({
  group: { id: 7, title: 'Ep 1', members: MEMBERS, has_tags: true },
  questions: [
    { id: 11, position: 1, kind: 'mcq', stem_html: '<p>Which value?</p>', max_points: 1, tags: ['AAP-1.A'], options: OPTIONS, facility: 0.55, band: 'Divided' },
    { id: 21, position: 21, kind: 'frq', stem_html: '<p>Explain</p>', max_points: 4, tags: [], rubric: RUBRIC },
  ],
  students: [
    student(1, 'u1', 'Lee', MEMBERS[0], { overall: { stale: true, impression: 'Good.' } }),
    student(2, 'u2', 'Ng', MEMBERS[1], { responses: { 1: mcq('C'), 21: frq('<p>answer Ng</p>') } }),
  ],
  not_taken: [{ student_id: 3, name: 'Ana Wu', schoology_uid: 'u3' }],
});
const mastery = (sid) => ({
  assignment: { schoology_assignment_id: sid, title: sid === '900' ? 'Ep 1' : 'Ep 1 *', is_test: 1 }, topics: [], scoreScale: null,
  students: [{ id: 1, schoology_uid: 'u1', first_name: 'Ana', last_name: 'Lee', enrollment_id: 'e1', score: 13 },
    { id: 2, schoology_uid: 'u2', first_name: 'Ana', last_name: 'Ng', enrollment_id: 'e2', score: 13 }],
});

function renderTab(data = DATA(), { path = '/', group = { id: 7, loaded_at: '2026-10-26 06:31:21' } } = {}) {
  vi.mocked(api.getQuizAttempts).mockResolvedValue(data);
  return render(<MemoryRouter initialEntries={[path]}><AttemptsTab group={group} courseId={5} reloadKey="" /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMasteryForAssignment).mockImplementation(async (_c, sid) => mastery(sid));
  vi.mocked(api.getFeedbackForAssignment).mockImplementation(async (sid) => (sid === '900'
    ? { 1: { feedback_parsed: { narrative_feedback: 'Multiple choice: 13/20 (65%)' } } } : {}));
  vi.mocked(api.getFeatures).mockResolvedValue({ quiz_writeback: true });
  vi.mocked(api.getDraftsForAssignment).mockResolvedValue({});
  vi.mocked(api.rebuildQuizOverall).mockResolvedValue({});
  vi.mocked(api.sendAllGrades).mockResolvedValue({ results: [] });
});

const attempt = () => screen.getByRole('region', { name: /attempt$/ });

describe('Attempts, By student', () => {
  test('opens on the first student; Previous and Next walk the class', async () => {
    renderTab();
    expect(await screen.findByRole('region', { name: "Ana Lee's attempt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next student' }));
    expect(screen.getByRole('region', { name: "Ana Ng's attempt" })).toBeVisible();
    expect(screen.queryByRole('region', { name: "Ana Lee's attempt" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous student' }));
    expect(screen.getByRole('region', { name: "Ana Lee's attempt" })).toBeInTheDocument();
  });

  test('the header names the test taken when the group has several, the attempt link and the time taken; the card draws the quiz line', async () => {
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).getByText('Ep 1')).toBeInTheDocument();
    expect(within(lee).getByRole('link', { name: /Attempt: open Ana Lee's test attempt/ })).toHaveAttribute('href', 'https://s/attempt/u1');
    expect(within(lee).getByText('35 min')).toBeInTheDocument();
    await waitFor(() => expect(within(lee).getByTestId('test-card')).toHaveAttribute('data-quiz-line', 'shown'));
  });

  test('a group of one test does not name it', async () => {
    const data = DATA();
    data.group.members = [MEMBERS[0]];
    data.students = [data.students[0]];
    renderTab(data);
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).queryByText('Ep 1')).toBeNull();
  });

  test('the test card is the member test grade card with the test suggestion', async () => {
    renderTab();
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    await waitFor(() => expect(within(attempt()).getByTestId('test-card')).toHaveAttribute('data-assignment', '900'));
    expect(within(attempt()).getByTestId('test-card')).toHaveTextContent('Multiple choice: 13/20 (65%)');
    fireEvent.click(screen.getByRole('button', { name: 'Next student' }));
    await waitFor(() => expect(within(attempt()).getByTestId('test-card')).toHaveAttribute('data-assignment', '901'));
  });

  test('Update numbers rebuilds the test suggestion', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Update numbers' }));
    await waitFor(() => expect(api.rebuildQuizOverall).toHaveBeenCalledWith(7, 1));
  });

  test('an MCQ shows the choice, the key when wrong, and the class percent', async () => {
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).getByLabelText('Q1: chose B, incorrect. Answer C. Class 55% correct.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next student' }));
    expect(within(attempt()).getByLabelText('Q1: chose C, correct. Class 55% correct.')).toBeInTheDocument();
  });

  test('an FRQ shows its marking card with the answer', async () => {
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).getByText('answer Lee')).toBeInTheDocument();
    expect(within(lee).getByRole('textbox', { name: 'Comment for Ana Lee' })).toBeInTheDocument();
  });

  test('FRQ only hides the MCQs; it is not offered without both kinds', async () => {
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    fireEvent.click(screen.getByRole('button', { name: 'FRQ only' }));
    expect(within(lee).queryByLabelText(/^Q1:/)).toBeNull();
    expect(within(lee).getByText('answer Lee')).toBeInTheDocument();
  });

  test('FRQ only is not offered when the quiz has no MCQ', async () => {
    const data = DATA();
    data.questions = data.questions.filter(q => q.kind === 'frq');
    renderTab(data);
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(screen.queryByRole('button', { name: 'FRQ only' })).toBeNull();
  });

  test('By tag shows only when the quiz has tags', async () => {
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).getByText('AAP-1.A: 50%')).toBeInTheDocument();
  });

  test('no By tag line when the quiz has no tags', async () => {
    const data = DATA();
    data.group.has_tags = false;
    renderTab(data);
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(within(lee).queryByText(/AAP-1\.A: /)).toBeNull();
  });

  test('Publish test comments sends every card, each to the test that student took', async () => {
    renderTab();
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    await waitFor(() => expect(screen.getByRole('button', { name: /Publish test comments \(2\)/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Publish test comments/ }));
    await waitFor(() => expect(api.sendAllGrades).toHaveBeenCalled());
    const [courseId, entries] = vi.mocked(api.sendAllGrades).mock.calls[0];
    expect(courseId).toBe(5);
    expect(entries.map(e => [e.uid, e.assignmentId])).toEqual([['u1', '900'], ['u2', '901']]);
  });

  // Final review fixes (#200).
  test('the Grading tab\'s ?view=compact does not reach the Attempts view', async () => {
    renderTab(DATA(), { path: '/?view=compact' });
    expect(await screen.findByRole('region', { name: "Ana Lee's attempt" })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'By student' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a test comment draft is restored on the card', async () => {
    vi.mocked(api.getDraftsForAssignment).mockImplementation(async (sid) => (sid === '900' ? { 1: { comment: 'half written' } } : {}));
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(await within(lee).findByText('Draft: half written')).toBeInTheDocument();
    expect(api.getDraftsForAssignment).toHaveBeenCalledWith('901');
  });

  test('only the attempt on screen draws its questions; every test card stays mounted', async () => {
    renderTab();
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    await waitFor(() => expect(document.querySelectorAll('[data-testid="test-card"]')).toHaveLength(2));
    expect(document.querySelectorAll('.mcq-answer')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="frq-card"]')).toHaveLength(1);
  });

  test('a member test that cannot be read leaves the other attempts working', async () => {
    vi.mocked(api.getMasteryForAssignment).mockImplementation(async (_c, sid) => { if (sid === '901') throw new Error('offline'); return mastery(sid); });
    renderTab();
    const lee = await screen.findByRole('region', { name: "Ana Lee's attempt" });
    await waitFor(() => expect(within(lee).getByTestId('test-card')).toBeInTheDocument());
    expect(screen.queryByText('offline')).toBeNull();
    expect(screen.getByText(/Could not read Ep 1 \*: offline/)).toBeInTheDocument();
  });

  test('loaded results with nobody taking the test say so', async () => {
    const data = DATA();
    data.students = [];
    renderTab(data);
    expect(await screen.findByText('Nobody has taken this test yet.')).toBeInTheDocument();
  });

  test('results never loaded say to press Load results', async () => {
    const data = DATA();
    data.students = [];
    renderTab(data, { group: { id: 7, loaded_at: null } });
    expect(await screen.findByText('No attempts loaded yet: press Load results.')).toBeInTheDocument();
  });

  test('students who did not take it are listed under Not taken', async () => {
    renderTab();
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(screen.getByText('Not taken (1): Ana Wu')).toBeInTheDocument();
  });
});

// Ported from the Free response tab (retired by #200): the FRQ marking views and their filters.
const FRQ_RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [{ points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
const mark = (over) => ({ state: 'suggested', suggested: { cells: { 146: 4 }, comment: 's' }, final: null, suggestion_revised: false, writeback: { status: null }, changed_in_schoology: false, ...over });
const frqResp = (answer, m = null, schoology = null) => ({ kind: 'frq', answer_html: answer, schoology, mark: m });
const FRQ_DATA = () => ({
  group: { id: 7, title: 'Ep 1', members: [MEMBERS[0]], has_tags: false },
  questions: [
    { id: 1, position: 21, kind: 'frq', stem_html: '<p>Q21 stem</p>', max_points: 4, tags: [], rubric: FRQ_RUBRIC },
    { id: 2, position: 22, kind: 'frq', stem_html: '<p>Q22 stem</p>', max_points: 4, tags: [], rubric: FRQ_RUBRIC },
  ],
  students: [
    student(1, 'u1', 'Lee', MEMBERS[0], { responses: { 21: frqResp('Ana 21', mark()), 22: frqResp('Ana 22') } }),
    student(2, 'u2', 'Ho', MEMBERS[0], { name: 'Ben Ho', responses: {
      21: frqResp('Ben 21', mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } })),
      22: frqResp('Ben 22', null, { cells: { 146: 2 }, comment: 'c' }) } }),
  ],
  not_taken: [],
});
// By question's own region: the By student attempts stay mounted (hidden) for Publish test comments.
const bq = () => screen.getByRole('region', { name: 'By question' });
const byQuestion = async (data) => {
  renderTab(data);
  fireEvent.click(await screen.findByRole('tab', { name: 'By question' }));
};

describe('Attempts, By question', () => {
  beforeEach(() => { vi.mocked(api.getFeatures).mockResolvedValue({ quiz_writeback: false }); });

  test('the picker lists every question; an MCQ shows each student\'s choice and the option counts', async () => {
    await byQuestion(DATA());
    const picker = within(bq()).getByRole('combobox', { name: 'Question' });
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Q1', 'Q21']);
    expect(within(bq()).getByText('Which value?')).toBeInTheDocument();
    expect(within(bq()).getByText('A 3, B 3, C 11 (answer), D 3')).toBeInTheDocument();
    expect(within(bq()).getByLabelText('Ana Lee, Q1: chose B, incorrect. Answer C. Class 55% correct.')).toBeInTheDocument();
    expect(within(bq()).getByLabelText('Ana Ng, Q1: chose C, correct. Class 55% correct.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: "Ana Lee's attempt" })).toBeNull();
  });

  test('an FRQ shows the stem once and one marking card per student; the picker sets it for every card', async () => {
    await byQuestion(FRQ_DATA());
    expect(within(bq()).getByText('Q21 stem')).toBeInTheDocument();
    expect(within(bq()).getByText('Ana 21')).toBeInTheDocument();
    expect(within(bq()).getByText('Ben 21')).toBeInTheDocument();
    fireEvent.change(within(bq()).getByRole('combobox', { name: 'Question' }), { target: { value: '22' } });
    const shown = within(bq()).getAllByTestId('frq-card');
    expect(shown.map(c => within(c).queryByText(/^(Ana|Ben) 2\d$/)?.textContent)).toEqual(['Ana 22', 'Ben 22']);
  });

  test('filters, and shows how many marks wait for the agent', async () => {
    await byQuestion(FRQ_DATA());
    expect(screen.getByText('1 waiting for the agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to post' }));
    const shown = within(bq()).getAllByTestId('frq-card');
    expect(shown.map(c => within(c).getByText(/^(Ana|Ben) 21$/).textContent)).toEqual(['Ben 21']);
  });

  test('with quiz_writeback on, the post bar replaces "waiting for the agent" and reloads after posting', async () => {
    vi.mocked(api.getFeatures).mockResolvedValue({ quiz_writeback: true });
    vi.mocked(api.postFrqWritebacks).mockResolvedValue({ results: [{ student_id: 2, name: 'Ben Ho', question: 21, level: 'Exhibiting Depth', status: 'posted', error: null }], remaining: 0 });
    renderTab(FRQ_DATA());
    fireEvent.click(await screen.findByRole('button', { name: 'Publish all to Schoology (1)' }));
    expect(screen.queryByText('1 waiting for the agent')).toBeNull();
    expect(await screen.findByText('Published: Ben Ho, Q21 Exhibiting Depth')).toBeInTheDocument();
    await waitFor(() => expect(api.getQuizAttempts).toHaveBeenCalledTimes(2));
  });

  test('the post count leaves out marks on a rubric with more than one row', async () => {
    vi.mocked(api.getFeatures).mockResolvedValue({ quiz_writeback: true });
    const data = FRQ_DATA();
    data.questions[1].rubric = { ...FRQ_RUBRIC, rows: [FRQ_RUBRIC.rows[0], { ...FRQ_RUBRIC.rows[0], id: '147' }] };
    data.students[1].responses[22] = frqResp('Ben 22', mark({ state: 'edited', final: { cells: { 146: 4, 147: 4 }, comment: 'c' }, writeback: { status: 'pending' } }));
    renderTab(data);
    expect(await screen.findByRole('button', { name: 'Publish all to Schoology (1)' })).toBeInTheDocument();
  });

  test('a saved card updates in place', async () => {
    vi.mocked(api.saveFrqMark).mockResolvedValue({ mark: mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } }) });
    await byQuestion(FRQ_DATA());
    const ana = within(bq()).getAllByTestId('frq-card')[0];
    fireEvent.click(within(ana).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('2 waiting for the agent')).toBeInTheDocument();
  });

  test('accepting a revised suggestion shows the new mark in the card', async () => {
    const before = mark({ state: 'accepted', final: { cells: { 146: 2 }, comment: 'Old mark' }, suggested: { cells: { 146: 4 }, comment: 'New suggestion' }, suggestion_revised: true });
    const data = FRQ_DATA();
    data.students = [{ ...data.students[0], responses: { ...data.students[0].responses, 21: frqResp('Ana 21', before) } }];
    vi.mocked(api.saveFrqMark).mockResolvedValue({ mark: { ...before, final: { cells: { 146: 4 }, comment: 'New suggestion' }, suggestion_revised: false, writeback: { status: 'pending' } } });
    await byQuestion(data);
    const card = within(bq()).getAllByTestId('frq-card')[0];
    expect(within(card).getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('Old mark');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => {
      const now = within(bq()).getAllByTestId('frq-card')[0];
      expect(within(now).getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('New suggestion');
    });
  });

  test('shows a load error', async () => {
    vi.mocked(api.getQuizAttempts).mockRejectedValue(new Error('No quiz group 7'));
    render(<MemoryRouter><AttemptsTab group={{ id: 7 }} courseId={5} reloadKey="" /></MemoryRouter>);
    expect(await screen.findByText('No quiz group 7')).toBeInTheDocument();
  });
});
