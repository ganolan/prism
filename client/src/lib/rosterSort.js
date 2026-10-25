// The Roster tab's sort (25 Oct 2026, #160): First name, Last name, or (Private details only) Gender.
// Names are the ones the card shows (preferredFirstName + last_name); ties break on the other name.
// Gender: Female, then Male, then unknown, then last name.
//
// The choice is remembered on this device, one key for every course, in the same way as Private
// details (lib/privateDetails.js): storage can be unavailable or throw, so a read that throws means
// the default and a write that throws is held in memory for this page.
import { useSyncExternalStore } from 'react';
import { preferredFirstName } from './studentNames.js';
import { genderOf } from './rosterFilters.js';

export const ROSTER_SORTS = [
  { id: 'first', label: 'First name' },
  { id: 'last', label: 'Last name' },
  { id: 'gender', label: 'Gender', private: true },
];
const DEFAULT = 'last';
const KEY = 'prism:roster:sort';
const GENDER_RANK = { F: 0, M: 1, none: 2 };

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const byText = (a, b) => collator.compare(a || '', b || '');
const first = (s) => preferredFirstName(s);
const lastThenFirst = (a, b) => byText(a.last_name, b.last_name) || byText(first(a), first(b));
const firstThenLast = (a, b) => byText(first(a), first(b)) || byText(a.last_name, b.last_name);

const COMPARE = {
  first: firstThenLast,
  last: lastThenFirst,
  gender: (a, b) => GENDER_RANK[genderOf(a)] - GENDER_RANK[genderOf(b)] || lastThenFirst(a, b),
};

// A sorted copy; the array given is not changed.
export function sortRoster(students, sort) {
  return [...students].sort(COMPARE[sort] || COMPARE[DEFAULT]);
}

// The sort in force: Gender reads as Last name while Private details is off (the stored choice stays).
export const effectiveSort = (sort, privateOn) => (sort === 'gender' && !privateOn ? DEFAULT : sort);

let memory = null; // the choice, only while storage refuses to keep it
const listeners = new Set();
const valid = (v) => (ROSTER_SORTS.some((s) => s.id === v) ? v : DEFAULT);

export function getRosterSort() {
  if (memory != null) return memory;
  try {
    return valid(localStorage.getItem(KEY));
  } catch {
    return DEFAULT;
  }
}

export function setRosterSort(sort) {
  const next = valid(sort);
  try {
    localStorage.setItem(KEY, next);
    memory = null;
  } catch {
    memory = next;
  }
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  const onStorage = (e) => { if (e.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

// → [sort, setSort(id)]
export function useRosterSort() {
  const sort = useSyncExternalStore(subscribe, getRosterSort, () => DEFAULT);
  return [sort, setRosterSort];
}
