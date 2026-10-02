// Server-side app settings (settings table). Triage limits live under 'triage.*'.
// Day numbers count the due date (or test date) as day 1. The limits are the
// LAST ALLOWED day: late work is referred after day referralLimitDays (8 → day 9),
// feedback is overdue after day feedbackLimitDays (10 → day 11).
const TRIAGE_KEYS = {
  referralLimitDays: { def: 8, min: 1, max: 60 },
  feedbackLimitDays: { def: 10, min: 1, max: 60 },
  // Amber covers the last warnLeadDays allowed days before each limit.
  warnLeadDays: { def: 3, min: 0, max: 59 },
  showFormativeDefault: { def: false, bool: true },
  // Make-up tests (test day = day 1): amber from day makeUpAmberDay, red from day makeUpRedDay.
  makeUpAmberDay: { def: 2, min: 1, max: 31 },
  makeUpRedDay: { def: 4, min: 2, max: 31 },
};

// Before 2026-10-02 the make-up clock was stored as school days AFTER the test
// (makeUpAmberDays 1 / makeUpRedDays 3). Convert each to its day number (+1),
// once: only while the new key is absent. The old rows are left in place (harmless).
const LEGACY_MAKE_UP_KEYS = { makeUpAmberDays: 'makeUpAmberDay', makeUpRedDays: 'makeUpRedDay' };

function migrateLegacyMakeUpKeys(db) {
  const rows = db.prepare(`
    SELECT key, value FROM settings WHERE key IN ('triage.makeUpAmberDays', 'triage.makeUpRedDays')
  `).all();
  if (rows.length === 0) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
  for (const { key, value } of rows) {
    const to = LEGACY_MAKE_UP_KEYS[key.slice('triage.'.length)];
    let old;
    try { old = Number(JSON.parse(value)); } catch { continue; }
    if (!Number.isFinite(old)) continue;
    insert.run(`triage.${to}`, JSON.stringify(coerce(TRIAGE_KEYS[to], Math.floor(old) + 1)));
  }
}

export const TRIAGE_DEFAULTS = Object.fromEntries(Object.entries(TRIAGE_KEYS).map(([k, s]) => [k, s.def]));

function coerce(spec, value) {
  if (spec.bool) return value === true || value === 'true' || value === 1;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

function parse(spec, text) {
  try { return coerce(spec, JSON.parse(text)); } catch { return spec.def; }
}

export function getTriageSettings(db) {
  migrateLegacyMakeUpKeys(db);
  const stored = new Map(
    db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'triage.%'`).all()
      .map((r) => [r.key.slice('triage.'.length), r.value]),
  );
  const s = Object.fromEntries(
    Object.entries(TRIAGE_KEYS).map(([k, spec]) => [k, stored.has(k) ? parse(spec, stored.get(k)) : spec.def]),
  );
  // Amber can't start after red.
  s.makeUpAmberDay = Math.min(s.makeUpAmberDay, s.makeUpRedDay);
  return s;
}

export function updateTriageSettings(db, patch = {}) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    migrateLegacyMakeUpKeys(db);
    for (const [k, v] of Object.entries(patch || {})) {
      const spec = TRIAGE_KEYS[k];
      if (spec) upsert.run(`triage.${k}`, JSON.stringify(coerce(spec, v)));
    }
    // A make-up change stores amber clamped to red too (getTriageSettings also clamps on read).
    if (patch && ('makeUpAmberDay' in patch || 'makeUpRedDay' in patch)) {
      upsert.run('triage.makeUpAmberDay', JSON.stringify(getTriageSettings(db).makeUpAmberDay));
    }
  })();
  return getTriageSettings(db);
}
