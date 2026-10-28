// Each parent's contact status for the routes (#66): may Prism copy their address?
// Reads parents, student_ps_guardians and student_powerschool (server/db/schema.sql);
// the decision itself is server/lib/guardianContacts.js.
import { CONTACT_REASONS, FLAG_RANK as RANK, decideParents, emailKey, placeParents } from '../lib/guardianContacts.js';

const marks = (n) => Array(n).fill('?').join(',');
// The SQL form, used only to find related rows: trims spaces, tabs, line breaks and
// no-break spaces (char(160), which JS trim also removes); lower() folds ASCII case
// only, so two spellings of an address that differ in the case of a non-ASCII letter
// are not linked (school addresses are ASCII).
const SQL_EMAIL_KEY = (col) => `lower(trim(${col}, char(32, 9, 10, 13, 160)))`;
// The keys that link a parent row to the same guardian's rows for other children.
// A PowerSchool flag is set by any value but null and '' (as guardianContacts.js reads it).
const isFlagged = (v) => v != null && String(v) !== '';
// A phone number's digits, how two numbers compare ('5550-0100' is '5550 0100').
const phoneKey = (n) => String(n ?? '').replace(/\D/g, '');
const keysOf = (p) => [p.schoology_uid && `uid:${p.schoology_uid}`, emailKey(p.email) && `email:${emailKey(p.email)}`].filter(Boolean);

// One student's PowerSchool details per parent: Map<parentId, { email, phone }> for each
// parent uniquely placed in a slot (none when the student was never checked).
function psDetails(checked, parents, slots) {
  const out = new Map();
  if (!checked) return out;
  const placed = placeParents(parents, slots);
  const held = [...placed.values()].filter(Boolean);
  for (const [id, slot] of placed) {
    // slot: which PowerSchool guardian (1 or 2), so the page can tag the contact G1 or G2 (28 Oct 2026).
    if (slot && held.filter((s) => s === slot).length === 1) out.set(id, { email: slots[slot].email ?? null, phone: slots[slot].phone ?? null, slot });
  }
  return out;
}

/**
 * Map<studentId, { guardiansSyncedAt, byParent: Map<parentId, { status, primary, reason, uncertain?, ps, email, copy, tel }> }>
 * for each requested student (listed even with no parents). checked = the student has
 * a guardian read (student_powerschool.guardians_synced_at). Each student's own parents
 * are decided by decideParents (server/lib/guardianContacts.js), which also gives a
 * flagged slot no parent is placed in to the parents it could be (`uncertain: true`).
 *
 * A flag for one child applies to every child: a parent row (any student) that is
 * do_not_contact or deceased gives that status to every row linked to it by the same
 * schoology_uid or the same email (trimmed, any case), and links chain: A's row shares a
 * uid with B's, B's shares an email with C's, so all three are one guardian. The rows
 * form groups (connected components) and the strongest flag in a group applies to every
 * row in it. So the students holding any row of a requested student's groups are
 * decided too, found by repeating the related-student query to a fixpoint. The loop is
 * finite (each round adds at least one new student, and there are finitely many) and in
 * practice ends in two or three rounds (a family's children). A row that takes its
 * status from another row gets the plain reason (CONTACT_REASONS) and no `uncertain`
 * mark, even when the row it came from was uncertain: the uncertainty belongs to the
 * other child's record, whose card states it.
 *
 * ps (#173): { email, phone } of the PowerSchool slot the parent is uniquely placed in on
 * this student's record (placeParents; either may be null), else null: not checked, not
 * placed, or placed in a slot another parent shares (two parents with one email). It is
 * given whatever the status.
 *
 * email and copy (#173, controller's ruling): the one rule both routes and the client use.
 * An address is blocked when a do_not_contact or deceased guardian holds it (see blocked
 * below). email = the address to show: ps.email when not blocked, else the Schoology email
 * when not blocked, else the first of the two that is set (shown as plain text), else
 * null. copy = the addresses that may be linked and copied: [] unless the status is
 * contactable, else [email, extra_email] without blocked or empty ones, de-duplicated
 * (emailKey).
 *
 * tel (#173, controller's ruling 3): the numbers that may be a tel: link. A number is
 * blocked when a do_not_contact or deceased guardian holds it, compared by its digits.
 * tel = [] unless the status is contactable, else [ps.phone, phone] without blocked or
 * empty ones, de-duplicated by digits.
 */
