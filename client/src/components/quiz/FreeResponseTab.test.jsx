import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FreeResponseTab, { matchesFilter } from './FreeResponseTab.jsx';
import { getFrqResponses, getFeatures, saveFrqMark, postFrqWritebacks } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getFrqResponses: vi.fn(), getFeatures: vi.fn(), saveFrqMark: vi.fn(), postFrqWritebacks: vi.fn() }));

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [{ points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
const mark = (over) => ({ state: 'suggested', suggested: { cells: { 146: 4 }, comment: 's' }, final: null, suggestion_revised: false, writeback: { status: null }, changed_in_schoology: false, ...over });
const DATA = {
  group_id: 7,
  questions: [{ id: 1, position: 21, stem_html: '<p>Q21 stem</p>', max_points: 4, rubric: RUBRIC }, { id: 2, position: 22, stem_html: '<p>Q22 stem</p>', max_points: 4, rubric: RUBRIC }],
  students: [
    { student_id: 1, name: 'Ana Lee', attempt_id: 11, attempt_url: 'u1', responses: { 21: { answer_html: 'Ana 21', schoology: null, mark: mark() }, 22: { answer_html: 'Ana 22', schoology: null, mark: null } } },
    { student_id: 2, name: 'Ben Ho', attempt_id: 12, attempt_url: 'u2', responses: { 21: { answer_html: 'Ben 21', schoology: null, mark: mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } }) }, 22: { answer_html: 'Ben 22', schoology: { cells: { 146: 2 }, comment: 'c' }, mark: null } } },
  ],
};

beforeEach(() => { vi.clearAllMocks(); getFrqResponses.mockResolvedValue(DATA); getFeatures.mockResolvedValue({ quizzes: true, quiz_writeback: false }); });

describe('FreeResponseTab', () => {
  it('opens by question: the first FRQ for every student', async () => {
    render(<FreeResponseTab groupId={7} />);
    expect(await screen.findByText('Ana 21')).toBeInTheDocument();
    expect(screen.getByText('Ben 21')).toBeInTheDocument();
    expect(screen.queryByText('Ana 22')).toBeNull();
    expect(screen.getByText('Q21 stem')).toBeInTheDocument();
  });

  it('the picker sets the FRQ for every card', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    fireEvent.change(screen.getByRole('combobox', { name: 'Question' }), { target: { value: '22' } });
    expect(screen.getByText('Ana 22')).toBeInTheDocument();
    expect(screen.queryByText('Ana 21')).toBeNull();
  });

  it('by student stacks each student\'s FRQs', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    fireEvent.click(screen.getByRole('tab', { name: 'By student' }));
    // #194: By question and By student are the Free response tab's child row.
    expect(screen.getByRole('tab', { name: 'By student' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tablist', { name: 'View' })).toHaveClass('subtab-row');
    expect(screen.getByText('Ana 21')).toBeInTheDocument();
    expect(screen.getByText('Ana 22')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Question' })).toBeNull();
  });

  it('filters, and shows how many marks wait for the agent', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    expect(screen.getByText('1 waiting for the agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Waiting to post/ }));
    expect(screen.queryByText('Ana 21')).toBeNull();
    expect(screen.getByText('Ben 21')).toBeInTheDocument();
  });

  it('with quiz_writeback on, the post bar replaces "waiting for the agent" and reloads after posting', async () => {
    getFeatures.mockResolvedValue({ quizzes: true, quiz_writeback: true });
    postFrqWritebacks.mockResolvedValue({ results: [{ student_id: 2, name: 'Ben Ho', question: 21, level: 'Exhibiting Depth', status: 'posted', error: null }], remaining: 0 });
    render(<FreeResponseTab groupId={7} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish all to Schoology (1)' }));
    expect(screen.queryByText('1 waiting for the agent')).toBeNull();
    expect(await screen.findByText('Published: Ben Ho, Q21 Exhibiting Depth')).toBeInTheDocument();
    expect(getFrqResponses).toHaveBeenCalledTimes(2);
  });

  it('the post count leaves out marks on a rubric with more than one row', async () => {
    getFeatures.mockResolvedValue({ quizzes: true, quiz_writeback: true });
    const two = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147' }] };
    const data = { ...DATA, questions: [DATA.questions[0], { ...DATA.questions[1], rubric: two }],
      students: [DATA.students[0], { ...DATA.students[1], responses: { ...DATA.students[1].responses, 22: { answer_html: 'Ben 22', schoology: null, mark: mark({ state: 'edited', final: { cells: { 146: 4, 147: 4 }, comment: 'c' }, writeback: { status: 'pending' } }) } } }] };
    getFrqResponses.mockResolvedValue(data);
    render(<FreeResponseTab groupId={7} />);
    expect(await screen.findByRole('button', { name: 'Publish all to Schoology (1)' })).toBeInTheDocument();
  });

  it('a saved card updates in place', async () => {
    saveFrqMark.mockResolvedValue({ mark: mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } }) });
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    const ana = screen.getAllByTestId('frq-card')[0];
    fireEvent.click(within(ana).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('2 waiting for the agent')).toBeInTheDocument();
  });

  it('accepting a revised suggestion shows the new mark in the card', async () => {
    const before = mark({ state: 'accepted', final: { cells: { 146: 2 }, comment: 'Old mark' }, suggested: { cells: { 146: 4 }, comment: 'New suggestion' }, suggestion_revised: true });
    getFrqResponses.mockResolvedValue({ ...DATA, students: [{ ...DATA.students[0], responses: { ...DATA.students[0].responses, 21: { answer_html: 'Ana 21', schoology: null, mark: before } } }] });
    saveFrqMark.mockResolvedValue({ mark: { ...before, final: { cells: { 146: 4 }, comment: 'New suggestion' }, suggestion_revised: false, writeback: { status: 'pending' } } });
    render(<FreeResponseTab groupId={7} />);
    const card = (await screen.findAllByTestId('frq-card'))[0];
    expect(within(card).getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('Old mark');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    const updated = await screen.findByDisplayValue('New suggestion');
    expect(updated).toHaveAccessibleName('Comment for Ana Lee');
    expect(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Revised suggestion')).toBeNull();
  });

  it('shows a load error', async () => {
    getFrqResponses.mockRejectedValue(new Error('No quiz group 7'));
    render(<FreeResponseTab groupId={7} />);
    expect(await screen.findByText('No quiz group 7')).toBeInTheDocument();
  });
});

describe('matchesFilter', () => {
  it('to review: unmarked with nothing in Schoology, a suggestion not yet acted on, or a revised one', () => {
    expect(matchesFilter({ schoology: null, mark: null }, 'review')).toBe(true);
    expect(matchesFilter({ schoology: { cells: {}, comment: 'x' }, mark: null }, 'review')).toBe(false);
    expect(matchesFilter({ mark: mark() }, 'review')).toBe(true);
    expect(matchesFilter({ mark: mark({ state: 'edited', suggestion_revised: true }) }, 'review')).toBe(true);
  });
});
