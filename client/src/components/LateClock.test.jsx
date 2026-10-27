import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LateClock from './LateClock.jsx';

describe('LateClock', () => {
  it('is an outline clock by default, named for screen readers, with how late in an instant popover (#199)', () => {
    render(<LateClock variant="corner" text="2 school days late" />);
    const clock = screen.getByRole('img', { name: '2 school days late' });
    expect(clock).toHaveClass('late-clock', 'late-clock--corner');
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock).not.toHaveAttribute('title');
    expect(clock.querySelector('circle')).toHaveAttribute('fill', 'none');
    fireEvent.mouseEnter(clock);
    expect(document.querySelector('.help-pop')).toHaveTextContent('2 school days late');
  });

  it('a passive clock (inside a gradebook cell, whose hover says how late) has no popover of its own', () => {
    render(<LateClock variant="corner" text="2 school days late" passive />);
    const clock = screen.getByRole('img', { name: '2 school days late' });
    fireEvent.mouseEnter(clock);
    expect(document.querySelector('.help-pop')).toBeNull();
  });

  it.each(['corner', 'badge'])('the %s variant is always the outline clock: the Late flag is a symbol, not a filled clock (#40)', (variant) => {
    render(<LateClock variant={variant} flagged text="ignored" />);
    const clock = screen.getByRole('img');
    expect(clock).toHaveClass(`late-clock--${variant}`);
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock.querySelector('circle')).toHaveAttribute('fill', 'none');
  });
});
