// Each parent's contact status for the routes (#66): may Prism copy their address?
// Reads parents, student_ps_guardians and student_powerschool (server/db/schema.sql);
// the decision itself is server/lib/guardianContacts.js.
import { CONTACT_REASONS, placeParents, statusFor } from '../lib/guardianContacts.js';

const marks = (n) => Array(n).fill('?').join(',');
const emailKey = (email) => (email == null ? '' : String(email).trim().toLowerCase());
// The SQL form, used only to find related rows: trims spaces, tabs and line breaks;
// lower() folds ASCII case only, so two spellings of an address that differ in the
// case of a non-ASCII letter are not linked (school addresses are ASCII).
const SQL_EMAIL_KEY = (col) => `lower(trim(${col}, char(32, 9, 10, 13)))`;
// Stronger first: a row flagged both ways (by different children) is do_not_contact.
const RANK = { do_not_contact: 2, deceased: 1 };

/**
 * Map<studentId, { guardiansSyncedAt, byParent: Map<parentId, { status, primary, reason }> }>
 * for each requested student (listed even with no parents). checked = the student has
 * a guardian read (student_powerschool.guardians_synced_at). reason = CONTACT_REASONS[status],
 * null for contactable.
 *
 * A flag for one child applies to every child: a parent row (any student) that is
 * do_not_contact or deceased gives that status to every row with the same schoology_uid
 * or the same email (trimmed, any case). So the students that hold such rows are decided
 * too. One level of expansion is enough: the rule links rows directly (same uid or same
 * email), never through a chain of rows, so only rows sharing a key with a requested
 * student's parent can change its status.
 */
export function contactsForStudents(db, studentIds) {
  const ids = [...new Set((studentIds || []).map(Number))];
  const out = new Map();
  if (!ids.length) return out;

  // The students whose parent rows share a uid or an email with a requested student's.
  const own = `SELECT * FROM parents WHERE student_id IN (${marks(ids.length)})`;
  const related = db.prepare(`
    SELECT DISTINCT p.student_id FROM parents p
    WHERE p.schoology_uid IN (SELECT schoology_uid FROM (${own}) WHERE schoology_uid <> '')
       OR ${SQL_EMAIL_KEY('p.email')} IN (SELECT ${SQL_EMAIL_KEY('email')} FROM (${own}) WHERE ${SQL_EMAIL_KEY('email')} <> '')
  `).all(...ids, ...ids).map((r) => r.student_id);
  const decide = [...new Set([...ids, ...related])];

  const q = marks(decide.length);
  const parents = db.prepare(`SELECT id, student_id, schoology_uid, first_name, last_name, email
    FROM parents WHERE student_id IN (${q}) ORDER BY id`).all(...decide);
  const slotRows = db.prepare(`SELECT student_id, slot, name, email FROM student_ps_guardians WHERE student_id IN (${q})`).all(...decide);
  const psRows = db.prepare(`SELECT student_id, guardians_synced_at, dnc_g1, dnc_g2, g1_deceased, g2_deceased, correspondence
    FROM student_powerschool WHERE student_id IN (${q})`).all(...decide);
  const ps = new Map(psRows.map((r) => [r.student_id, r]));
  const slots = new Map();
  for (const r of slotRows) (slots.get(r.student_id) ?? slots.set(r.student_id, {}).get(r.student_id))[r.slot] = { name: r.name, email: r.email };
  const parentsOf = new Map();
  for (const p of parents) (parentsOf.get(p.student_id) ?? parentsOf.set(p.student_id, []).get(p.student_id)).push(p);

  // Per student: place each parent, then decide from that student's own record.
  const decided = new Map();
  for (const sid of decide) {
    const row = ps.get(sid);
    const list = parentsOf.get(sid) || [];
    const placed = placeParents(list, slots.get(sid) || {});
    for (const p of list) {
      decided.set(p.id, statusFor({ checked: row?.guardians_synced_at != null, slot: placed.get(p.id), flags: row || {}, correspondence: row?.correspondence }));
    }
  }

  // Across students: the strongest flag on any row with the same uid or email.
  const flagBy = new Map();
  const note = (key, status) => { if (key && (RANK[flagBy.get(key)] ?? 0) < RANK[status]) flagBy.set(key, status); };
  for (const p of parents) {
    const { status } = decided.get(p.id);
    if (RANK[status]) { note(p.schoology_uid && `uid:${p.schoology_uid}`, status); note(emailKey(p.email) && `email:${emailKey(p.email)}`, status); }
  }

  for (const sid of ids) {
    const byParent = new Map();
    for (const p of parentsOf.get(sid) || []) {
      let { status, primary } = decided.get(p.id);
      for (const key of [p.schoology_uid && `uid:${p.schoology_uid}`, emailKey(p.email) && `email:${emailKey(p.email)}`]) {
        const flag = key && flagBy.get(key);
        if (flag && (RANK[status] ?? 0) < RANK[flag]) { status = flag; primary = false; }
      }
      byParent.set(p.id, { status, primary, reason: CONTACT_REASONS[status] ?? null });
    }
    out.set(sid, { guardiansSyncedAt: ps.get(sid)?.guardians_synced_at ?? null, byParent });
  }
  return out;
}
