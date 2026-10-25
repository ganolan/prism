// How the Roster tab shows gender (25 Oct 2026, #160): a short code, never a word. The full label is for
// the tag's hover popover and aria-label (components/roster/StudentTags.jsx) and the Gender filter pills.
//   F  Female            M  Male
//   NB any value other than F or M that PowerSchool sends; the label quotes that value exactly
//      (Recorded in PowerSchool as "X"), so the roster never assumes what it means (Graham, 25 Oct 2026)
//   ?  Not recorded in PowerSchool        a blank or missing value
// Class Tools (#73) keeps its own words (lib/rosterFilters.js); it does not use this.

const NOT_RECORDED = 'Not recorded in PowerSchool';

// By filter key, in the order the roster lists them (the Gender pills, the Gender sort).
// The key for a blank value stays 'none', as in every other roster filter.
export const GENDER_TAGS = {
  F: { code: 'F', label: 'Female' },
  M: { code: 'M', label: 'Male' },
  NB: { code: 'NB', label: 'Recorded in PowerSchool as another value' },
  none: { code: '?', label: NOT_RECORDED },
};

// A raw value (from `students.gender`) → its filter key: 'F', 'M', 'NB' or 'none' (blank or missing).
function keyOfValue(raw) {
  const g = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!g) return 'none';
  return g === 'F' || g === 'M' ? g : 'NB';
}

// The NB label for the values PowerSchool sent, quoted exactly: 'Recorded in PowerSchool as "X"', or
// 'as "X" or "U"' when a pill covers several students with different values.
export function otherValueLabel(values) {
  const distinct = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (!distinct.length) return GENDER_TAGS.NB.label;
  return `Recorded in PowerSchool as ${distinct.map((v) => `"${v}"`).join(' or ')}`;
}

// One helper: a raw value → { code, label }.
export function genderTag(raw) {
  const key = keyOfValue(raw);
  return key === 'NB' ? { code: 'NB', label: otherValueLabel([raw]) } : { ...GENDER_TAGS[key] };
}

// A student → its filter key.
export const genderOf = (student) => keyOfValue(student?.gender);
