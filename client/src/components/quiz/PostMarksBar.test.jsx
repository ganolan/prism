import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostMarksBar from './PostMarksBar.jsx';
import { postFrqWritebacks } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ postFrqWritebacks: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('PostMarksBar', () => {
  it('posts one first, shows its result, then offers the rest', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 1, name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 2 });
    const onPosted = vi.fn();
    render(<PostMarksBar groupId={7} count={3} onPosted={onPosted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post accepted to Schoology (3)' }));
    expect(await screen.findByText('Posted: Ana Lee, Q21 Exhibiting')).toBeInTheDocument();
    expect(postFrqWritebacks).toHaveBeenCalledWith(7, 1);
    expect(screen.getByText(/Check it in Schoology/)).toBeInTheDocument();
    postFrqWritebacks.mockResolvedValueOnce({ results: [
      { student_id: 2, name: 'Ana Ng', question: 21, level: 'Developing', status: 'posted', error: null },
      { student_id: 3, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'Changed in Schoology since the last load' },
    ], remaining: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Post the other 2' }));
    expect(await screen.findByText('Failed: Bo Wu, Q21: Changed in Schoology since the last load')).toBeInTheDocument();
    expect(postFrqWritebacks).toHaveBeenLastCalledWith(7, null);
    expect(onPosted).toHaveBeenCalledTimes(2);
  });

  it('shows a refused post (busy, expired session) as an alert', async () => {
    postFrqWritebacks.mockRejectedValueOnce(new Error('Schoology connection expired: reconnect in Settings'));
    render(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post accepted to Schoology (1)' }));
    expect(await screen.findByText('Schoology connection expired: reconnect in Settings')).toBeInTheDocument();
  });

  it('renders nothing with no marks to post', () => {
    const { container } = render(<PostMarksBar groupId={7} count={0} onPosted={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
