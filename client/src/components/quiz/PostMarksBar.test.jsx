import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostMarksBar from './PostMarksBar.jsx';
import { postFrqWritebacks } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ postFrqWritebacks: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('PostMarksBar', () => {
  it('publishes every accepted mark in one click and lists a line per student', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [
      { student_id: 1, name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null },
      { student_id: 2, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'Changed in Schoology since the last load' },
      { student_id: 3, name: 'Cy Ng', question: 22, level: null, status: 'skipped', error: 'Post this one by hand: Prism posts only a one-row Schoology rubric' },
    ], remaining: 1 });
    const onPosted = vi.fn();
    render(<PostMarksBar groupId={7} count={3} onPosted={onPosted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (3)' }));
    expect(await screen.findByText('Published: Ana Lee, Q21 Exhibiting')).toBeInTheDocument();
    expect(screen.getByText('Failed: Bo Wu, Q21: Changed in Schoology since the last load')).toBeInTheDocument();
    expect(screen.getByText('Skipped: Cy Ng, Q22: Post this one by hand: Prism posts only a one-row Schoology rubric')).toBeInTheDocument();
    expect(postFrqWritebacks).toHaveBeenCalledWith(7, null);
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/before posting the rest/)).toBeNull();
  });

  it('offers the button again for marks still waiting, and adds the new lines', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 2, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'x' }], remaining: 1 });
    render(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (1)' }));
    await screen.findByText('Failed: Bo Wu, Q21: x');
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 2, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (1)' }));
    expect(await screen.findByText('Published: Bo Wu, Q21 Exhibiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish all/ })).toBeNull();
  });

  it('after a publish, a mark accepted later shows in the count and the button returns', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 1, name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 0 });
    const { rerender } = render(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (1)' }));
    await screen.findByText('Published: Ana Lee, Q21 Exhibiting');
    expect(screen.queryByRole('button', { name: /Publish all/ })).toBeNull();
    rerender(<PostMarksBar groupId={7} count={0} onPosted={vi.fn()} />); // the tab reloads
    rerender(<PostMarksBar groupId={7} count={2} onPosted={vi.fn()} />); // the teacher accepts two more
    expect(screen.getByRole('button', { name: 'Publish all to Schoology (2)' })).toBeInTheDocument();
    expect(screen.getByText('Published: Ana Lee, Q21 Exhibiting')).toBeInTheDocument();
  });

  it('a count that returns to its value at publish time is still the current count', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 2, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'x' }], remaining: 1 });
    const { rerender } = render(<PostMarksBar groupId={7} count={3} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (3)' }));
    await screen.findByText('Failed: Bo Wu, Q21: x');
    rerender(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />); // the tab reloads
    rerender(<PostMarksBar groupId={7} count={3} onPosted={vi.fn()} />); // the teacher accepts two more
    expect(screen.getByRole('button', { name: 'Publish all to Schoology (3)' })).toBeInTheDocument();
  });

  it('until the tab reloads, the count is what the publish left waiting', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 2, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'x' }], remaining: 1 });
    render(<PostMarksBar groupId={7} count={3} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (3)' }));
    await screen.findByText('Failed: Bo Wu, Q21: x');
    expect(screen.getByRole('button', { name: 'Publish all to Schoology (1)' })).toBeInTheDocument();
  });

  it('warns that an open grade-by-question page in Schoology would undo the marks', () => {
    render(<PostMarksBar groupId={7} count={2} onPosted={vi.fn()} />);
    expect(screen.getByText('Close any grade-by-question page for this quiz in Schoology first: saving it later would undo these marks.')).toBeInTheDocument();
  });

  it('shows a refused publish (busy, expired session) as an alert', async () => {
    postFrqWritebacks.mockRejectedValueOnce(new Error('Schoology connection expired: reconnect in Settings'));
    render(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish all to Schoology (1)' }));
    expect(await screen.findByText('Schoology connection expired: reconnect in Settings')).toBeInTheDocument();
  });

  it('renders nothing with no marks to publish', () => {
    const { container } = render(<PostMarksBar groupId={7} count={0} onPosted={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
