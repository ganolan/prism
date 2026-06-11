import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchPage from './SearchPage.jsx';

vi.mock('../services/api.js', () => ({
  searchStudents: vi.fn().mockResolvedValue([
    { id: 1, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027 },
    { id: 2, first_name: 'Bo', last_name: 'Ng', email: 'bo@hkis.edu.hk', grad_year: 2025 },
  ]),
}));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-01-15')); });
afterEach(() => { vi.useRealTimers(); });

describe('SearchPage grade column', () => {
  it('shows the derived grade for an active student and a dash for a graduated one', async () => {
    render(<MemoryRouter><SearchPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Ana Lee')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toBeInTheDocument();
    expect(screen.getByText('Grade 11')).toBeInTheDocument(); // Ana, grad_year 2027
    expect(screen.getByText('—')).toBeInTheDocument();        // Bo, grad_year 2025 (graduated)
  });
});
