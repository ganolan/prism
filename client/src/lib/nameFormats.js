// How a class list renders a roster: the name formats a teacher can pick from,
// the separators between names, and the pure functions that apply them.
//
// Every format except `legal-last` names a student the way the rest of the app
// does — teacher override > Schoology preferred > legal first name, via
// `preferredFirstName`. `legal-last` deliberately bypasses that for the lists
// that have to match official records (report cards, exam seating, the office).

import { preferredFirstName } from './studentNames.js';

export const NAME_FORMATS = [
  { id: 'first-last', label: 'First Last' },
  { id: 'last-first', label: 'Last, First' },
  { id: 'first-initial', label: 'First L.' },
  { id: 'first-only', label: 'First name only' },
  { id: 'last-only', label: 'Last name only' },
  { id: 'legal-last', label: 'Legal first + Last' },
];

export const SEPARATORS = [
  { id: 'newline', label: 'New line', joiner: '\n' },
  { id: 'comma', label: 'Comma', joiner: ', ' },
];

// Shown in the UI so each format previews as a concrete name. Distinct legal,
// Schoology-preferred and teacher-override names, so the preview actually
// distinguishes `legal-last` from the rest.
export const SAMPLE_STUDENT = {
  first_name: 'Alexander',
  last_name: 'Chen',
  preferred_name: 'Al',
  preferred_name_teacher: 'Alex',
};

const join = (...parts) => parts.filter(Boolean).join(' ').trim();

export function formatName(student, format) {
  const first = preferredFirstName(student) || '';
  const last = student.last_name || '';

  switch (format) {
    case 'last-first':
      return last && first ? `${last}, ${first}` : join(last, first);
    case 'first-initial':
      return last ? join(first, `${last[0]}.`) : first;
    case 'first-only':
      return first;
    case 'last-only':
      return last;
    case 'legal-last':
      return join(student.first_name, last);
    case 'first-last':
    default:
      return join(first, last);
  }
}

const compare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

// Sorting always keys off the displayed (preferred) given name, whichever format
// is chosen, so the order on screen matches the order the names read in.
function sortRoster(roster, sort) {
  const byFirst = sort === 'first';
  return [...roster].sort((a, b) => {
    const primary = byFirst
      ? compare(preferredFirstName(a), preferredFirstName(b))
      : compare(a.last_name, b.last_name);
    if (primary !== 0) return primary;
    return byFirst
      ? compare(a.last_name, b.last_name)
      : compare(preferredFirstName(a), preferredFirstName(b));
  });
}

export function formatClassList(roster, { format = 'first-last', separator = 'newline', sort = 'last' } = {}) {
  const joiner = (SEPARATORS.find(s => s.id === separator) || SEPARATORS[0]).joiner;
  return sortRoster(roster, sort)
    .map(s => formatName(s, format))
    .filter(Boolean)
    .join(joiner);
}
