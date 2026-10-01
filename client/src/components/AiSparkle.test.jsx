import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AiSparkle from './AiSparkle.jsx';

describe('AiSparkle', () => {
  it('renders a single four-point star sized by the size prop, in currentColor', () => {
    const { container } = render(<AiSparkle size={17} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('17');
    expect(container.querySelectorAll('path')).toHaveLength(1);
    const path = container.querySelector('path');
    expect(path.getAttribute('fill')).toBe('currentColor');
  });

  it('rounds the tips with a round-joined stroke in the same colour', () => {
    const { container } = render(<AiSparkle />);
    const path = container.querySelector('path');
    expect(path.getAttribute('stroke')).toBe('currentColor');
    expect(path.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('is decorative: hidden from assistive tech', () => {
    const { container } = render(<AiSparkle />);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });
});
