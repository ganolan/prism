import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AiSparkle from './AiSparkle.jsx';

describe('AiSparkle', () => {
  it('renders an svg sized by the size prop with currentColor fill', () => {
    const { container } = render(<AiSparkle size={17} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('17');
    expect(container.querySelectorAll('path')).toHaveLength(3);
    expect(container.querySelector('path').getAttribute('fill')).toBe('currentColor');
  });
});