export function contactsForStudents(db, studentIds) {
  const ids = [...new Set((studentIds || []).map(Number))];
  const out = new Map();
  if (!ids.length) return out;

  // Every student whose parent rows link, through any chain of uids and emails, to a
  // requested student's: expand one round at a time until no new student appears.
  const known = new Set(ids);
  for (let frontier = ids; frontier.length;) {
    const own = `SELECT * FROM parents WHERE student_id IN (${marks(frontier.length)})`;
    frontier = db.prepare(`
      SELECT DISTINCT p.student_id FROM parents p
      WHERE p.schoology_uid IN (SELECT schoology_uid FROM (${own}) WHERE schoology_uid <> '')
         OR ${SQL_EMAIL_KEY('p.email')} IN (SELECT ${SQL_EMAIL_KEY('email')} FROM (${own}) WHERE ${SQL_EMAIL_KEY('email')} <> '')
    `).all(...frontier, ...frontier).map((r) => r.student_id).filter((sid) => !known.has(sid));
    for (const sid of frontier) known.add(sid);
  }
  const decide = [...known];

  const q = marks(decide.length);
  const parents = db.prepare(`SELECT id, student_id, schoology_uid, first_name, last_name, email, extra_email, phone
    FROM parents WHERE student_id IN (${q}) ORDER BY id`).all(...decide);
  const slotRows = db.prepare(`SELECT student_id, slot, name, email, phone FROM student_ps_guardians WHERE student_id IN (${q})`).all(...decide);
  const psRows = db.prepare(`SELECT student_id, guardians_synced_at, dnc_g1, dnc_g2, g1_deceased, g2_deceased, correspondence
    FROM student_powerschool WHERE student_id IN (${q})`).all(...decide);
  const ps = new Map(psRows.map((r) => [r.student_id, r]));
  const slots = new Map();
  for (const r of slotRows) (slots.get(r.student_id) ?? slots.set(r.student_id, {}).get(r.student_id))[r.slot] = { name: r.name, email: r.email, phone: r.phone };
  const parentsOf = new Map();
  for (const p of parents) (parentsOf.get(p.student_id) ?? parentsOf.set(p.student_id, []).get(p.student_id)).push(p);

  // Per student: place each parent, then decide from that student's own record.
  const decided = new Map();
  for (const sid of decide) {
    const row = ps.get(sid);
    const byParent = decideParents({
      checked: row?.guardians_synced_at != null, parents: parentsOf.get(sid) || [],
      slots: slots.get(sid) || {}, flags: row || {}, correspondence: row?.correspondence,
    });
    for (const [id, contact] of byParent) decided.set(id, contact);
  }

  // Across students: group rows linked by a uid or an email (union-find), then give
  // each group its strongest flag.
  const root = new Map(parents.map((p) => [p.id, p.id]));
  const find = (id) => { while (root.get(id) !== id) { root.set(id, root.get(root.get(id))); id = root.get(id); } return id; };
  const byKey = new Map();
  for (const p of parents) {
    for (const key of keysOf(p)) {
      if (byKey.has(key)) root.set(find(p.id), find(byKey.get(key))); else byKey.set(key, p.id);
    }
  }
  const flagOf = new Map();
  for (const p of parents) {
    const { status } = decided.get(p.id);
    const g = find(p.id);
    if ((RANK[flagOf.get(g)] ?? 0) < (RANK[status] ?? 0)) flagOf.set(g, status);
  }

  // Every decided row's final status: its own, or its group's flag when that is stronger.
  const finalOf = new Map();
  for (const p of parents) {
    const own = decided.get(p.id);
    const flag = flagOf.get(find(p.id));
    finalOf.set(p.id, flag && (RANK[own.status] ?? 0) < RANK[flag] ? { status: flag, primary: false, reason: CONTACT_REASONS[flag] } : own);
  }
  const details = new Map(decide.map((sid) => [sid, psDetails(ps.get(sid)?.guardians_synced_at != null, parentsOf.get(sid) || [], slots.get(sid) || {})]));

  // Addresses and numbers held by a do_not_contact or deceased guardian (controller's
  // rulings, #173): a flagged row's Schoology email, extra email and PowerSchool email,
  // its extra phone and PowerSchool phone, and the email and phone of every flagged slot
  // on a decided student's record, whether or not a parent is placed in it. No guardian's
  // address or number in these sets is copied or linked: two guardians can share a family
  // mailbox or a home phone, and a flagged one must not be reached through the other.
  const blocked = new Set();
  const blockedPhones = new Set();
  const block = (email) => { if (emailKey(email)) blocked.add(emailKey(email)); };
  const blockPhone = (phone) => { if (phoneKey(phone)) blockedPhones.add(phoneKey(phone)); };
  for (const p of parents) {
    if (!RANK[finalOf.get(p.id).status]) continue;
    const psOf = details.get(p.student_id).get(p.id);
    block(p.email); block(p.extra_email); block(psOf?.email);
    blockPhone(p.phone); blockPhone(psOf?.phone);
  }
  for (const sid of decide) {
    const flags = ps.get(sid) || {};
    for (const slot of [1, 2]) {
      if (isFlagged(flags[`dnc_g${slot}`]) || isFlagged(flags[`g${slot}_deceased`])) {
        block(slots.get(sid)?.[slot]?.email);
        blockPhone(slots.get(sid)?.[slot]?.phone);
      }
    }
  }
  const open = (email) => !!emailKey(email) && !blocked.has(emailKey(email));
  const openPhone = (phone) => !!phoneKey(phone) && !blockedPhones.has(phoneKey(phone));

  for (const sid of ids) {
    const byParent = new Map();
    for (const p of parentsOf.get(sid) || []) {
      const contact = finalOf.get(p.id);
      const psOf = details.get(sid).get(p.id) ?? null;
      const email = [psOf?.email, p.email].find(open) ?? ([psOf?.email, p.email].find((e) => emailKey(e)) || null);
      const copy = [];
      const tel = [];
      if (contact.status === 'contactable') {
        for (const e of [email, p.extra_email]) if (open(e) && !copy.some((c) => emailKey(c) === emailKey(e))) copy.push(e);
        for (const n of [psOf?.phone, p.phone]) if (openPhone(n) && !tel.some((t) => phoneKey(t) === phoneKey(n))) tel.push(n);
      }
      byParent.set(p.id, { ...contact, ps: psOf, email, copy, tel });
    }
    out.set(sid, { guardiansSyncedAt: ps.get(sid)?.guardians_synced_at ?? null, byParent });
  }
  return out;
}
