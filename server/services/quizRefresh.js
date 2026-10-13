// Nightly refresh of quiz results (spec §12): every group loaded in the last REFRESH_DAYS
// days, in a course that is not archived, is reloaded through the same read-only loader.
// One group failing never stops the others, except an expired session, which would fail
// every later group the same way.
import { loadGroup } from './quizLoader.js';

export const REFRESH_DAYS = 28;

export function groupsToRefresh(db, { now = new Date(), days = REFRESH_DAYS } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`SELECT g.id, g.title FROM quiz_groups g JOIN courses c ON c.id = g.course_id
    WHERE g.loaded_at IS NOT NULL AND g.loaded_at >= ? AND COALESCE(c.archived, 0) = 0 ORDER BY g.id`).all(since);
}

export async function refreshRecentQuizzes(db, { now, days, load = loadGroup, onGroup = () => {} } = {}) {
  const results = [];
  for (const g of groupsToRefresh(db, { now, days })) {
    let result;
    try {
      const summary = await load(db, { groupId: g.id });
      result = { groupId: g.id, title: g.title, status: 'done', attempts: summary.attempts };
    } catch (err) {
      result = { groupId: g.id, title: g.title, status: 'error', code: err.code ?? null, message: err.message };
    }
    results.push(result);
    onGroup(result);
    if (result.code === 'NO_SESSION') break;
  }
  return results;
}
