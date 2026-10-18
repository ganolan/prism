import { describe, test, expect } from 'vitest';
import { parseSupportSummary, SUPPORT_SUMMARY_HTML } from './parseSupportSummary.js';

describe('parseSupportSummary', () => {
  test('reads each Category / Description row, in order, as text', () => {
    expect(parseSupportSummary(SUPPORT_SUMMARY_HTML)).toEqual([
      { category: 'Academic Support', description: 'Y' },
      { category: 'SEL/Behavioral Support', description: 'Tier 2' },
      { category: 'Case Manager', description: '-' },
      { category: 'Accommodation Plan', description: 'Yes' },
      { category: 'TLI', description: 'No' },
      { category: 'Intervention Plan', description: '-' },
      { category: 'ILP', description: '-' },
      { category: 'Support Plan URL', description: 'Open plan', url: 'https://example.org/plan' },
      { category: 'Support Notes', description: '25% extra time on tests & quizzes; seat near the front.' },
    ]);
  });

  test('entities decoded, tags and extra space dropped, the header row skipped', () => {
    const html = '<table><tr><th>Category</th><th>Description</th></tr><tr><td><b>A&amp;B</b></td><td> x <br> y </td></tr></table>';
    expect(parseSupportSummary(html)).toEqual([{ category: 'A&B', description: 'x y' }]);
  });

  test('no table (an empty pop-up) → []', () => {
    expect(parseSupportSummary('<p style="margin-left:10px">\n</p>')).toEqual([]);
  });
});
