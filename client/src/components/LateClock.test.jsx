import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LateClock from './LateClock.jsx';

describe('LateClock', () => {
  it('is an outline clock by default, with the title for hover and screen readers', () => {
    render(<LateClock variant="corner" title="2 school days late" />);
    const clock = screen.getByRole('img', { name: '2 school days late' });
    expect(clock).toHaveClass('late-clock', 'late-clock--corner');
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock).toHaveAttribute('title', '2 school days late');
    expect(clock.querySelector('circle')).toHaveAttribute('fill', 'none');
  });

  it.each(['corner', 'badge'])('the %s variant is always the outline clock: the Late flag is a symbol, not a filled clock (#40)', (variant) => {
    render(<LateClock variant={variant} flagged title="ignored" />);
    const clock = screen.getByRole('img');
    expect(clock).toHaveClass(`late-clock--${variant}`);
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock.querySelector('circle')).toHaveAttribute('fill', 'none');
  });
});
