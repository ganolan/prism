import { describe, test, expect } from 'vitest';
import { getRubricConfig } from './featureGate.js';
import { categoryColor } from '../../client/src/lib/rubricColors.js';

describe('getRubricConfig', () => {
  test('returns suggestion accent + reporting-category colours from config.yaml', () => {
    const cfg = getRubricConfig();
    expect(cfg.suggestionAccent).toBe('#e21ad6');
    expect(cfg.suggestionWash).toBe('#fbe6fb');
    expect(cfg.reportingCategoryColors.produc).toBe('#B4A7D6');
    expect(cfg.reportingCategoryColors.creat).toBe('#9FC5E8');
  });

  // Every reporting-category spelling in prod (aligned topics and rubric files, 13 Oct 2026)
  // gets its rubric-style colour, so aligned rubrics and feedback rows look the same.
  test('the configured palette colours every category spelling Prism holds', () => {
    const palette = getRubricConfig().reportingCategoryColors;
    const expected = {
      'HS Art: Producing': '#B4A7D6', PRODUCE: '#B4A7D6', Produce: '#B4A7D6',
      'HS Art: Creating, Responding, Connecting': '#9FC5E8', 'CREATE, RESPOND, CONNECT': '#9FC5E8', 'Create, Respond, Connect': '#9FC5E8',
      'AP CS: Computational Thinking Practices': '#F9CB9C',
      'AP CS: Content Knowledge': '#D5A6BD',
    };
    for (const [title, color] of Object.entries(expected)) expect([title, categoryColor(title, palette)]).toEqual([title, color]);
  });
});
