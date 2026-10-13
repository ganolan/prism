// The rubric average for feedback rows (spec 2026-10-13 §2). The mean of the
// rows' level points, read with the scale's own cutoffs. The GAS cutoffs are
// the midpoints, so this is the nearest level with a tie rounding up. Any IE
// row stops it (missing evidence is not low evidence); so does an unmarked row.
// client/src/lib/rubricAverage.js is a copy: keep both in step
// (rubricAverage.cases.json runs against each).
import { levelForScore } from './scoreScales.js';

export function rubricAverage(scale, rowNames, levelsByName) {
  if (!scale || !rowNames?.length) return { level: null, reason: 'incomplete' };
  const values = rowNames.map((n) => levelsByName?.[n] ?? null);
  if (values.includes('IE')) return { level: null, reason: 'insufficient_evidence' };
  const points = values.map((v) => (v == null ? null : scale.levels.find((l) => l.code === v)?.points ?? null));
  if (points.some((p) => p == null)) return { level: null, reason: 'incomplete' };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  return { level: levelForScore(scale, mean), reason: null };
}
