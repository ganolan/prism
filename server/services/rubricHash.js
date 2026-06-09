import { createHash } from 'node:crypto';
import { LEVELS } from '../lib/proficiencyScale.js';
const norm = (s) => String(s ?? '').trim();

// Canonical, name-independent representation of a rubric's content: ordered
// criteria → fixed-key fields + per-level descriptors (IE defaulted). Excludes
// name/source/ids/position/external_id, and collapses null/'' + trims, so
// identical content under different names hashes the same. Order is significant.
export function canonicalRubric(content) {
  return (content.criteria || []).map((c) => ({
    criterion_name: norm(c.criterion_name),
    standard_title: norm(c.standard_title),
    reporting_category: norm(c.reporting_category),
    descriptors: Object.fromEntries(LEVELS.map((l) => [
      l, l === 'IE' ? (norm(c.descriptors?.IE) || 'Insufficient Evidence') : norm(c.descriptors?.[l]),
    ])),
  }));
}

export function hashRubricContent(content) {
  return createHash('sha256').update(JSON.stringify(canonicalRubric(content))).digest('hex');
}
