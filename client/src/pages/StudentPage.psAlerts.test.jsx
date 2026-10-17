import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParentPhone: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
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
  it('shows the alerts under the name, with when PowerSchool was read', async () => {
    getStudent.mockResolvedValue({
      ...base,
      ps_alerts: [{ key: 'learning_support_2', label: 'Learning support 2', category: 'learning' }, { key: 'allergies', label: 'Allergies', category: 'health' }],
      ps_alerts_synced_at: '2026-10-16T08:00:00.000Z',
    });
    renderPage();
    expect(await screen.findByText('Learning support 2')).toHaveClass('badge-blue');
    expect(screen.getByText('Allergies')).toHaveClass('badge-amber');
    expect(screen.getByText('from PowerSchool, read 16/10/2026')).toBeInTheDocument();
  });

  it('shows nothing when there are none, or the feature is off', async () => {
    getStudent.mockResolvedValue({ ...base, ps_alerts: [], ps_alerts_synced_at: '2026-10-16T08:00:00.000Z' });
    renderPage();
    await screen.findByRole('heading', { name: /Ana Lee/ });
    expect(screen.queryByLabelText('PowerSchool alerts')).not.toBeInTheDocument();
    expect(screen.queryByText(/from PowerSchool/)).not.toBeInTheDocument();
  });
});
