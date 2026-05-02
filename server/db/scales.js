import { getDb } from './index.js';

// Returns { [schoology_scale_id]: { title, levels: [{name, cutoff, average}] } }
// for all known grading scales. Used by routes that return grades so the client
// can render scale-aware labels (Complete, ED, etc.) instead of raw scores.
export function getGradingScalesMap() {
  const rows = getDb().prepare('SELECT schoology_scale_id, title, levels_json FROM grading_scales').all();
  const map = {};
  for (const r of rows) {
    let levels = [];
    try { levels = JSON.parse(r.levels_json) || []; } catch { /* keep empty */ }
    map[r.schoology_scale_id] = { title: r.title, levels };
  }
  return map;
}
