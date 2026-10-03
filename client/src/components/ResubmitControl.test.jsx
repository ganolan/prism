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
  it('an arrived resubmission offers Reviewed, and reports { reviewed: true } so the card can clear its own watermark', async () => {
    api.reviewResubmission.mockResolvedValue({ id: 9, outcome: 'reviewed' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'arrived', request: null })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(api.reviewResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30 }));
    expect(onChange).toHaveBeenCalledWith(null, { reviewed: true });
  });

  it('extending sends the current lessons and reports onChange with the returned request merged in', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, lessons: 5, until: '2026-10-19' });
    const onChange = vi.fn();
    const r = { state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15' } };
    render(<ResubmitControl student={student(r)} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(3, { lessons: 3 }));
    expect(onChange).toHaveBeenCalledWith({ ...r, request: { id: 3, lessons: 5, until: '2026-10-19' } });
  });

  it('Undo deletes the open request and reports onChange(null)', async () => {
    api.undoResubmission.mockResolvedValue({ deleted: true });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15' } })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    expect(undoBtn.className).toContain('btn-sm');
    fireEvent.click(undoBtn);
    await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(3));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows the error badge when the ask is rejected, and leaves the panel open', async () => {
    api.requestResubmission.mockRejectedValue(new Error('network down'));
    const onChange = vi.fn();
    render(<ResubmitControl student={student()} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // Still open — the note input survives so the teacher doesn't retype it.
    expect(screen.getByLabelText('Resubmission note')).toBeInTheDocument();
  });

  it('reopening the panel resets lessons to the request and clears a stale note', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, lessons: 7, until: '2026-10-22' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15' } })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    const pill = screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ });
    fireEvent.click(pill); // open
    fireEvent.change(screen.getByLabelText('Resubmission note'), { target: { value: 'left over' } });
    fireEvent.click(screen.getByLabelText('Decrease')); // lessons 3 -> 2
    expect(screen.getByLabelText('Resubmission note')).toHaveValue('left over');
    fireEvent.click(pill); // close
    fireEvent.click(pill); // reopen
    expect(screen.getByLabelText('Resubmission note')).toHaveValue('');
    expect(screen.getByDisplayValue('3')).toBeInTheDocument(); // back to the request's lessons, not the edited 2
  });

  it('does not render when assignmentId is missing', () => {
    render(<ResubmitControl student={student()} assignmentId={undefined} defaultLessons={3} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Ask to resubmit/ })).not.toBeInTheDocument();
  });
});
