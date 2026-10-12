import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import QuestionsTab from './QuestionsTab.jsx';
import { getQuizStats, setQuizTags } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getQuizStats: vi.fn(), setQuizTags: vi.fn() }));

const STATS = {
  takers: 18, classSize: 19,
  byMember: [{ schoology_assignment_id: '900', title: 'Ep 1', takers: 16 }, { schoology_assignment_id: '901', title: 'Ep 1 *', takers: 2 }],
  mcq: { count: 20, median_percent: 80 },
  frq: { count: 1, levels: [{ name: 'Exhibiting', count: 8 }, { name: 'Developing', count: 5 }] },
  byTag: [{ tag: 'CRD-2.G', positions: [4], correct: 10, total: 18, percent: 56 }],
  questions: [
    { position: 1, kind: 'mcq', stem_html: '<p>Easy one</p>', tags: [], total: 18, correct: 18, facility: 1, band: 'Strong', blank: 0,
      options: [{ letter: 'A', html: 'a', count: 18, is_key: true }, { letter: 'B', html: 'b', count: 0, is_key: false }], flags: [{ level: 'note', text: 'Nobody missed it.' }] },
    { position: 4, kind: 'mcq', stem_html: '<p>Hard one</p>', tags: ['CRD-2.G'], total: 18, correct: 10, facility: 0.556, band: 'Divided', blank: 0,
      options: [{ letter: 'A', html: 'a', count: 2, is_key: false }, { letter: 'B', html: 'b', count: 10, is_key: true }, { letter: 'C', html: 'c', count: 6, is_key: false }], flags: [] },
    { position: 21, kind: 'frq', stem_html: '<p>Explain</p>', tags: [], total: 18, correct: null, facility: null, band: null, blank: 0, options: [], flags: [] },
  ],
};

beforeEach(() => { vi.clearAllMocks(); getQuizStats.mockResolvedValue(STATS); });

describe('QuestionsTab', () => {
  it('shows takers, the MCQ median, the tag rollup and FRQ levels', async () => {
    render(<QuestionsTab groupId={7} />);
    expect(await screen.findByText(/Takers 18 of 19/)).toBeInTheDocument();
    expect(screen.getByText(/MCQ median 80%/)).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'By tag' })).getByText('56%')).toBeInTheDocument();
    expect(screen.getByText(/Exhibiting 8, Developing 5/)).toBeInTheDocument();
  });

  it('lists questions by number; "Lowest first" sorts MCQs by facility', async () => {
    render(<QuestionsTab groupId={7} />);
    const rows = await screen.findAllByTestId('question-row');
    expect(rows.map(r => r.dataset.position)).toEqual(['1', '4', '21']);
    fireEvent.click(screen.getByRole('button', { name: 'Lowest first' }));
    expect(screen.getAllByTestId('question-row').map(r => r.dataset.position)).toEqual(['4', '1', '21']);
  });

  it('shows option counts with the key marked, and flags', async () => {
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[1];
    expect(within(row).getByText('B 10 ✓')).toBeInTheDocument();
    expect(within(row).getByText('Divided')).toBeInTheDocument();
    expect(within((await screen.findAllByTestId('question-row'))[0]).getByText('Nobody missed it.')).toBeInTheDocument();
  });

  it('edits tags', async () => {
    setQuizTags.mockResolvedValue({ updated: 1, unknownPositions: [] });
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Edit tags' }));
    const input = within(row).getByRole('textbox', { name: 'Tags for question 1' });
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.change(input, { target: { value: 'AAP-1.A, AAP-1.B' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(setQuizTags).toHaveBeenCalledWith(7, { 1: ['AAP-1.A', 'AAP-1.B'] }));
    await waitFor(() => expect(within(row).queryByRole('textbox', { name: 'Tags for question 1' })).toBeNull());
    await waitFor(() => expect(getQuizStats).toHaveBeenCalledTimes(2));
  });

  it('starts the tag editor from the current tags, not an earlier draft', async () => {
    const { rerender } = render(<QuestionsTab groupId={7} reloadKey={0} />);
    await screen.findAllByTestId('question-row');
    // Tags change elsewhere; the reload brings them in before the editor is opened.
    getQuizStats.mockResolvedValue({ ...STATS, questions: [{ ...STATS.questions[0], tags: ['CRD-9.Z'] }, ...STATS.questions.slice(1)] });
    rerender(<QuestionsTab groupId={7} reloadKey={1} />);
    const row = await waitFor(() => {
      const r = screen.getAllByTestId('question-row')[0];
      expect(within(r).getByText('CRD-9.Z')).toBeInTheDocument();
      return r;
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Edit tags' }));
    expect(within(row).getByRole('textbox', { name: 'Tags for question 1' })).toHaveValue('CRD-9.Z');
  });

  it('expands a row to show the stem and option HTML', async () => {
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[1];
    const toggle = within(row).getByRole('button', { name: 'Q4' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(row.querySelector('p').textContent).toBe('Hard one');
    expect(within(row).getByText('b')).toBeInTheDocument();
    expect(within(row).getByText('c')).toBeInTheDocument();
  });

  it('keeps the editor open and shows an alert when saving tags fails', async () => {
    setQuizTags.mockRejectedValue(new Error('Schoology is unreachable'));
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Edit tags' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save tags' }));
    expect(await within(row).findByText('Schoology is unreachable')).toBeInTheDocument();
    expect(within(row).getByRole('textbox', { name: 'Tags for question 1' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Save tags' })).toBeInTheDocument();
    expect(getQuizStats).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no results are loaded', async () => {
    getQuizStats.mockResolvedValue({ ...STATS, takers: 0, questions: [] });
    render(<QuestionsTab groupId={7} />);
    expect(await screen.findByText('No results loaded yet. Use Load results above.')).toBeInTheDocument();
  });

  it('clears a failed load once a later load succeeds', async () => {
    getQuizStats.mockRejectedValueOnce(new Error('Session expired'));
    const { rerender } = render(<QuestionsTab groupId={7} reloadKey={0} />);
    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    rerender(<QuestionsTab groupId={7} reloadKey={1} />);
    expect(await screen.findByText(/Takers 18 of 19/)).toBeInTheDocument();
    expect(screen.queryByText('Session expired')).toBeNull();
  });

  it('does not show the previous group while a new group loads', async () => {
    const { rerender } = render(<QuestionsTab groupId={7} />);
    await screen.findByText(/Takers 18 of 19/);
    let resolveNext;
    getQuizStats.mockReturnValueOnce(new Promise((r) => { resolveNext = r; }));
    rerender(<QuestionsTab groupId={8} />);
    expect(screen.queryByText(/Takers 18 of 19/)).toBeNull();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    resolveNext({ ...STATS, takers: 3, classSize: 4 });
    expect(await screen.findByText(/Takers 3 of 4/)).toBeInTheDocument();
  });

  it('omits the median from the By type row when there is no MCQ median', async () => {
    getQuizStats.mockResolvedValue({ ...STATS, mcq: { count: 20, median_percent: null } });
    render(<QuestionsTab groupId={7} />);
    const table = await screen.findByRole('table', { name: 'By type' });
    expect(within(table).getByText('MCQ (20)')).toBeInTheDocument();
    expect(within(table).queryByText(/median/)).toBeNull();
  });
});
