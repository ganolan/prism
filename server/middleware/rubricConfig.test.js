import { describe, test, expect } from 'vitest';
import { getRubricConfig } from './featureGate.js';

describe('getRubricConfig', () => {
  test('returns suggestion accent + reporting-category colours from config.yaml', () => {
    const cfg = getRubricConfig();
    expect(cfg.suggestionAccent).toBe('#e21ad6');
    expect(cfg.suggestionWash).toBe('#fbe6fb');
    expect(cfg.reportingCategoryColors.produce).toBe('#B4A7D6');
    expect(cfg.reportingCategoryColors.create).toBe('#9FC5E8');
  });
});
