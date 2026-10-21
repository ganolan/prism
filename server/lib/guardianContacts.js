/**
 * guardianContacts.js — may Prism copy this parent's address? (#66)
 *
 * PowerSchool holds two guardian slots per student (the Emergency Contact List,
 * server/lib/psEmergencyContacts.js) and per-slot flags on the student record
 * (X_DNC_G1/G2, X_G1DECEASED/X_G2DECEASED, X_HOMEEMAIL; server/lib/psAlerts.js
 * CONTACT_FIELDS). Schoology's `parents` rows carry no slot, so each parent is
 * first placed in a slot, then given a status. Decided at read time, so a parent
 * Schoology adds between PowerSchool reads is "not matched" until a read holds them.
 * decideParents does both for one student, and gives a flagged slot that no parent is
 * placed in to every parent it could be.
 *
 * Fail safe throughout: when Prism cannot tell, the parent is not contactable.
 * Spec: docs/superpowers/specs/2026-10-21-do-not-contact-guardians-design.md "Decide".
 */

export const CONTACT_REASONS = {
  do_not_contact: 'Do not contact (PowerSchool)',
  deceased: 'Deceased (PowerSchool)',
  not_matched: 'Not matched to a PowerSchool guardian',
  not_checked: 'Not checked against PowerSchool yet',
};

const SLOTS = [1, 2];

// An email as compared everywhere in #66: trimmed, any case. '' when there is none.
export const emailKey = (email) => (email == null ? '' : String(email).trim().toLowerCase());
const words = (text) => (text == null ? [] : String(text).toLowerCase().match(/\p{L}+/gu) || []);

// PowerSchool shows a slot's name as `Last, First`. A parent matches a slot by name
// when every word of their last name is in the part before the comma and a word of
// their first name is in the part after it. No last-name word, or no comma, never
// matches.
function nameMatches(parent, slotName) {
  const text = slotName == null ? '' : String(slotName);
  const comma = text.indexOf(',');
  if (comma < 0) return false;
  const before = new Set(words(text.slice(0, comma)));
  const after = new Set(words(text.slice(comma + 1)));
  const last = words(parent.last_name);
  return last.length > 0 && last.every((w) => before.has(w)) && words(parent.first_name).some((w) => after.has(w));
}

/**
 * Place each parent in a PowerSchool slot. parents: [{ id, first_name, last_name, email }];
 * slots: { 1?: { name, email }, 2?: { name, email } }. → Map<parentId, 1 | 2 | null>.
 *
 * 1. Their email (trimmed, any case) equals exactly one slot's email.
 * 2. Otherwise their name matches exactly one slot (nameMatches), and no parent took
 *    that slot by email. A name that matches both slots is not placed, even when one
 *    of them is taken by email: the name alone cannot tell the two apart.
 * 3. Two parents placed in one slot by name are both not placed.
 */
export function placeParents(parents, slots = {}) {
  const out = new Map();
  const byEmail = new Set();
  const pending = [];
  for (const p of parents) {
    const key = emailKey(p.email);
    const hits = key ? SLOTS.filter((s) => slots?.[s] && emailKey(slots[s].email) === key) : [];
    if (hits.length === 1) { out.set(p.id, hits[0]); byEmail.add(hits[0]); } else pending.push(p);
  }
  const byName = new Map(SLOTS.map((s) => [s, []]));
  for (const p of pending) {
    out.set(p.id, null);
    const hits = SLOTS.filter((s) => slots?.[s] && nameMatches(p, slots[s].name));
    if (hits.length === 1 && !byEmail.has(hits[0])) byName.get(hits[0]).push(p.id);
  }
  for (const [slot, ids] of byName) if (ids.length === 1) out.set(ids[0], slot);
  return out;
}

// "Any value" is deliberately wider than the catalogue's `in 1`: an unexpected value
// is a flag (fail safe). Only null and '' mean not set.
const isSet = (v) => v != null && String(v) !== '';

/**
 * A placed parent's status; the first rule that applies decides.
 * → { status: 'not_checked' | 'not_matched' | 'do_not_contact' | 'deceased' | 'contactable', primary }.
 * primary: contactable and X_HOMEEMAIL names this slot alone ('1' or '2').
 */
export function statusFor({ checked, slot, flags = {}, correspondence }) {
  if (!checked) return { status: 'not_checked', primary: false };
  if (slot !== 1 && slot !== 2) return { status: 'not_matched', primary: false };
  if (isSet(flags[`dnc_g${slot}`])) return { status: 'do_not_contact', primary: false };
  if (isSet(flags[`g${slot}_deceased`])) return { status: 'deceased', primary: false };
  const code = correspondence == null ? '' : String(correspondence).trim();
  return { status: 'contactable', primary: (code === '1' || code === '2') && code === String(slot) };
}

// Stronger first: a parent with both flags (from two slots, or two children) is do_not_contact.
export const FLAG_RANK = { do_not_contact: 2, deceased: 1 };
const rank = (status) => FLAG_RANK[status] ?? 0;
const slotFlag = (flags, slot) => (isSet(flags[`dnc_g${slot}`]) ? 'do_not_contact' : isSet(flags[`g${slot}_deceased`]) ? 'deceased' : null);

// The reason for a parent who takes the flag of a slot no parent is placed in.
export const uncertainReason = (slot, status) => `${CONTACT_REASONS.not_matched}. Guardian ${slot} is flagged: ${CONTACT_REASONS[status]}`;

/**
 * Every parent of one student: Map<parentId, { status, primary, reason, uncertain? }>.
 * checked = the student has a guardian read; slots and parents as placeParents; flags and
 * correspondence from student_powerschool. reason = CONTACT_REASONS[status], null for
 * contactable.
 *
 * A flagged slot with no parent in it (controller's ruling, 21 October 2026): when slot N
 * is flagged (dnc_gN or gN_deceased, any value) and no parent is uniquely placed in N,
 * the flagged guardian may be any parent Prism could not place. So every parent not
 * uniquely placed in an unflagged slot takes N's flag, with `uncertain: true` and
 * uncertainReason. Two parents placed in one slot by a shared email are not uniquely
 * placed. do_not_contact wins over deceased when both slots qualify (slot 1 wins a tie),
 * and a parent's own flag wins when it is as strong. A student with flags but no guardian
 * read has no placed parents, so all of them take the strongest flag this way.
 */
export function decideParents({ checked, parents, slots = {}, flags = {}, correspondence }) {
  const placed = checked ? placeParents(parents, slots) : new Map();
  const inSlot = new Map(SLOTS.map((s) => [s, 0]));
  for (const slot of placed.values()) if (slot) inSlot.set(slot, inSlot.get(slot) + 1);
  const unique = (slot) => !!slot && inSlot.get(slot) === 1;

  let open = null; // { slot, status }: the strongest flagged slot no parent is uniquely placed in
  for (const slot of SLOTS) {
    const status = slotFlag(flags, slot);
    if (status && !unique(slot) && rank(status) > rank(open?.status)) open = { slot, status };
  }

  const out = new Map();
  for (const p of parents) {
    const slot = placed.get(p.id) ?? null;
    const { status, primary } = statusFor({ checked, slot, flags, correspondence });
    const clear = unique(slot) && !slotFlag(flags, slot);
    if (open && !clear && rank(status) < rank(open.status)) {
      out.set(p.id, { status: open.status, primary: false, reason: uncertainReason(open.slot, open.status), uncertain: true });
    } else {
      out.set(p.id, { status, primary, reason: CONTACT_REASONS[status] ?? null });
    }
  }
  return out;
}
