// Single source of truth for the proficiency level↔gradebook-score mapping.
// Reads the configurable scale (server/middleware/featureGate.getProficiencyScale)
// and derives every helper the codebase used to re-implement. Banding cutoffs are
// the gradeScaled values, so pointsToLevel is "highest level whose gradeScaled ≤ n".
import { getProficiencyScale } from '../middleware/featureGate.js';

const table = () => getProficiencyScale().levels;

export const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export function getScaleTable() {
  return table();
}

export function normalizeLevel(raw) {
  if (raw == null || typeof raw === 'number') return null;
  const s = String(raw).trim().toLowerCase();
  for (const l of table()) {
    if (s === l.code.toLowerCase() || s === l.label.toLowerCase()) return l.code;
  }
  return null;
}

// Highest level whose gradeScaled ≤ n (IE is the floor). Works for an exact
// Schoology rollup (62.50→EX) and a rounded 0–100 mean/mode (80→EX).
export function pointsToLevel(n) {
  if (n == null) return null;
  const levels = table();
  for (const l of levels) {
    if (n >= Number(l.gradeScaled)) return l.code;
  }
  return levels[levels.length - 1].code; // IE floor
}

const find = (code) => table().find((l) => l.code === code) || null;

export function levelToPoints(code) {
  const l = find(code);
  return l ? l.points : null;
}

export function levelToGradeScaled(code) {
  const l = find(code);
  return l ? l.gradeScaled : null;
}

export function levelToLabel(code) {
  const l = find(code);
  return l ? l.label : null;
}

export function gradeScaledValues() {
  return new Set(table().map((l) => l.gradeScaled));
}

export function schoologyScaleId() {
  return getProficiencyScale().schoologyScaleId;
}
