// The past-course import's settings row and its "due" mark (#171), apart from pastImport.js so the
// sync queue can mark the import due on a first run without importing pastImport.js (which imports
// the queue). pastImport.js re-exports both.
export const PAST_IMPORT_KEY = 'firstRun.pastImport';

// The first run marks the import due. A state already there (waiting, importing or done) stays.
export function markPastImportDue(db) {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(PAST_IMPORT_KEY, JSON.stringify({ state: 'waiting', total: 0, sectionIds: [], failed: [], retried: false }));
}
