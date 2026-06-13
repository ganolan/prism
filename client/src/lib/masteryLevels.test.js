import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeScaleHelpers, LEVELS, LEVEL_COLORS, LEVEL_LABELS, masteryCodeForLevel } from './masteryLevels.js';

// Canonical cross-process identity fixture (shared with the server guard in
// server/middleware/featureGate.test.js). The server pins its
// DEFAULT_PROFICIENCY_SCALE to the same file; together the two guards make a
// genuine client/server divergence impossible to land silently. See issue #115.
const CANONICAL_LEVELS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'shared', 'proficiency-levels.json'),
    'utf-8',
  ),
).levels;

const TABLE = [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
];

test('static exports', () => {
  expect(LEVELS).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  expect(LEVEL_COLORS.ED.headerFill).toBe('#bfdbfe');
  expect(LEVEL_LABELS.EX).toBe('Exhibiting');
  expect(masteryCodeForLevel('Exhibiting')).toBe('EX');
});

test('makeScaleHelpers binds the table', () => {
  const h = makeScaleHelpers(TABLE);
  expect(h.pointsToLevel(80)).toBe('EX');
  expect(h.pointsToLevel(12.49)).toBe('IE');
  expect(h.levelToPoints('EX')).toBe(75);
  expect(h.levelToGradeScaled('EX')).toBe('62.50');
  expect(h.computeLetterGrade(['ED', 'ED'])).toBe('A');
});

// Cross-process drift guard (client side). Pins the client's hardcoded level
// identity (order + labels) to the shared canonical fixture, which the server
// also pins its default scale to. Unlike the old guard (which compared
// LEVEL_LABELS against a local transcription in this same file, so it could
// never catch a real server-side change), this fails if the client drifts from
// the cross-process source of truth.
test('client level identity matches the canonical fixture (cross-process drift guard)', () => {
  expect(LEVELS).toEqual(CANONICAL_LEVELS.map((l) => l.code));
  const clientIdentity = LEVELS.map((code) => ({ code, label: LEVEL_LABELS[code] }));
  expect(clientIdentity).toEqual(CANONICAL_LEVELS);
});
