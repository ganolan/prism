// Course-page assessment filter shared by the Assessments and Gradebook tabs:
// Summative / Formative show-hide toggles plus an Unpublished toggle for
// assignments not published on Schoology (hidden by default).

export const DEFAULT_TYPE_FILTER = { summative: true, formative: true, unpublished: false };

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
