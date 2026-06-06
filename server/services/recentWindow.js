// #55: pure helpers for the recent-only submission-status window. No I/O.

const DAY_MS = 86400000;

// Restrict a list of assignments to those whose submission status is worth the
// expensive per-cell check: due within the last `recentDays` days, or due in
// the future. Undated and clearly-old assignments are dropped. When `recentOnly`
// is false this is a pass-through. `now` is an ISO string (the sync's reference
// timestamp), so it must be parsed before arithmetic.
export function filterRecentAssignments(assignments, recentOnly, recentDays, now) {
  if (!recentOnly) return { target: assignments, windowSkipped: 0 };
  const cutoff = Date.parse(now) - recentDays * DAY_MS;
  const target = assignments.filter((a) => {
    const t = a.due ? Date.parse(a.due) : NaN;
    return !Number.isNaN(t) && t >= cutoff;
  });
  return { target, windowSkipped: assignments.length - target.length };
}

// Coerce a day-window value to a positive integer in [1, 365]; non-numbers fall
// back to `fallback`. Shared by the route (trust boundary) and syncSectionData.
export function clampDays(value, fallback = 30) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}
