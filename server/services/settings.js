// Server-side app settings (settings table). Triage limits live under 'triage.*'.
const TRIAGE_KEYS = {
  referralLimitDays: { def: 8, min: 1, max: 60 },
  feedbackLimitDays: { def: 10, min: 1, max: 60 },
  warnLeadDays: { def: 3, min: 0, max: 59 },
  showFormativeDefault: { def: false, bool: true },
};

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
  const stored = new Map(
    db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'triage.%'`).all()
      .map((r) => [r.key.slice('triage.'.length), r.value]),
  );
  return Object.fromEntries(
    Object.entries(TRIAGE_KEYS).map(([k, spec]) => [k, stored.has(k) ? parse(spec, stored.get(k)) : spec.def]),
  );
}

export function updateTriageSettings(db, patch = {}) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch || {})) {
      const spec = TRIAGE_KEYS[k];
      if (spec) upsert.run(`triage.${k}`, JSON.stringify(coerce(spec, v)));
    }
  })();
  return getTriageSettings(db);
}
