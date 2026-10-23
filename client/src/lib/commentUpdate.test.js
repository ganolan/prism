import { describe, it, expect } from 'vitest';
import { addUpdateLine } from './commentUpdate.js';

const P = 'Update (23/10/2026): ';
const STATUS = 'Resubmission received 20/10 - regraded.';

describe('addUpdateLine', () => {
  it('puts the update above the comment', () => {
    expect(addUpdateLine('Good work.', null, '23/10/2026')).toEqual({ text: `${P}\n\nGood work.`, cursor: 21 });
  });

  it('goes below a status line', () => {
    const r = addUpdateLine(`${STATUS}\n\nGood work.`, STATUS, '23/10/2026');
    expect(r.text).toBe(`${STATUS}\n\n${P}\n\nGood work.`);
    expect(r.text.split('\n')[0]).toBe(STATUS);
    expect(r.text.split('\n')[2]).toBe(P);
    expect(r.cursor).toBe(STATUS.length + 2 + 21);
  });

  it('a comment that is only the status line', () => {
    const r = addUpdateLine(STATUS, STATUS, '23/10/2026');
    expect(r.text).toBe(`${STATUS}\n\n${P}`);
    expect(r.cursor).toBe(r.text.length);
  });

  it('empty comment gives null', () => {
    expect(addUpdateLine('', null, '23/10/2026')).toBeNull();
    expect(addUpdateLine('  \n ', null, '23/10/2026')).toBeNull();
  });

  it('a second press the same day adds nothing', () => {
    const once = addUpdateLine('Good work.', null, '23/10/2026');
    const twice = addUpdateLine(once.text, null, '23/10/2026');
    expect(twice.text).toBe(once.text);
    expect(twice.cursor).toBe(21);
    // with text already typed after the colon, the cursor goes to the end of that line
    const typed = `${P}Appeal heard.\n\nGood work.`;
    expect(addUpdateLine(typed, null, '23/10/2026')).toEqual({ text: typed, cursor: `${P}Appeal heard.`.length });
  });

  it('a different day adds a new line above the earlier one', () => {
    const r = addUpdateLine(`${P}Heard.\n\nGood work.`, null, '24/10/2026');
    expect(r.text).toBe(`Update (24/10/2026): \n\n${P}Heard.\n\nGood work.`);
  });
});
