// Course-page assessment filter shared by the Assessments and Gradebook tabs:
// Summative / Formative show-hide toggles plus an Unpublished toggle for
// assignments not published on Schoology (hidden by default).

export const DEFAULT_TYPE_FILTER = { summative: true, formative: true, unpublished: false };

// Reads a filter saved as JSON (see hooks/useStickyTypeFilter.js). Anything
// that is not a plain object of known keys with boolean values gives the
// default; keys missing from an older saved value come from the default.
export function parseStoredTypeFilter(raw) {
  if (raw == null) return DEFAULT_TYPE_FILTER;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_TYPE_FILTER;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_TYPE_FILTER;
  const valid = Object.entries(value).every(
    ([key, v]) => Object.hasOwn(DEFAULT_TYPE_FILTER, key) && typeof v === 'boolean',
  );
  return valid ? { ...DEFAULT_TYPE_FILTER, ...value } : DEFAULT_TYPE_FILTER;
}

// A missing `published` (older payloads, test fixtures) counts as published.
export const isUnpublished = (a) => a.published != null && Number(a.published) === 0;

export function passesTypeFilter(a, filter = DEFAULT_TYPE_FILTER) {
  if (isUnpublished(a) && !filter.unpublished) return false;
  return a.aligned ? filter.summative : filter.formative;
}

// Pill counts. Summative/Formative count what the Unpublished setting lets
// through; Unpublished counts every unpublished assignment.
export function typeFilterCounts(assignments, filter = DEFAULT_TYPE_FILTER) {
  const pool = assignments.filter(a => filter.unpublished || !isUnpublished(a));
  const summative = pool.filter(a => a.aligned).length;
  return {
    summative,
    formative: pool.length - summative,
    unpublished: assignments.filter(isUnpublished).length,
  };
}
