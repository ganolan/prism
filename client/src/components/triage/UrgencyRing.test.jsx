import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UrgencyRing from './UrgencyRing.jsx';
import { APPROX_TITLE } from '../../lib/triage.js';

const CIRC = 2 * Math.PI * 15;
const arcLength = (container) =>
  Number(container.querySelector('.urgency-ring__arc').getAttribute('stroke-dasharray').split(' ')[0]);

describe('UrgencyRing', () => {
  it('is an img named "day <day>, limit day <limit>" with the day number inside', () => {
    const { container } = render(<UrgencyRing day={6} limit={8} tone="amber" />);
    const ring = screen.getByRole('img', { name: 'day 6, limit day 8' });
    expect(ring).toHaveClass('urgency-ring', 'urgency-ring--amber');
    expect(ring).toHaveTextContent('6');
    expect(container.querySelector('svg')).toHaveAttribute('width', '40');
  });

  it('arc is the fraction of the limit, clamped to a full ring past it', () => {
    const half = render(<UrgencyRing day={4} limit={8} tone="amber" />);
    expect(arcLength(half.container)).toBeCloseTo(CIRC / 2, 1);
    const over = render(<UrgencyRing day={16} limit={3} tone="red" />);
    expect(arcLength(over.container)).toBeCloseTo(CIRC, 1);
  });

  it('day 1 (the due date) still shows a small arc', () => {
    const { container } = render(<UrgencyRing day={1} limit={30} tone="green" />);
    const len = arcLength(container);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(CIRC * 0.1);
  });

  it('marks an approximate count with ≈ and the weekday tooltip', () => {
    render(<UrgencyRing day={5} limit={8} tone="amber" approx />);
    expect(screen.getByTitle(APPROX_TITLE)).toHaveTextContent('≈');
  });

  it('no ≈ for an exact count', () => {
    render(<UrgencyRing day={5} limit={8} tone="amber" />);
    expect(screen.queryByTitle(APPROX_TITLE)).not.toBeInTheDocument();
  });
});
