// Private details across Prism (#197): with the sidebar switch off, the student page and the assessment
// page leave every private part out of the page (hidden means not rendered) and show the shared box. The
// student page's grades and feedback are not private (Graham, 27 Oct 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setPrivateDetails } from '../lib/privateDetails.js';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
// Every call waits (a page that reads is still loading), unless a test answers it.
vi.mock('../services/api.js', async (importOriginal) => {
  const real = await importOriginal();
  return Object.fromEntries(Object.keys(real).map((k) => [k, vi.fn(() => new Promise(() => {}))]));
});

import * as api from '../services/api.js';
import StudentPage from './StudentPage.jsx';
import AssessmentSummaryPage from './AssessmentSummaryPage.jsx';

const STUDENT = {
  id: 7, first_name: 'Ana', last_name: 'Lee', email: '27007@hkis.edu.hk', grad_year: 2027, courses: [{ id: 3, course_name: 'Robotics' }],
  grades: [], notes: [{ id: 1, content: 'Left early for the dentist', created_at: '2026-10-01' }], flags: [],
  parents: [{ id: 1, first_name: 'Mei', last_name: 'Lee', email: 'mei@example.com' }], grading_scales: {},
  ps_alerts: [{ key: 'allergies', label: 'Allergies', category: 'health' }], ps_alerts_synced_at: '2026-10-16T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrivateDetails(false);
});

describe('Student page with Private details off', () => {
  const renderPage = () => render(
    <MemoryRouter initialEntries={['/student/7']}>
      <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
    </MemoryRouter>,
  );

  it('shows who the student is, the grades, and the box; alerts, contacts and notes are not in the page', async () => {
    api.getStudent.mockResolvedValue(STUDENT);
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { name: /Ana Lee/ })).toBeInTheDocument();
    expect(screen.getByText('27007@hkis.edu.hk')).toBeInTheDocument();
    expect(screen.getByText('Alerts, family contacts and notes are private.')).toBeInTheDocument();
    expect(screen.getByText('No grades yet.')).toBeInTheDocument(); // grades and feedback are not private (27 Oct 2026)
    for (const t of [/Show alerts/, /Family Contacts/, /mei@example\.com/, /Left early/, /^Notes$/]) {
      expect(screen.queryByText(t)).not.toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/Mei|dentist|Allergies/);

    act(() => setPrivateDetails(true));
    expect(screen.getByText('Family Contacts')).toBeInTheDocument();
    expect(screen.getByText('Left early for the dentist')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show alerts (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Alerts, family contacts and notes are private.')).not.toBeInTheDocument();
  });
});

describe('Assessment page with Private details off', () => {
  it('reads nothing and shows only the way back and the box', async () => {
    render(
      <MemoryRouter initialEntries={['/course/5/assessment/9']}>
        <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("This assessment's grades, comments and submissions are private.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to course' })).toHaveAttribute('href', '/course/5');
    expect(api.getMasteryForAssignment).not.toHaveBeenCalled();
    act(() => setPrivateDetails(true));
    expect(api.getMasteryForAssignment).toHaveBeenCalled();
    expect(screen.queryByText("This assessment's grades, comments and submissions are private.")).not.toBeInTheDocument();
  });
});
