import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

beforeEach(() => {
  vi.clearAllMocks();
  api.getCourses.mockResolvedValue([
    { id: 7, course_name: 'AP CSP', student_count: 2, excluded: 0, hidden: 0 },
  ]);
  api.getEmails.mockResolvedValue({
    formatted: 'Jane Doe <jane@example.com>; John Roe <john@example.com>',
    addresses: ['jane@example.com', 'john@example.com'],
    count: 2,
  });
});

async function selectCourseAndGenerate(user) {
  render(<ToolsPage />);
  await user.click(await screen.findByRole('checkbox', { name: /AP CSP/ }));
  const card = screen.getByTestId('email-tool');
  await user.click(within(card).getByRole('button', { name: /generate/i }));
  return card;
}

describe('Email List tool', () => {
  it('defaults to the named, semicolon-separated Outlook list', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);

    expect(await within(card).findByRole('textbox'))
      .toHaveValue('Jane Doe <jane@example.com>; John Roe <john@example.com>');
  });

  it('switches to bare comma-separated emails without refetching', async () => {
    const user = userEvent.setup();
    const card = await selectCourseAndGenerate(user);
    await within(card).findByRole('textbox');

    await user.selectOptions(within(card).getByLabelText(/format/i), 'bare');

    expect(within(card).getByRole('textbox')).toHaveValue('jane@example.com, john@example.com');
    expect(api.getEmails).toHaveBeenCalledTimes(1);
  });
});
