// Stored PowerSchool student alerts (#117): the sync's write and the reads the
// API routes and PrisMCP share. Tables: student_ps_alerts, student_powerschool
// and student_ps_guardians (server/db/schema.sql). The alert reads never return the
// contact fields; they feed each parent's contact status (#66), decided in
// server/services/guardianContactStore.js.
import { describeAlerts, CONTACT_FIELDS } from '../lib/psAlerts.js';

/**
 * Store what a sync read. byDcid: Map<PowerSchool student dcid, { alerts, contact }>
 * (server/lib/psAlerts.js sectionAlerts). Each matched student (students.school_uid
 * = '1_' + dcid) gets exactly these alerts and contact fields; students not in the
 * map are untouched. A contact column missing from `contact` (the read had no key for
 * its field) keeps its stored value, so a renamed PowerSchool field never clears a flag.
 * idByKey: Map<alert key, PowerSchool alert type id>.
 * → { students, withAlerts }.
 */
export function applyPsAlerts(db, byDcid, { now = new Date().toISOString(), idByKey = new Map() } = {}) {
  const find = db.prepare('SELECT id FROM students WHERE school_uid = ?');
  const clear = db.prepare('DELETE FROM student_ps_alerts WHERE student_id = ?');
  const add = db.prepare('INSERT INTO student_ps_alerts (student_id, alert_key, ps_alert_id) VALUES (?, ?, ?)');
  // One statement per set of contact columns present (usually all of them).
  const upserts = new Map();
  const upsertFor = (cols) => upserts.get(cols.join()) ?? upserts.set(cols.join(), db.prepare(`
    INSERT INTO student_powerschool (student_id, alerts_synced_at${cols.map((c) => `, ${c}`).join('')})
    VALUES (?, ?${cols.map(() => ', ?').join('')})
    ON CONFLICT(student_id) DO UPDATE SET alerts_synced_at = excluded.alerts_synced_at${cols.map((c) => `, ${c} = excluded.${c}`).join('')}
  `)).get(cols.join());
  let students = 0; let withAlerts = 0;
  db.transaction(() => {
    for (const [dcid, entry] of byDcid) {
      const row = find.get(`1_${dcid}`);
      if (!row) continue;
      students++;
      clear.run(row.id);
      for (const key of entry.alerts) add.run(row.id, key, idByKey.get(key) ?? null);
      if (entry.alerts.length) withAlerts++;
      const contact = entry.contact || {};
      const cols = CONTACT_FIELDS.map((f) => f.column).filter((c) => c in contact);
      upsertFor(cols).run(row.id, now, ...cols.map((c) => contact[c] ?? null));
    }
  })();
  return { students, withAlerts };
}

/**
 * Store the guardian slots a sync read (#66). byDcid: Map<PowerSchool student dcid,
 * { g1, g2 }> with each slot { name, email } (server/lib/psEmergencyContacts.js
 * slotsByDcid). Each matched student gets exactly these slots (a slot with neither name
 * nor email gets no row) and guardians_synced_at = now; students not in the map are
 * untouched. → { students }.
 */
export function applyPsGuardians(db, byDcid, { now = new Date().toISOString() } = {}) {
  const find = db.prepare('SELECT id FROM students WHERE school_uid = ?');
  const clear = db.prepare('DELETE FROM student_ps_guardians WHERE student_id = ?');
  const add = db.prepare('INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, ?, ?, ?)');
  const stamp = db.prepare(`
    INSERT INTO student_powerschool (student_id, guardians_synced_at) VALUES (?, ?)
    ON CONFLICT(student_id) DO UPDATE SET guardians_synced_at = excluded.guardians_synced_at
  `);
  let students = 0;
  db.transaction(() => {
    for (const [dcid, { g1, g2 }] of byDcid) {
      const row = find.get(`1_${dcid}`);
      if (!row) continue;
      students++;
      clear.run(row.id);
      for (const [slot, g] of [[1, g1], [2, g2]]) if (g?.name || g?.email) add.run(row.id, slot, g.name ?? null, g.email ?? null);
      stamp.run(row.id, now);
    }
  })();
  return { students };
}

// ── Reads for the API and PrisMCP ──────────────────────────────────────────

// Map<studentId, [{ key, label, category, title? }]> for these students (each
// listed, [] when none). Never includes the contact fields.
export function psAlertsByStudent(db, studentIds) {
  const ids = [...new Set((studentIds || []).map(Number))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const keys = new Map();
  const rows = db.prepare(`SELECT student_id, alert_key FROM student_ps_alerts WHERE student_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const r of rows) (keys.get(r.student_id) ?? keys.set(r.student_id, []).get(r.student_id)).push(r.alert_key);
  for (const [id, k] of keys) out.set(id, describeAlerts(k));
  return out;
}

// One student's alerts and when they were last read: { alerts, synced_at }.
export function psAlertsForStudent(db, studentId) {
  const alerts = psAlertsByStudent(db, [studentId]).get(Number(studentId)) || [];
  const row = db.prepare('SELECT alerts_synced_at FROM student_powerschool WHERE student_id = ?').get(Number(studentId));
  return { alerts, synced_at: row?.alerts_synced_at ?? null };
}

// PrisMCP fields per student: Map<studentId, { powerschool_alerts: [{ key, label,
// category }], powerschool_alerts_read_at: ISO | null }>. read_at null = never
// read, so an empty list then means unknown, not none.
export function psAlertFieldsForAgents(db, studentIds) {
  const ids = [...new Set((studentIds || []).map(Number))];
  const alerts = psAlertsByStudent(db, ids);
  const readAt = new Map(ids.length
    ? db.prepare(`SELECT student_id, alerts_synced_at FROM student_powerschool WHERE student_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids).map((r) => [r.student_id, r.alerts_synced_at])
    : []);
  return new Map(ids.map((id) => [id, {
    powerschool_alerts: (alerts.get(id) || []).map(({ key, label, category }) => ({ key, label, category })),
    powerschool_alerts_read_at: readAt.get(id) ?? null,
  }]));
}
