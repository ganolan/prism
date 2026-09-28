import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScaleLevelPicker, { paletteKeyFor } from './ScaleLevelPicker.jsx';

const COMPLETION = {
  name: 'Completion Scale',
  levels: [{ code: 'C', label: 'Completed', points: 100 }, { code: 'I', label: 'Incomplete', points: 0 }],
};
const ATL = {
  name: 'Approaches to Learning',
  levels: [
    { code: 'C', label: 'Consistent', points: 100 },
    { code: 'I', label: 'Inconsistent', points: 60 },
    { code: 'S', label: 'Seldom', points: 0 },
  ],
};
const GAS = {
  name: 'General Academic Scale (Unaligned)',
  levels: ['ED', 'EX', 'D', 'EM', 'IE'].map((code, i) => ({ code, label: code, points: 100 - i * 25, descriptor: `about ${code}` })),
};

describe('ScaleLevelPicker', () => {
  it('renders levels best → worst, left to right', () => {
    render(<ScaleLevelPicker scale={ATL} onSelect={() => {}} />);
    const labels = screen.getAllByRole('button').map(b => b.querySelector('strong').textContent);
    expect(labels).toEqual(['Consistent', 'Inconsistent', 'Seldom']);
  });

  it('marks the synced level pressed, and a pending level over it', () => {
    const { rerender } = render(<ScaleLevelPicker scale={COMPLETION} syncedCode="I" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /incomplete/i })).toHaveAttribute('aria-pressed', 'true');
    rerender(<ScaleLevelPicker scale={COMPLETION} syncedCode="I" pendingCode="C" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /^completed/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /incomplete/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the clicked level', () => {
    const onSelect = vi.fn();
    render(<ScaleLevelPicker scale={COMPLETION} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /incomplete/i }));
    expect(onSelect).toHaveBeenCalledWith('I');
  });

  it('shows descriptor text when the scale has it', () => {
    render(<ScaleLevelPicker scale={GAS} onSelect={() => {}} />);
    expect(screen.getByText('about EX')).toBeInTheDocument();
  });

  it('marks an agent-suggested level so it reads apart from the teacher\'s own marks', () => {
    render(<ScaleLevelPicker scale={COMPLETION} suggestedCode="C" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /completed.*suggested/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /incomplete/i })).not.toHaveAccessibleName(/suggested/i);
  });

  it('is inert while locked', () => {
    const onSelect = vi.fn();
    render(<ScaleLevelPicker scale={COMPLETION} locked onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /incomplete/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('paletteKeyFor', () => {
  it('GAS codes keep their own rubric colour', () => {
    expect(GAS.levels.map((_, i) => paletteKeyFor(GAS, i))).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  });
  it('other scales map by rank: best green, middle yellow, worst red', () => {
    expect(COMPLETION.levels.map((_, i) => paletteKeyFor(COMPLETION, i))).toEqual(['EX', 'IE']);
    expect(ATL.levels.map((_, i) => paletteKeyFor(ATL, i))).toEqual(['EX', 'D', 'IE']);
  });
});
