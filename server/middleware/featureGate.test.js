import { describe, test, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getProficiencyScale, DEFAULT_PROFICIENCY_SCALE } from './featureGate.js';

// Canonical cross-process identity fixture (shared with the client guard in
// client/src/lib/masteryLevels.test.js). Pin codes + labels + order only —
// numeric mapping is config-driven (ADR-0001). See issue #115.
const CANONICAL_LEVELS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'proficiency-levels.json'),
    'utf-8',
  ),
).levels;

describe('getProficiencyScale', () => {
  test('returns the HKIS General Academic Scale with all five levels', () => {
    const scale = getProficiencyScale();
    expect(scale.schoologyScaleId).toBe(21337256);
    expect(scale.levels.map((l) => l.code)).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
    const ed = scale.levels.find((l) => l.code === 'ED');
    expect(ed).toMatchObject({ label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' });
    const ie = scale.levels.find((l) => l.code === 'IE');
    expect(ie).toMatchObject({ label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' });
  });

  // Cross-process drift guard (server side). The sibling client guard pins
  // LEVELS + LEVEL_LABELS to the same fixture; together they guarantee the
  // server default identity and the client's hardcoded identity can't diverge
  // silently. Fails here if a server default code/label/order edit lands
  // without updating shared/proficiency-levels.json.
  test('server default proficiency identity matches the canonical fixture', () => {
    const serverIdentity = DEFAULT_PROFICIENCY_SCALE.levels.map((l) => ({
      code: l.code,
      label: l.label,
    }));
    expect(serverIdentity).toEqual(CANONICAL_LEVELS);
  });
});

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
