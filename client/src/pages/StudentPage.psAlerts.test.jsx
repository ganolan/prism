import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParent: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getAlertDetail: vi.fn(),
}));

import { getStudent, getAlertDetail } from '../services/api.js';
import { setPrivateDetails } from '../lib/privateDetails.js';
import StudentPage from './StudentPage.jsx';

const base = { id: 7, first_name: 'Ana', last_name: 'Lee', courses: [], grades: [], notes: [], flags: [], parents: [], grading_scales: {} };
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>
);

// #185, option A (Graham, 28 Oct 2026): with Private details on, learning, health and other alerts are
// chips in place, each opening its PowerSchool detail; family alerts stay behind Show family alerts,
// never remembered. With the switch off nothing about the alerts is in the page (privateDetailsPages.test.jsx).
describe('StudentPage PowerSchool alerts (#117, #185)', () => {
  const ALERTS = [
    { key: 'learning_support_2', label: 'Learning support 2', category: 'learning' },
    { key: 'allergies', label: 'Allergies', category: 'health' },
    { key: 'divorced', label: 'Divorced/separated', category: 'family', title: 'Guardians divorced or separated' },
  ];

  it('shows learning, health and other alerts as chips in place, with the read date; no family alert', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    const { container } = renderPage();
    expect(await screen.findByRole('button', { name: 'Learning support 2' })).toHaveClass('badge-blue');
    expect(screen.getByRole('button', { name: 'Allergies' })).toHaveClass('badge-amber');
    expect(screen.getByText('From PowerSchool, read 16/10/2026')).toBeInTheDocument();
    expect(screen.queryByText('Divorced/separated')).not.toBeInTheDocument();
    expect(container.querySelector('.badge-pink')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show family alerts (1)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a chip opens its detail read live from PowerSchool, in place; a second tap or Close shuts it', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    getAlertDetail.mockResolvedValue({
      alertKey: 'learning_support_2', kind: 'rows', readAt: '2026-10-28T02:44:00.000Z',
      rows: [{ category: 'Case Manager', description: 'A teacher' }, { category: 'Support Notes', description: 'Quiet room for tests.' }],
    });
    renderPage();
    const chip = await screen.findByRole('button', { name: 'Learning support 2' });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(getAlertDetail).toHaveBeenCalledWith(7, 'learning_support_2');
    expect(await screen.findByText('Quiet room for tests.')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Case Manager' })).toBeInTheDocument();
    expect(screen.getByText(/^From PowerSchool, read 28\/10\/2026/)).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByText('Quiet room for tests.')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(await screen.findByText('Quiet room for tests.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Quiet room for tests.')).not.toBeInTheDocument();
  });

  it('a failed read says why', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS });
    getAlertDetail.mockRejectedValue(new Error('PowerSchool did not answer'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Allergies' }));
    expect(await screen.findByText('Could not read this alert: PowerSchool did not answer')).toBeInTheDocument();
  });

  it('Show family alerts reveals the family ones; Hide family alerts hides them; the next load starts hidden', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    const first = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show family alerts (1)' }));
    expect(screen.getByText('Divorced/separated')).toHaveClass('badge-pink');
    fireEvent.click(screen.getByRole('button', { name: 'Hide family alerts' }));
    expect(screen.queryByText('Divorced/separated')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show family alerts (1)' }));
    first.unmount();
    renderPage();
    expect(await screen.findByRole('button', { name: 'Show family alerts (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Divorced/separated')).not.toBeInTheDocument();
  });

  it('turning Private details off takes every alert out of the page', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: ALERTS, ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    const { container } = renderPage();
    await screen.findByRole('button', { name: 'Allergies' });
    act(() => setPrivateDetails(false));
    expect(container.textContent).not.toMatch(/Allergies|Learning support|family alerts|from PowerSchool/i);
    act(() => setPrivateDetails(true));
  });

  it('shows nothing when there are none, or the feature is off', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: [], ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    renderPage();
    await screen.findByRole('heading', { name: /Ana Lee/ });
    expect(screen.queryByRole('button', { name: /family alerts/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/from PowerSchool/i)).not.toBeInTheDocument();
  });
});
