import { describe, it, expect } from 'vitest';
import { flagClearedPatch, shownCommentStatus } from './cardPatches.js';
import { storedCommentStatus } from '../../../server/lib/commentStatus.js';

describe('shownCommentStatus (#183)', () => {
  it('Display stays on only with a comment', () => {
    expect(shownCommentStatus('Good', true)).toBe(1);
    expect(shownCommentStatus('Good', false)).toBeNull();
    expect(shownCommentStatus('', true)).toBeNull();
    expect(shownCommentStatus(null, true)).toBeNull();
  });

  it.each([['Good', true], ['Good', false], ['', true], ['', false], [null, true]])('matches the server for %j, %j', (comment, display) => {
    expect(shownCommentStatus(comment, display)).toBe(storedCommentStatus(comment, display));
  });
});

describe('flagClearedPatch', () => {
  it('nothing cleared: no patch', () => {
    expect(flagClearedPatch(null)).toEqual({});
  });

  it('the flag line removed: the comment and the line go', () => {
    expect(flagClearedPatch({ exception: 0, comment: 'Well done', status_line: null })).toEqual({ exception: 0, grade_comment: 'Well done', status_line: null });
  });

  it('a comment emptied by the line removal shows Display off, as Schoology keeps it (#183)', () => {
    expect(flagClearedPatch({ exception: 0, comment: '', status_line: null })).toEqual({ exception: 0, grade_comment: '', comment_status: null, status_line: null });
  });
});
