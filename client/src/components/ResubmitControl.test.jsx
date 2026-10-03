import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ResubmitControl from './ResubmitControl.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  requestResubmission: vi.fn(), updateResubmission: vi.fn(), reviewResubmission: vi.fn(), undoResubmission: vi.fn(),
}));
const student = (resubmission = null) => ({ id: 7, schoology_uid: 'u7', resubmission });
beforeEach(() => vi.clearAllMocks());

describe('ResubmitControl', () => {
  it('asks with the default lessons and a note', async () => {
    api.requestResubmission.mockResolvedValue({ id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student()} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.change(screen.getByLabelText('Resubmission note'), { target: { value: 'add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(api.requestResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: 'add tests' }));
    expect(onChange).toHaveBeenCalledWith({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked' } });
  });
  it('an open request shows "Resubmit by DD/MM/YYYY" with Extend / Close / Undo', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, lessons: 5, until: '2026-10-19' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15' } })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close request' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(3, { close: true, note: '' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it('an arrived resubmission offers Reviewed', async () => {
    api.reviewResubmission.mockResolvedValue({ id: 9, outcome: 'reviewed' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'arrived', request: null })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(api.reviewResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30 }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
