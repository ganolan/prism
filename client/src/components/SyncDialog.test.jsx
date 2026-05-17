import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.mocked(api.getCourses).mockResolvedValue([
    { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  ]);
  vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
});

describe('SyncDialog', () => {
  it('loads courses and shows the config step', async () => {
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Step 1 · Schoology/)).toBeInTheDocument());
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
  });

  it('switches to the progress overlay when Start sync is clicked', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 5 });
      onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 });
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText(/Sync complete/)).toBeInTheDocument());
  });
});
