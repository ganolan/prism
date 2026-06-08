import { describe, it, expect } from 'vitest';
import { categoryColor } from './rubricColors.js';

const PALETTE = { produce: '#B4A7D6', create: '#9FC5E8' };

describe('categoryColor', () => {
  it('matches a reporting-category title by contained keyword', () => {
    expect(categoryColor('HS Art: Produce', PALETTE)).toBe('#B4A7D6');
    expect(categoryColor('HS Art: Create, Respond, Connect', PALETTE)).toBe('#9FC5E8');
  });
  it('falls back to a neutral colour when nothing matches', () => {
    expect(categoryColor('Mathematics: Reasoning', PALETTE)).toBe('var(--bg-subtle)');
    expect(categoryColor(null, PALETTE)).toBe('var(--bg-subtle)');
  });
});
