import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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

describe('StudentPage PowerSchool alerts (#117)', () => {
  // The page may be projected in a parent conference: nothing about the alerts
  // shows until the teacher clicks, and the reveal is not remembered.
  const ALERTS = [
    { key: 'learning_support_2', label: 'Learning support 2', category: 'learning' },
    { key: 'allergies', label: 'Allergies', category: 'health' },
    { key: 'divorced', label: 'Divorced/separated', category: 'family', title: 'Guardians divorced or separated' },
  ];

  it('shows only "Show alerts (N)" until clicked: no labels, categories or read date', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    const { container } = renderPage();
    const btn = await screen.findByRole('button', { name: 'Show alerts (3)' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    for (const t of ['Learning support 2', 'Allergies', 'Divorced/separated', 'from PowerSchool']) {
      expect(screen.queryByText(new RegExp(t))).not.toBeInTheDocument();
    }
    expect(container.querySelector('.ps-alerts, .badge-pink, [title*="divorced"]')).toBeNull();
  });

  it('a click reveals every alert, family ones included, with the read date; Hide alerts hides them again', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show alerts (3)' }));
    expect(screen.getByText('Learning support 2')).toHaveClass('badge-blue');
    expect(screen.getByText('Allergies')).toHaveClass('badge-amber');
    expect(screen.getByText('Divorced/separated')).toHaveClass('badge-pink');
    expect(screen.getByText('from PowerSchool, read 16/10/2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide alerts' }));
    expect(screen.queryByText('Allergies')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show alerts (3)' })).toBeInTheDocument();
  });

  it('is hidden again on the next page load (the reveal is not remembered)', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    const first = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show alerts (3)' }));
    expect(screen.getByText('Allergies')).toBeInTheDocument();
    first.unmount();
    renderPage();
    expect(await screen.findByRole('button', { name: 'Show alerts (3)' })).toBeInTheDocument();
    expect(screen.queryByText('Allergies')).not.toBeInTheDocument();
  });

  it('shows nothing when there are none, or the feature is off', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: [], ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    renderPage();
    await screen.findByRole('heading', { name: /Ana Lee/ });
    expect(screen.queryByRole('button', { name: /Show alerts/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/from PowerSchool/)).not.toBeInTheDocument();
  });
});
