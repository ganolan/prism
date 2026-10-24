import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToolsPage from './ToolsPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getCourses: vi.fn(),
  getEmails: vi.fn(),
  getRandomStudents: vi.fn(),
  getGroups: vi.fn(),
  getRoster: vi.fn(),
  getToolFilters: vi.fn(),
}));

const FACETS = {
  gender: [{ value: 'F', count: 2 }, { value: 'M', count: 1 }, { value: 'none', count: 1 }],
  grade: [{ value: '9', count: 3 }, { value: '12', count: 1 }],
  level: [{ value: 'ED', count: 1 }, { value: 'EX', count: 2 }, { value: 'none', count: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCourses.mockResolvedValue([
    { id: 7, course_name: 'AP CSP', student_count: 3, excluded: 0, hidden: 0, archived: 0 },
    { id: 8, course_name: 'Robotics', student_count: 2, excluded: 0, hidden: 0, archived: 0 },
    { id: 20, course_name: 'Mobile Games', student_count: 18, excluded: 0, hidden: 0, archived: 1, grading_period: 'HS 25-26 Semester 1' },
    { id: 21, course_name: 'AI & ML', student_count: 0, excluded: 0, hidden: 0, archived: 1, grading_period: 'HS 25-26' },
  ]);
  api.getToolFilters.mockImplementation((ids, q) => Promise.resolve({ total: 4, matched: q ? 2 : 4, facets: FACETS }));
  api.getRoster.mockResolvedValue({ students: [{ id: 1, first_name: 'Zoe', last_name: 'Adams' }], count: 1 });
});

describe('Class Tools: past courses (#73)', () => {
  it('lists past courses with students under a closed toggle; Select all leaves them out', async () => {
    const user = userEvent.setup();
    render(<ToolsPage />);
    await screen.findByRole('checkbox', { name: /AP CSP/ });
    expect(screen.queryByRole('checkbox', { name: /Mobile Games/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: /Past courses \(1\)/ }); // the empty one is not listed
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const past = screen.getByRole('checkbox', { name: /Mobile Games/ });
    expect(within(screen.getByTestId('past-year')).getByText('2025-26')).toBeInTheDocument();

    await user.click(past);
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('checkbox', { name: /AP CSP/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Robotics/ })).toBeChecked();
    expect(past).toBeChecked(); // kept: Select all adds the current courses
    expect(toggle).toHaveTextContent('1 selected');
    await waitFor(() => expect(api.getToolFilters).toHaveBeenLastCalledWith([20, 7, 8], ''));
  });
});

describe('Class Tools: roster filters (#73)', () => {
  async function openFilters(user) {
    render(<ToolsPage />);
    await user.click(await screen.findByRole('checkbox', { name: /AP CSP/ }));
    const card = screen.getByTestId('roster-filters');
    expect(await within(card).findByText('4 students')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Filter students/ }));
    return card;
  }

  it('is closed by default and lists each value with its count', async () => {
    const user = userEvent.setup();
    render(<ToolsPage />);
    await user.click(await screen.findByRole('checkbox', { name: /AP CSP/ }));
    const card = screen.getByTestId('roster-filters');
    await within(card).findByText('4 students');
    expect(within(card).queryByRole('button', { name: /Female/ })).toBeNull();
    await user.click(within(card).getByRole('button', { name: /Filter students/ }));
    const gender = within(card).getByRole('group', { name: 'Gender' });
    expect(within(gender).getAllByRole('button').map((b) => b.textContent)).toEqual(['Female (2)', 'Male (1)', 'Not known (1)']);
    const level = within(card).getByRole('group', { name: 'Overall proficiency' });
    expect(within(level).getByRole('button', { name: 'EX (2)' })).toHaveAttribute('title', 'Exhibiting');
    expect(within(card).getByRole('group', { name: 'Grade' })).toHaveTextContent('Grade 12 (1)');
  });

  it('a chosen value narrows every tool and states how many students remain', async () => {
    const user = userEvent.setup();
    const card = await openFilters(user);
    const female = within(card).getByRole('button', { name: 'Female (2)' });
    await user.click(female);
    expect(female).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(card).getByRole('button', { name: 'Grade 9 (3)' }));
    expect(await within(card).findByText('Showing 2 of 4 students')).toBeInTheDocument();
    expect(api.getToolFilters).toHaveBeenLastCalledWith([7], 'gender=F&grade=9');

    await user.click(within(screen.getByTestId('class-list-tool')).getByRole('button', { name: /generate/i }));
    expect(api.getRoster).toHaveBeenLastCalledWith([7], 'gender=F&grade=9');

    await user.click(within(card).getByRole('button', { name: 'Clear filters' }));
    expect(await within(card).findByText('4 students')).toBeInTheDocument();
  });

  it('a list made before a filter changed is cleared', async () => {
    const user = userEvent.setup();
    const card = await openFilters(user);
    const tool = screen.getByTestId('class-list-tool');
    await user.click(within(tool).getByRole('button', { name: /generate/i }));
    expect(await within(tool).findByRole('textbox')).toHaveValue('Zoe Adams');
    await user.click(within(card).getByRole('button', { name: 'Male (1)' }));
    await waitFor(() => expect(within(tool).queryByRole('textbox')).toBeNull());
  });
});
