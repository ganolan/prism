import { useCallback, useState } from 'react';
import { parseStoredTypeFilter } from '../lib/assessmentTypeFilter.js';

// The Summative / Formative / Unpublished filter, remembered across visits
// (#144). One setting per key, shared by every course, kept in localStorage so
// it outlives the browser tab (useStickyTab's sessionStorage does not).
// A stored value that does not parse cleanly gives the default filter.

const storageKey = (key) => `prism.typeFilter.${key}`;

// Storage throws in Safari private mode; a forgotten filter beats a crashed page.
function remembered(key) {
  try {
    return parseStoredTypeFilter(localStorage.getItem(storageKey(key)));
  } catch {
    return parseStoredTypeFilter(null);
  }
}

function remember(key, filter) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(filter));
  } catch {
    /* the filter still applies for this visit */
  }
}

export function useStickyTypeFilter(key) {
  const [filter, setFilterState] = useState(() => remembered(key));

  const setFilter = useCallback((next) => {
    remember(key, next);
    setFilterState(next);
  }, [key]);

  return [filter, setFilter];
}
