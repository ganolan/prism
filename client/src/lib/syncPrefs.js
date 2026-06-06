// #55: remembers the teacher's last-used "recent submissions only" choice so the
// Sync dialog can pre-fill it. Per-browser; the server stays stateless and only
// receives explicit per-request params.

const KEY_ON = 'prism:sync:recent-only';
const KEY_DAYS = 'prism:sync:recent-days';

// Coerce a day value to a positive integer in [1, 365]; non-numbers → fallback.
export function clampDays(value, fallback = 30) {
  if (value == null) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}

export function getSyncPrefs() {
  try {
    return {
      recentOnly: localStorage.getItem(KEY_ON) === 'true',
      recentDays: clampDays(localStorage.getItem(KEY_DAYS)),
    };
  } catch {
    // localStorage unavailable (private mode) — fall back to defaults.
    return { recentOnly: false, recentDays: 30 };
  }
}

export function setSyncPrefs({ recentOnly, recentDays }) {
  try {
    localStorage.setItem(KEY_ON, recentOnly ? 'true' : 'false');
    localStorage.setItem(KEY_DAYS, String(clampDays(recentDays)));
  } catch {
    // localStorage unavailable (private mode / quota) — degrade silently.
  }
}
