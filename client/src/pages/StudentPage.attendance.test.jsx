import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

// #208: attendance this term beside Recent tasks, private. Masked fixtures.
const base = { id: 7, first_name: 'Ana', last_name: 'Lee', courses: [], grades: [], notes: [], flags: [], parents: [], counselors: [], grading_scales: {} };
const ATTENDANCE = [{
  course_id: 5, course_name: 'AP CSP', from: '2026-08-13', read_at: '2026-10-30T01:00:00Z', absences: 2, lates: 1, excused: 0,
  lessons: [
    { date: '2026-10-20', code: '', description: 'Present', kind: 'present', office: false },
    { date: '2026-10-22', code: 'A', description: 'Absence', kind: 'absent', office: false },
    { date: '2026-10-27', code: 'I', description: 'Illness', kind: 'absent', office: true },
    { date: '2026-10-29', code: 'T', description: 'Tardy', kind: 'late', office: false },
  ],
}];
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>
);

describe('StudentPage attendance (#208)', () => {
  it('with Private details on: each course\'s absences and lates, and its last lessons with PowerSchool\'s codes', async () => {
    getStudent.mockResolvedValue({ ...base, attendance: ATTENDANCE });
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Attendance this term' })).closest('section');
    expect(within(card).getByRole('link', { name: 'AP CSP' })).toHaveAttribute('href', '/course/5?tab=attendance');
    expect(card).toHaveTextContent('2 absences, 1 late');
    const cells = within(card).getAllByRole('listitem');
    expect(cells.map((c) => c.textContent)).toEqual(['20/10', 'A22/10', 'I27/10', 'T29/10']);
    expect(within(card).getByRole('img', { name: 'Tue 27/10: Illness (I), entered by the office' })).toHaveClass('attendance-strip__cell--absent');
    expect(within(card).getByRole('img', { name: 'Thu 29/10: Tardy (T)' })).toHaveClass('attendance-strip__cell--late');
    expect(within(card).getByRole('img', { name: 'Tue 20/10: Present' })).toHaveClass('attendance-strip__cell--present');
  });

  it('with Private details off, it is not in the page', async () => {
    setPrivateDetails(false);
    getStudent.mockResolvedValue({ ...base, attendance: ATTENDANCE });
    const { container } = renderPage();
    await screen.findByText('Ana Lee', { exact: false });
    expect(screen.queryByText('Attendance this term')).not.toBeInTheDocument();
    expect(container.querySelector('.attendance-strip')).toBeNull();
  });

  it('no course read yet: no card', async () => {
    getStudent.mockResolvedValue({ ...base, attendance: [] });
    renderPage();
    await screen.findByText('Ana Lee', { exact: false });
    expect(screen.queryByText('Attendance this term')).not.toBeInTheDocument();
  });
});
