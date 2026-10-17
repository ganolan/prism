// PowerSchool alerts (#117) on the client: which may show on a roster, and the
// per-browser "show alerts on rosters" choice.
//
// A roster may be projected to a class, so it shows only learning, health and
// other alerts (never family ones: correspondence, divorced, staff child,
// siblings), and only after the teacher turns them on. The server already
// leaves family alerts out of roster data; this is the second guard.

export const ROSTER_CATEGORIES = ['learning', 'health', 'other'];
export const forRoster = (alerts) => (alerts || []).filter((a) => ROSTER_CATEGORIES.includes(a.category));

const KEY = 'prism:roster:show-ps-alerts';

// Off unless this browser turned it on. Storage can be unavailable (private
// mode) or throw: then off.
export function getRosterAlertsShown() {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function setRosterAlertsShown(shown) {
  try {
    localStorage.setItem(KEY, shown ? 'true' : 'false');
  } catch {
    // Not remembered; the toggle still works for this page.
  }
}
