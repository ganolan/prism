import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// Tab state that survives navigating away and coming back.
//
// Two mechanisms, because there are two ways back and neither covers both:
//   - The URL query param handles the browser back button (the page's history
//     entry already carries `?tab=…`) and makes a tab linkable.
//   - The sessionStorage fallback handles plain "← Back to course" style links,
//     which point at a bare path with no query string.
//
// Tab changes replace the current history entry rather than pushing one, so
// back still leaves the page instead of stepping through the tabs you clicked.

const storageKey = (key) => `prism.tab.${key}`;

// Storage throws in Safari private mode; a forgotten tab beats a crashed page.
function remembered(key) {
  try {
    return sessionStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    sessionStorage.setItem(storageKey(key), value);
  } catch {
    /* ignore */
  }
}

export function useStickyTab(key, fallback, { param = 'tab' } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // `get` returns null when absent but '' for `?status=`, so `??` correctly
  // treats an empty-string tab (FeedbackPage's "All") as a real choice.
  const value = searchParams.get(param) ?? remembered(key) ?? fallback;

  const setValue = useCallback((next) => {
    remember(key, next);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set(param, next);
      return params;
    }, { replace: true });
  }, [key, param, setSearchParams]);

  return [value, setValue];
}
