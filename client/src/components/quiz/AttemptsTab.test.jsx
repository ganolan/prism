import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AttemptsTab from './AttemptsTab.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getQuizAttempts: vi.fn(), getMasteryForAssignment: vi.fn(), getFeedbackForAssignment: vi.fn(),
  getFeatures: vi.fn(), rebuildQuizOverall: vi.fn(), sendAllGrades: vi.fn(), saveFrqMark: vi.fn(), postFrqWritebacks: vi.fn(),
}));
// The grade card has its own tests: here a stub that shows which task it draws and registers for Publish all.
vi.mock('../gradeCard/StudentRubricCard.jsx', async () => {
  const { useEffect } = await import('react');
  return {
    default: function CardStub({ student, assignmentId, assignmentRow, feedbackRow, quizResult, onRebuildQuiz, registerCard, unregisterCard, onPendingChange }) {
      useEffect(() => {
        registerCard(student.schoology_uid, { getEntry: () => ({ entry: { uid: student.schoology_uid, assignmentId }, patch: {} }), applyResult: () => {} });
        onPendingChange(student.schoology_uid, 'publish');
        return () => unregisterCard(student.schoology_uid);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <div data-testid="test-card" data-assignment={assignmentId} data-is-test={assignmentRow?.is_test} data-quiz-line={quizResult ? 'shown' : 'none'}>
          {feedbackRow?.feedback_parsed?.narrative_feedback}
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

function renderTab(data = DATA()) {
  vi.mocked(api.getQuizAttempts).mockResolvedValue(data);
  return render(<MemoryRouter><AttemptsTab group={{ id: 7 }} courseId={5} reloadKey="" /></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.getMasteryForAssignment).mockImplementation(async (_c, sid) => mastery(sid));
  vi.mocked(api.getFeedbackForAssignment).mockImplementation(async (sid) => (sid === '900'
    ? { 1: { feedback_parsed: { narrative_feedback: 'Multiple choice: 13/20 (65%)' } } } : {}));
  vi.mocked(api.getFeatures).mockResolvedValue({ quiz_writeback: true });
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

  test('students who did not take it are listed under Not taken', async () => {
    renderTab();
    await screen.findByRole('region', { name: "Ana Lee's attempt" });
    expect(screen.getByText('Not taken (1): Ana Wu')).toBeInTheDocument();
  });
});
