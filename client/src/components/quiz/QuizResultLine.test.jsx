import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuizResultLine, { quizLineText } from './QuizResultLine.jsx';

const BASE = { mcq: { correct: 17, total: 20, percent: 85 }, frq: [
  { question: 21, has_rubric: true, confirmed: true, levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }], points: 3, max_points: 4 },
], overall: null };

describe('quizLineText', () => {
  it('MCQ and confirmed FRQ', () => {
    expect(quizLineText(BASE)).toBe('MCQ 17/20 (85%), FRQ Q21: Exhibiting');
  });
  it('an unconfirmed FRQ shows its reason; several rows and no rubric', () => {
    expect(quizLineText({ mcq: null, frq: [
      { question: 21, has_rubric: true, confirmed: false, reason: 'to review', levels: [] },
      { question: 22, has_rubric: true, confirmed: true, levels: [{ level: 'Exhibiting' }, { level: 'Developing' }] },
      { question: 23, has_rubric: false, confirmed: true, levels: [{ level: null, points: 3 }], points: 3, max_points: 4 },
    ] })).toBe('FRQ Q21: to review, Q22: Exhibiting / Developing, Q23: 3/4');
  });
});

describe('QuizResultLine', () => {
  it('shows the line, and no button while the comment is current', () => {
    render(<QuizResultLine result={{ ...BASE, overall: { stale: false } }} onRebuild={vi.fn()} />);
    expect(screen.getByText('MCQ 17/20 (85%), FRQ Q21: Exhibiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update numbers' })).not.toBeInTheDocument();
  });

  it('a stale comment shows "Numbers changed" and Update numbers calls onRebuild', async () => {
    const onRebuild = vi.fn().mockResolvedValue();
    render(<QuizResultLine result={{ ...BASE, overall: { stale: true } }} onRebuild={onRebuild} />);
    expect(screen.getByText('Numbers changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update numbers' }));
    await waitFor(() => expect(onRebuild).toHaveBeenCalledTimes(1));
  });

  it('shows a refused update as an error', async () => {
    render(<QuizResultLine result={{ ...BASE, overall: { stale: true } }} onRebuild={vi.fn().mockRejectedValue(new Error('Not ready: Q21 to review'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update numbers' }));
    expect(await screen.findByText('Not ready: Q21 to review')).toBeInTheDocument();
  });

  it('renders nothing without a result', () => {
    const { container } = render(<QuizResultLine result={null} />);
    expect(container.innerHTML).toBe('');
  });
});
