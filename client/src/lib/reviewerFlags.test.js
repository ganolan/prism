import { describe, it, expect } from 'vitest';
import { briefFlags, textSignature } from './reviewerFlags.js';

const FULL = [
  'Abstraction reassessed on request: EX confirmed. Why not D: he picked a real abstraction.',
  'Your question answered: the win rate is the optional Challenge, not a core requirement. The core parts are roll, sum and Yahtzee.',
  '[PENDING: watch] Code Analysis (video row) not scored by me. Your draft now has ED.',
  'Creativity suggested EX, which matches your draft.',
].join('\n');

describe('briefFlags', () => {
  it('prefers the agent-written brief lines', () => {
    expect(briefFlags(FULL, ['Abstraction: EX confirmed', 'Video not scored'])).toEqual({
      items: ['Abstraction: EX confirmed', 'Video not scored'], hasMore: true,
    });
  });

  it('otherwise takes the first sentence of each flag paragraph', () => {
    const { items, hasMore } = briefFlags(FULL, null);
    expect(items).toEqual([
      'Abstraction reassessed on request: EX confirmed.',
      'Your question answered: the win rate is the optional Challenge, not a core requirement.',
      '[PENDING: watch] Code Analysis (video row) not scored by me.',
      'Creativity suggested EX, which matches your draft.',
    ]);
    expect(hasMore).toBe(true);
  });

  it('hasMore is false when the brief already says everything', () => {
    expect(briefFlags('Check the CAD deliverable.', null)).toEqual({ items: ['Check the CAD deliverable.'], hasMore: false });
  });

  it('trims a very long first sentence with an ellipsis', () => {
    const long = `${'word '.repeat(60)}end. Next.`;
    const [item] = briefFlags(long, null).items;
    expect(item.length).toBeLessThanOrEqual(141);
    expect(item.endsWith('…')).toBe(true);
  });

  it('skips blank lines and handles no flags', () => {
    expect(briefFlags('A one.\n\n  \nB two.', null).items).toEqual(['A one.', 'B two.']);
    expect(briefFlags('', null)).toEqual({ items: [], hasMore: false });
    expect(briefFlags(null, [])).toEqual({ items: [], hasMore: false });
  });
});

describe('textSignature', () => {
  it('is stable for equal text and differs for revised text', () => {
    expect(textSignature('Nice work, Tyler.')).toBe(textSignature('Nice work, Tyler.'));
    expect(textSignature('Nice work, Tyler.')).not.toBe(textSignature('Nice work, Tyler!'));
    expect(textSignature('')).toBe(textSignature(''));
  });
});
