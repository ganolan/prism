import { test, expect } from 'vitest';
import { suggestExtraTime } from './extraTime.js';

test.each([
  ['Extended time (25%) on tests and quizzes.', 25],
  ['Please allow 25% extra time for in-class assessments', 25],
  ['50 % additional time on assessments', 50],
  ['Time and a half on assessments. Breaks as needed.', 50],
  ['Double time for exams', null],
  ['See case manager for assessment arrangements.', null],
  ['Seat near the front (25% of lessons)', null],
  ['', null],
  // The percentage must share a sentence with the word "time".
  ['Seat near the front (25% of lessons). Extra time on tests.', null],
  ['Breaks as needed. 10% extra time for exams.', 10],
  ['Sits tests alone.\nExtra time: 30%', 30],
  // Whole numbers; whole words only; anything the store would refuse is no suggestion.
  ['12.5% extra time', 13],
  ['Sometimes needs 25% more help', null],
  ['300% extra time', null],
  ['0% extra time', null],
  [null, null],
  [undefined, null],
])('suggestExtraTime(%j) is %j', (text, want) => expect(suggestExtraTime(text)).toBe(want));
