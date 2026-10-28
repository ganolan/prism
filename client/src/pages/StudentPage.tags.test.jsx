// The gender tag beside the name in the student page header (27 Oct 2026): moved here from the Roster tab's
// cards, which keep only the Gender filter and sort. Private details only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setPrivateDetails } from '../lib/privateDetails.js';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParent: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
}));

import { getStudent } from '../services/api.js';
import StudentPage from './StudentPage.jsx';

const base = { id: 7, first_name: 'Ana', last_name: 'Lee', courses: [], grades: [], notes: [], flags: [], parents: [], grading_scales: {} };
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>
);
const nameRow = async () => (await screen.findByRole('heading', { name: /Ana Lee/ })).closest('.student-name-row');

beforeEach(() => {
  localStorage.clear();
  setPrivateDetails(true);
});

describe('StudentPage gender tag', () => {
  it.each([['F', 'F', 'Female'], ['M', 'M', 'Male'], ['X', 'NB', 'Recorded in PowerSchool as "X"'], [null, '?', 'Not recorded in PowerSchool']])(
    'gender %s reads %s right after the name, named %s',
    async (gender, code, label) => {
      getStudent.mockResolvedValue({ ...base, gender });
      renderPage();
      const row = await nameRow();
      const tag = within(row).getByRole('img', { name: label });
      expect(tag).toHaveTextContent(new RegExp(`^${code.replace('?', '\\?')}$`));
      expect(row.querySelector('h2').nextElementSibling).toBe(tag.closest('.student-tags'));
    },
  );

  it('shows its full label in an instant popover on hover, focus and tap, not a native title', async () => {
    getStudent.mockResolvedValue({ ...base, gender: 'X' });
    renderPage();
    const tag = within(await nameRow()).getByRole('img', { name: 'Recorded in PowerSchool as "X"' });
    expect(tag).toHaveAttribute('tabindex', '0');
    expect(tag).not.toHaveAttribute('title');
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.mouseEnter(tag);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
    fireEvent.mouseLeave(tag);
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.focus(tag);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
    fireEvent.blur(tag);
    fireEvent.click(tag); // a phone has no hover
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
  });

  it('with Private details off the tag is not in the page; turning it on draws it, off removes it', async () => {
    setPrivateDetails(false);
    getStudent.mockResolvedValue({ ...base, gender: 'F' });
    const { container } = renderPage();
    await nameRow();
    expect(container.querySelector('.student-tags, .student-tag')).toBeNull();
    expect(container.querySelector('[aria-label="Female"]')).toBeNull();
    act(() => setPrivateDetails(true));
    expect(screen.getByRole('img', { name: 'Female' })).toHaveTextContent(/^F$/);
    act(() => setPrivateDetails(false));
    expect(container.querySelector('.student-tags, .student-tag')).toBeNull();
  });

  // #191: the age (private, first), the public birthday mark, and the Demographics lines (private).
  it('the age comes first with its date of birth in the popover; home room and guardianship show; all private', async () => {
    getStudent.mockResolvedValue({ ...base, gender: 'F', age: 16, date_of_birth: '2010-06-15', birthday_today: false, home_room: 'Teacher, Sam', guardianship: 'Court order' });
    const { container } = renderPage();
    const row = await nameRow();
    const tags = [...row.querySelectorAll('.student-tag')].map((t) => t.textContent);
    expect(tags).toEqual(['16', 'F']);
    expect(within(row).getByRole('img', { name: 'Age 16, born 15/06/2010' })).toBeInTheDocument();
    expect(screen.getByText('Home room: Teacher, Sam')).toBeInTheDocument();
    expect(screen.getByText('Guardianship: Court order')).toBeInTheDocument();
    act(() => setPrivateDetails(false));
    expect(container.querySelector('.student-tag')).toBeNull();
    expect(container).not.toHaveTextContent(/Teacher, Sam|Court order|15\/06\/2010/);
  });

  it('the birthday mark is public: shown with Private details off, beside the name, with no age or date', async () => {
    setPrivateDetails(false);
    getStudent.mockResolvedValue({ ...base, age: 16, date_of_birth: '2010-10-28', birthday_today: true });
    const { container } = renderPage();
    const row = await nameRow();
    expect(within(row).getByRole('img', { name: 'Birthday today' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/16|28\/10/);
  });
});


// #185: one line under the name, as on the roster card: grade, student number, Email copy. With
// Private details off too.
describe('StudentPage header line', () => {
  const YEAR = new Date().getMonth() >= 7 ? new Date().getFullYear() + 2 : new Date().getFullYear() + 1; // a Grade 11

  it.each([[true], [false]])('reads grade, number and Email under the name (Private details %s)', async (on) => {
    setPrivateDetails(on);
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    getStudent.mockResolvedValue({ ...base, grad_year: YEAR, email: '27007@hkis.edu.hk' });
    renderPage();
    await nameRow();
    const line = document.querySelector('.student-meta');
    expect([...line.children].map((c) => c.textContent)).toEqual(['Grade 11', '27007', 'Email']);
    expect(screen.queryByText(/^ID:/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href="mailto:27007@hkis.edu.hk"]')).toBeNull();
    await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Copy email 27007@hkis.edu.hk' })); });
    expect(writeText).toHaveBeenCalledWith('27007@hkis.edu.hk');
  });

  it('a past student reads their class year', async () => {
    getStudent.mockResolvedValue({ ...base, grad_year: 2020, email: '20001@hkis.edu.hk' });
    renderPage();
    await nameRow();
    expect(document.querySelector('.student-meta').firstElementChild).toHaveTextContent('Class of 2020');
  });
});
