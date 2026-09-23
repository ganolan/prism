import { describe, it, expect } from 'vitest';
import { shouldInstallBrowsers } from './postinstall.js';

describe('shouldInstallBrowsers', () => {
  it('installs by default — a fresh clone needs chromium for mastery sync', () => {
    expect(shouldInstallBrowsers({})).toBe(true);
  });

  it('skips when PRISM_SKIP_BROWSERS is set to something meant as true', () => {
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '1' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'true' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'yes' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: ' TRUE ' })).toBe(false);
  });

  it('still installs when the variable is present but means false', () => {
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '0' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'false' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'no' })).toBe(true);
  });
});
