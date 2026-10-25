// Class Tools' roster filters (#73): the query the tool endpoints take, and the pill labels.
// The server's half is server/services/classRoster.js. Values are strings; 'none' = no value.
import { LEVEL_LABELS } from './masteryLevels.js';

export const FILTER_TYPES = [
  { id: 'gender', label: 'Gender' },
  { id: 'grade', label: 'Grade' },
  { id: 'level', label: 'Overall proficiency' },
];

export const GENDER_LABELS = { F: 'Female', M: 'Male' };

// A student's gender as the roster knows it: 'F', 'M', or 'none' (blank, missing, or any other value).
export function genderOf(student) {
  const g = typeof student?.gender === 'string' ? student.gender.trim().toUpperCase() : '';
  return GENDER_LABELS[g] ? g : 'none';
}
const NONE_LABELS = { gender: 'Not known', grade: 'No grade', level: 'No levels yet' };

export function filterValueLabel(type, value) {
  if (value === 'none') return NONE_LABELS[type];
  if (type === 'gender') return GENDER_LABELS[value] ?? value;
  if (type === 'grade') return `Grade ${value}`;
  return value; // a level code; its full name is the pill's title
}

export function filterValueTitle(type, value) {
  return type === 'level' && value !== 'none' ? LEVEL_LABELS[value] : undefined;
}

// { gender: ['F'], grade: [] } → 'gender=F' ('' with nothing chosen), in FILTER_TYPES order.
export function rosterFilterQuery(filters = {}) {
  return FILTER_TYPES
    .filter(({ id }) => filters[id]?.length)
    .map(({ id }) => `${id}=${filters[id].map(encodeURIComponent).join(',')}`)
    .join('&');
}

// Keep only the chosen values the new roster still holds (facets from GET /tools/filters).
export function keepHeldValues(filters, facets) {
  const out = {};
  for (const { id } of FILTER_TYPES) {
    const held = new Set((facets?.[id] ?? []).map((f) => f.value));
    const kept = (filters[id] ?? []).filter((v) => held.has(v));
    if (kept.length) out[id] = kept;
  }
  return out;
}
