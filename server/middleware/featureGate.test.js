import { describe, test, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('getSyncConfig', () => {
  let path;
  beforeEach(() => {
    path = join(tmpdir(), `cfg-${Date.now()}-${Math.random()}.yaml`);
    process.env.CONFIG_PATH = path;
    vi.resetModules();
  });

  test('returns defaults when sync section is missing', async () => {
    writeFileSync(path, 'features:\n  schoology_sync: true\n');
    const mod = await import('./featureGate.js?_=' + Date.now());
    const cfg = mod.getSyncConfig();
    expect(cfg.submissionConcurrency).toBe(2);
    expect(cfg.submissionRatePerSec).toBe(4);
    expect(cfg.submissionAbandonAfter).toBe(5);
    unlinkSync(path);
  });

  test('overrides defaults from yaml', async () => {
    writeFileSync(path, 'sync:\n  submissionConcurrency: 6\n');
    const mod = await import('./featureGate.js?_=' + Date.now());
    const cfg = mod.getSyncConfig();
    expect(cfg.submissionConcurrency).toBe(6);
    expect(cfg.submissionRatePerSec).toBe(4); // unchanged default
    unlinkSync(path);
  });
});
