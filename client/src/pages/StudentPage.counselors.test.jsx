import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// #190: the student's counselors. Masked fixtures: no real names or emails.
const base = { id: 7, first_name: 'Ana', last_name: 'Lee', courses: [], grades: [], notes: [], flags: [], parents: [], grading_scales: {} };
const COUNSELORS = [
  { id: '71', first_name: 'Counselor', last_name: 'One', primary: true, email: 'one@example.test' },
  { id: '72', first_name: 'Counselor', last_name: 'Two', primary: false, email: null },
];
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>
);

let clipboard;
beforeEach(() => {
  clipboard = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

describe('StudentPage counselors (#190)', () => {
  it('heads the section Counselors, marks the primary one Primary, and copies the emails it has', async () => {
    getStudent.mockResolvedValue({ ...base, counselors: COUNSELORS });
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { name: 'Counselors' })).toBeInTheDocument();
    expect(screen.getByText('Counselor One').closest('p')).toHaveTextContent('Primary');
    expect(screen.getByText('Counselor Two').closest('p')).not.toHaveTextContent('Primary');
    expect(container.textContent).not.toMatch(/assigned/i);
    expect(container.querySelector('a[href="mailto:one@example.test"]')).not.toBeNull();
    expect(screen.getByText('Email not found in Schoology')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy emails' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('Counselor One <one@example.test>'));
  });

  it('shows with Private details off: counselors are public', async () => {
    setPrivateDetails(false);
    getStudent.mockResolvedValue({ ...base, counselors: COUNSELORS });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Counselors' })).toBeInTheDocument();
    expect(screen.getByText('Counselor One')).toBeInTheDocument();
  });

  it('no counselors read yet: no section', async () => {
    getStudent.mockResolvedValue({ ...base, counselors: [] });
    renderPage();
    await screen.findByText('Ana Lee', { exact: false });
    expect(screen.queryByRole('heading', { name: 'Counselors' })).not.toBeInTheDocument();
  });
});
