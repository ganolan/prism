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

  it.each(['corner', 'badge'])('the %s variant has a filled flagged form', (variant) => {
    render(<LateClock variant={variant} flagged title="Marked late with Flags" />);
    const clock = screen.getByRole('img', { name: 'Marked late with Flags' });
    expect(clock).toHaveClass(`late-clock--${variant}`, 'late-clock--flagged');
    expect(clock.querySelector('circle')).toHaveAttribute('fill', 'currentColor');
  });
});
