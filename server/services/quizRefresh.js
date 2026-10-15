// Nightly refresh of quiz results (spec §12): every group students sat in the last REFRESH_DAYS
// days (its latest attempt, or, before anyone has sat it, when it was created), loaded at least
// once, in a course that is not archived, is reloaded through the same read-only loader. The
// window never follows loaded_at, because each nightly reload renews it.
// One group failing never stops the others, except an expired session, which would fail
// every later group the same way.
import { loadGroup } from './quizLoader.js';

export const REFRESH_DAYS = 28;

export function groupsToRefresh(db, { now = new Date(), days = REFRESH_DAYS } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`SELECT g.id, g.title FROM quiz_groups g JOIN courses c ON c.id = g.course_id
    WHERE g.loaded_at IS NOT NULL AND COALESCE(c.archived, 0) = 0
      AND COALESCE((SELECT MAX(COALESCE(qa.completed_at, qa.started_at)) FROM quiz_attempts qa WHERE qa.group_id = g.id), g.created_at) >= ?
    ORDER BY g.id`).all(since);
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
