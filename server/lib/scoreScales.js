/**
 * scoreScales.js
 *
 * Schoology grading scales Prism can grade an UNALIGNED assignment against
 * (#41): Completion, General Academic Scale (Unaligned), Approaches to Learning.
 * These are plain gradebook grades — no measurement topics, no district-mastery
 * observations (verified 2026-09-28: an ATL-scale task has
 * use_district_mastery_grading:false and its grade lives only in the public
 * grades endpoint). Definitions live in config.yaml `grading.scoreScales`,
 * levels ordered best → worst.
 */

/** The configured scale for an assignment's `grading_scale_id`, or null. */
export function findScoreScale(scales, gradingScaleId) {
  if (!Array.isArray(scales) || gradingScaleId == null || gradingScaleId === '') return null;
  return scales.find(s => String(s.schoologyScaleId) === String(gradingScaleId)) ?? null;
}

/**
 * The level code a stored score reads as: the highest level whose cutoff ≤
 * score — how Schoology itself buckets it, so legacy values (90, 95 on the GAS)
 * land where the gradebook shows them. null when there's no score.
 */
export function levelForScore(scale, score) {
  if (score == null || score === '') return null;
  const n = Number(score);
  if (Number.isNaN(n)) return null;
  const byCutoff = [...scale.levels].sort((a, b) => b.cutoff - a.cutoff);
  return byCutoff.find(l => n >= l.cutoff)?.code ?? null;
}

/** Whether `points` is exactly one of the scale's level values — the only grades Prism writes. */
export function isScalePoints(scale, points) {
  const n = Number(points);
  return !Number.isNaN(n) && scale.levels.some(l => l.points === n);
}

/** A level given as its code or label (any case) → the scale's level code, or null. */
export function normalizeScaleLevel(scale, raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  return scale.levels.find(l => l.code.toLowerCase() === v || l.label.toLowerCase() === v)?.code ?? null;
}
