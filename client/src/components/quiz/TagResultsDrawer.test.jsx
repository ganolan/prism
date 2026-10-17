import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import TagResultsDrawer from './TagResultsDrawer.jsx';
import { getTagResults } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getTagResults: vi.fn() }));

const RESULTS = {
  course_id: 3, tag: 'CRD-2.G', text: 'Describe the purpose of a code segment.',
  overall: { correct: 4, total: 8, percent: 50 },
  tests: [
    { group_id: 7, title: 'Ep 1 Theory Test', date: '2026-09-20', takers: 3, correct: 3, total: 6, percent: 50,
      questions: [{ position: 1, correct: 2, total: 3, percent: 67 }, { position: 3, correct: 1, total: 3, percent: 33 }] },
    { group_id: 9, title: 'Ep 2 Theory Test', date: '2026-10-10', takers: 2, correct: 1, total: 2, percent: 50,
      questions: [{ position: 5, correct: 1, total: 2, percent: 50 }] },
    { group_id: 11, title: 'Ep 3 Theory Test', date: null, takers: 0, correct: 0, total: 0, percent: null,
      questions: [{ position: 2, correct: 0, total: 0, percent: null }] },
  ],
  students: [
    { student_id: 2, name: 'Ben Lee', correct: 0, total: 3, percent: 0, tests: { 7: { correct: 0, total: 2 }, 9: { correct: 0, total: 1 } } },
    { student_id: 3, name: 'Cy Lee', correct: 1, total: 2, percent: 50, tests: { 7: { correct: 1, total: 2 } } },
    { student_id: 1, name: 'Ana Lee', correct: 3, total: 3, percent: 100, tests: { 7: { correct: 2, total: 2 }, 9: { correct: 1, total: 1 } } },
  ],
  courseTags: ['CRD-2.G', 'AAP-1.A'],
};

beforeEach(() => { vi.clearAllMocks(); getTagResults.mockResolvedValue(RESULTS); });

describe('TagResultsDrawer', () => {
  it('is a dialog named for the tag, with its text and the course total', async () => {
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'CRD-2.G across the course' });
    expect(getTagResults).toHaveBeenCalledWith(3, 'CRD-2.G');
    expect(await within(dialog).findByText('Describe the purpose of a code segment.')).toBeInTheDocument();
    expect(within(dialog).getByText('4/8 correct (50%) on 4 MCQs in 3 tests')).toBeInTheDocument();
  });

  it('lists each test in date order with its date, questions and percent; the open quiz is marked', async () => {
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'By test' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(r => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Ep 1 Theory Test (this quiz)', 'Ep 2 Theory Test', 'Ep 3 Theory Test']);
    expect(within(rows[0]).getByText('20/09/2026')).toBeInTheDocument();
    expect(within(rows[0]).getAllByRole('cell')[3]).toHaveTextContent('Q1 67%, Q3 33%');
    expect(within(rows[0]).getByText('3/6')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('img', { name: '50% correct' })).toBeInTheDocument();
    expect(within(rows[2]).getByText('Not loaded')).toBeInTheDocument();
  });

  it('lists each student lowest first, per test and in total; a test not sat shows a hyphen', async () => {
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'By student' });
    const head = within(table).getAllByRole('columnheader');
    expect(head.map(h => h.textContent)).toEqual(['Student', '1', '2', '3', 'Total', '%']);
    expect(head[1]).toHaveAttribute('title', 'Ep 1 Theory Test');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(r => within(r).getAllByRole('cell').map(c => c.textContent))).toEqual([
      ['Ben Lee', '0/2', '0/1', '-', '0/3', '0%'],
      ['Cy Lee', '1/2', '-', '-', '1/2', '50%'],
      ['Ana Lee', '2/2', '1/1', '-', '3/3', '100%'],
    ]);
    expect(screen.getByRole('img', { name: /MCQ scores of 3 students/ })).toBeInTheDocument();
  });

  it('switches to another tag in the course', async () => {
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    const picker = await screen.findByRole('combobox', { name: 'Tag' });
    fireEvent.change(picker, { target: { value: 'AAP-1.A' } });
    await waitFor(() => expect(getTagResults).toHaveBeenLastCalledWith(3, 'AAP-1.A'));
    expect(screen.getByRole('dialog', { name: 'AAP-1.A across the course' })).toBeInTheDocument();
  });

  it('closes with the Close button, Escape and the backdrop, not a click inside', async () => {
    const onClose = vi.fn();
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('table', { name: 'By test' });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.tag-drawer__backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('moves focus into the drawer on open', async () => {
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('says so when no MCQ in the course carries the tag', async () => {
    getTagResults.mockResolvedValue({ ...RESULTS, text: null, tests: [], students: [], overall: { correct: 0, total: 0, percent: null }, courseTags: [] });
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    expect(await screen.findByText('No MCQ in this course carries this tag. Tags on free-response questions are not counted.')).toBeInTheDocument();
  });

  it('shows a failed load', async () => {
    getTagResults.mockRejectedValue(new Error('Quiz request failed'));
    render(<TagResultsDrawer courseId={3} tag="CRD-2.G" groupId={7} onClose={() => {}} />);
    expect(await screen.findByText('Quiz request failed')).toBeInTheDocument();
  });
});
