// Counselors' emails (#190). PowerSchool's counselor read has names and no email, so each counselor is matched to one
// person in the student's Schoology Advisors row (GET /user/{uid}/info, plain HTTP on the saved session) by name
// (lib/psCounselors.js matchAdvisor), and that person's REST profile gives the email (6 of 6 on 28/10/2026). A
// counselor is the same PowerSchool user for many students, so an email found once is copied to every row of that
// user, and a student's page is read only while one of their counselors is still unknown. A match tried and not
// found is not tried again (email_checked_at) until the counselors are read again next school year.
import { advisorUids, matchAdvisor } from '../lib/psCounselors.js';

export const COUNSELOR_PAGES_PER_RUN = 50;

// Copy each email already matched to the other rows of the same PowerSchool user. → rows filled.
export function copyKnownEmails(db, now = new Date()) {
  return db.prepare(`UPDATE student_counselors AS c
      SET email = k.email, schoology_uid = k.schoology_uid, email_checked_at = ?
      FROM (SELECT ps_user_dcid, MAX(email) AS email, MAX(schoology_uid) AS schoology_uid FROM student_counselors
            WHERE email IS NOT NULL GROUP BY ps_user_dcid) AS k
      WHERE c.ps_user_dcid = k.ps_user_dcid AND c.email IS NULL`).run(now.toISOString()).changes;
}

/**
 * Fill the counselors' emails. `readInfoPage(uid)` → the Info page HTML of a Schoology user; `getProfiles(uids)` →
 * Map uid → REST profile (schoology.getUserProfilesBatch). → { copied, pages, matched, unmatched, failed }.
 */
export async function fillCounselorEmails(db, { readInfoPage, getProfiles, log = () => {}, now = new Date(), cap = COUNSELOR_PAGES_PER_RUN } = {}) {
  const at = now.toISOString();
  const out = { copied: copyKnownEmails(db, now), pages: 0, matched: 0, unmatched: 0, failed: 0 };
  const due = db.prepare(`SELECT DISTINCT s.id, s.schoology_uid FROM student_counselors c JOIN students s ON s.id = c.student_id
      WHERE c.email IS NULL AND c.email_checked_at IS NULL AND s.schoology_uid IS NOT NULL ORDER BY s.id`).all();
  const open = db.prepare('SELECT ps_user_dcid, first_name, last_name FROM student_counselors WHERE student_id = ? AND email IS NULL AND email_checked_at IS NULL');
  const set = db.prepare('UPDATE student_counselors SET email = ?, schoology_uid = ?, email_checked_at = ? WHERE student_id = ? AND ps_user_dcid = ?');
  const tried = db.prepare('UPDATE student_counselors SET email_checked_at = ? WHERE student_id = ? AND ps_user_dcid = ?');
  const profiles = new Map();
  for (const st of due) {
    const rows = open.all(st.id); // an earlier student's match may have filled these already
    if (!rows.length) continue;
    if (out.pages >= cap) break;
    let uids;
    try {
      out.pages += 1;
      uids = advisorUids(await readInfoPage(st.schoology_uid));
      const missing = uids.filter((u) => !profiles.has(u));
      if (missing.length) for (const [uid, p] of await getProfiles(missing)) profiles.set(String(uid), p);
    } catch (err) {
      if (err?.code === 'SESSION_EXPIRED') throw err;
      out.failed += 1;
      log(`Counselor emails: one student's Schoology page not read (${err.message})`);
      continue;
    }
    const advisors = uids.map((u) => profiles.get(u)).filter(Boolean);
    for (const r of rows) {
      const hit = matchAdvisor({ firstName: r.first_name, lastName: r.last_name }, advisors);
      if (hit?.primary_email) {
        set.run(hit.primary_email, String(hit.uid ?? hit.id ?? ''), at, st.id, r.ps_user_dcid);
        out.matched += 1;
      } else {
        tried.run(at, st.id, r.ps_user_dcid);
        out.unmatched += 1;
      }
    }
    out.copied += copyKnownEmails(db, now);
  }
  if (out.pages || out.copied) log(`Counselor emails: ${out.matched} matched from ${out.pages} Schoology pages, ${out.copied} copied${out.unmatched ? `, ${out.unmatched} not matched` : ''}${out.failed ? `, ${out.failed} pages failed` : ''}.`);
  return out;
}
