import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToolsPage from './ToolsPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getCourses: vi.fn(),
  getEmails: vi.fn(),
  getRandomStudents: vi.fn(),
  getGroups: vi.fn(),
  getRoster: vi.fn(),
}));

const ROSTER = [
  { id: 1, first_name: 'Alexander', last_name: 'Chen', preferred_name: 'Al', preferred_name_teacher: 'Alex' },
  { id: 2, first_name: 'Zoe', last_name: 'Adams', preferred_name: null, preferred_name_teacher: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getCourses.mockResolvedValue([
    { id: 7, course_name: 'AP CSP', student_count: 2, excluded: 0, hidden: 0 },
  ]);
  api.getRoster.mockResolvedValue({ students: ROSTER, count: 2 });
});

// The class-list card only appears once a course is selected, like the other tools.
async function selectCourseAndGenerate(user) {
  render(<ToolsPage />);
  const courseBox = await screen.findByRole('checkbox', { name: /AP CSP/ });
  await user.click(courseBox);
  const card = screen.getByTestId('class-list-tool');
  await user.click(within(card).getByRole('button', { name: /generate/i }));
  return card;
}

describe('Class List tool', () => {
  it('generates one name per line, surname-sorted, in First Last by default', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);

    const output = await within(card).findByRole('textbox');
    expect(output).toHaveValue('Zoe Adams\nAlex Chen');
    expect(api.getRoster).toHaveBeenCalledWith([7]);
  });

  it('reformats the list when the format changes, without refetching the roster', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.selectOptions(within(card).getByLabelText(/format/i), 'last-first');

    expect(within(card).getByRole('textbox')).toHaveValue('Adams, Zoe\nChen, Alex');
    expect(api.getRoster).toHaveBeenCalledTimes(1);
  });

  it('switches to a single comma-separated line', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.selectOptions(within(card).getByLabelText(/separate/i), 'comma');

    expect(within(card).getByRole('textbox')).toHaveValue('Zoe Adams, Alex Chen');
  });

  it('sorts by first name when asked', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.selectOptions(within(card).getByLabelText(/sort/i), 'first');

    expect(within(card).getByRole('textbox')).toHaveValue('Alex Chen\nZoe Adams');
  });

  it('copies the rendered list to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    // After setup(): userEvent installs its own clipboard stub, and jsdom exposes
    // navigator.clipboard through a getter, so this has to be defineProperty.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.click(within(card).getByRole('button', { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith('Zoe Adams\nAlex Chen');
    await waitFor(() => expect(within(card).getByRole('button', { name: /copied/i })).toBeInTheDocument());
  });

  it('clears a generated list when the course selection changes', async () => {
    const user = userEvent.setup();
    api.getCourses.mockResolvedValue([
      { id: 7, course_name: 'AP CSP', student_count: 2, excluded: 0, hidden: 0 },
      { id: 8, course_name: 'Mobile App Dev', student_count: 3, excluded: 0, hidden: 0 },
    ]);
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.click(screen.getByRole('checkbox', { name: /Mobile App Dev/ }));

    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('reports an empty roster instead of showing a blank box', async () => {
    api.getRoster.mockResolvedValue({ students: [], count: 0 });
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);

    expect(await within(card).findByText(/no students/i)).toBeInTheDocument();
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
  });
});
