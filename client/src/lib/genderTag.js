// How the Roster tab shows gender (25 Oct 2026, #160): a short code, never a word. The full label is for
// the tag's hover popover and aria-label (components/roster/StudentTags.jsx) and the Gender filter pills.
//   F  Female            M  Male
//   NB Non-binary        any value other than F or M that PowerSchool sends
//   ?  Not recorded in PowerSchool        a blank or missing value
// Class Tools (#73) keeps its own words (lib/rosterFilters.js); it does not use this.

const NOT_RECORDED = 'Not recorded in PowerSchool';

// By filter key, in the order the roster lists them (the Gender pills, the Gender sort).
// The key for a blank value stays 'none', as in every other roster filter.
export const GENDER_TAGS = {
  F: { code: 'F', label: 'Female' },
  M: { code: 'M', label: 'Male' },
  NB: { code: 'NB', label: 'Non-binary' },
  none: { code: '?', label: NOT_RECORDED },
};

// A raw value (from `students.gender`) → its filter key: 'F', 'M', 'NB' or 'none' (blank or missing).
function keyOfValue(raw) {
  const g = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!g) return 'none';
  return g === 'F' || g === 'M' ? g : 'NB';
}

// One helper: a raw value → { code, label }.
export const genderTag = (raw) => ({ ...GENDER_TAGS[keyOfValue(raw)] });

// A student → its filter key.
export const genderOf = (student) => keyOfValue(student?.gender);
