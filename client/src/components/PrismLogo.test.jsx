import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrismLogo from './PrismLogo.jsx';

describe('PrismLogo', () => {
  it('is announced as "Prism", not as a picture of letters', () => {
    render(<PrismLogo />);
    expect(screen.getByRole('img', { name: 'Prism' })).toBeTruthy();
  });

  it('draws the three beams, blue, teal and violet, each outside and through the glass', () => {
    const { container } = render(<PrismLogo />);
    const beams = [...container.querySelectorAll('[data-beam]')];
    expect(beams.map((b) => b.dataset.beam)).toEqual(['blue', 'teal', 'violet']);
    for (const b of beams) expect(b.querySelectorAll('path')).toHaveLength(2);
  });

  // Theme-aware: colours come from CSS variables, never hard-coded hex.
  it('takes every colour from CSS variables', () => {
    const { container } = render(<PrismLogo />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(container.innerHTML).toMatch(/var\(--logo-text\)/);
  });

  // Two logos on one page must not share gradient ids, or one would
  // silently borrow the other's.
  it('gives each instance its own gradient id', () => {
    const { container } = render(
      <>
        <PrismLogo />
        <PrismLogo />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
