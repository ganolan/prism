// PowerTeacher's Demographics screen for each current student (#191, Graham 28/10/2026): the date of birth, PowerSchool's
// Graduation Year (authoritative for grad_year), the home room and the guardianship note. Over plain HTTP on the alert
// sync's PowerSchool session, never a browser. Read once per student per school year: a student read since this
// school year began (1 August) is not read again, so the first night reads the whole roster and later nights only
// new students.
//
// The page must be reached as a teacher clicks to it, or PowerSchool logs a security violation (AGENTS.md, #116):
// per section home.html → summary.html, then per student menu.html → studentpages/home.html → demo.html, each with
// the previous page as Referer. A "Security Violation Logged" page throws PS_SECURITY, which stops the sync.
//
// Integrity: a page is stored only when its Student number is the student's own number (the local part of their
// school email; 3 of 3 on 28/10/2026); a student Prism holds no email for is not stored. Address and every other
// row are never stored.
//
// #190: on the same visit, once the page is the student's own, the counselor icon's read: GET
// /ws/studentcounselor/{dcid} with the Demographics page as Referer (the student's 2 counselors, one primary), also
// once per school year (counselors_read_at). Stored in student_counselors; their emails come later from Schoology
// (counselorEmails.js). The same PowerSchool service also saves counselors (POSTs): never sent.
import { parseDemographics } from '../lib/psDemographics.js';
import { parseCounselors } from '../lib/psCounselors.js';
import { currentSchoolYearEndYear } from '../lib/psGradeLevel.js';

export const DEMOGRAPHICS_PER_RUN = 200; // a bound on one night's page reads (about 150 current students on 28/10/2026)
const PAUSE_MS = 400;

// The first day of the current school year, 'YYYY-08-01'.
export function schoolYearStart(now = new Date()) {
  return `${currentSchoolYearEndYear(now) - 1}-08-01`;
}

// The current students of these sections who need a read: none yet, or none since the school year began, of the
// Demographics page or of the counselors. `sections`: [{ sectionDcid, roster: [{ studentdcid }] }].
// → [{ sectionDcid, students: [{ id, dcid, number, demographics, counselors }] }] (the last two: which is due).
export function studentsToRead(db, sections, now = new Date(), cap = DEMOGRAPHICS_PER_RUN) {
  const since = schoolYearStart(now);
  const get = db.prepare('SELECT id, email, demographics_read_at, counselors_read_at FROM students WHERE school_uid = ?');
  const seen = new Set();
  let left = cap;
  const out = [];
  for (const s of sections) {
    const students = [];
    for (const r of s.roster || []) {
      const dcid = String(r.studentdcid ?? '');
      if (!dcid || seen.has(dcid) || left <= 0) continue;
      const st = get.get(`1_${dcid}`);
      if (!st) continue;
      const demographics = !(st.demographics_read_at && st.demographics_read_at >= since);
      const counselors = !(st.counselors_read_at && st.counselors_read_at >= since);
      if (!demographics && !counselors) continue;
      seen.add(dcid);
      left -= 1;
      students.push({ id: st.id, dcid, number: st.email ? String(st.email).split('@')[0] : null, demographics, counselors });
    }
    if (students.length) out.push({ sectionDcid: s.sectionDcid, students });
  }
  return out;
}

// Store one student's page. → true when stored.
export function storeDemographics(db, studentId, page, now = new Date()) {
  db.prepare(`UPDATE students SET date_of_birth = ?, ps_grad_year = ?, grad_year = COALESCE(?, grad_year),
      home_room = ?, guardianship = ?, demographics_read_at = ?, updated_at = ? WHERE id = ?`)
    .run(page.dateOfBirth, page.graduationYear, page.graduationYear, page.homeRoom, page.guardianship, now.toISOString(), now.toISOString(), studentId);
  return true;
}

// Store one student's counselors (from parseCounselors), replacing the last list. A counselor still on the list keeps
// the email Prism matched for them. → the number stored.
export function storeCounselors(db, studentId, list, now = new Date()) {
  const at = now.toISOString();
  db.transaction(() => {
    const keep = list.map((c) => c.userDcid);
    db.prepare(`DELETE FROM student_counselors WHERE student_id = ? AND ps_user_dcid NOT IN (${keep.map(() => '?').join(',') || "''"})`).run(studentId, ...keep);
    const up = db.prepare(`INSERT INTO student_counselors (student_id, ps_user_dcid, first_name, last_name, is_primary, read_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, ps_user_dcid) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
        is_primary = excluded.is_primary, read_at = excluded.read_at`);
    for (const c of list) up.run(studentId, c.userDcid, c.firstName || null, c.lastName || null, c.isPrimary ? 1 : 0, at);
    db.prepare('UPDATE students SET counselors_read_at = ? WHERE id = ?').run(at, studentId);
  })();
  return list.length;
}

/**
 * Read the Demographics screen of every current student of `sections` who needs it. `ps` is a launched
 * PowerSchoolWeb; `relaunch()` starts a new session when one ends mid-read (one retry per student).
 * Students whose counselors are due also get the counselor read (#190).
 * → { read, stored, mismatched, failed, counselors: { stored, mismatched, failed } }. Throws PS_SECURITY (a security
 * page) at once.
 */
export async function syncDemographics(db, ps, sections, { log = () => {}, relaunch = async () => {}, now = new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const plan = studentsToRead(db, sections, now);
  const out = { read: 0, stored: 0, mismatched: 0, failed: 0, counselors: { stored: 0, mismatched: 0, failed: 0 } };
  if (!plan.length) return out;
  const page = async (path, referer) => { await sleep(PAUSE_MS); return ps.teacherPage(path, { referer }); };
  for (const { sectionDcid, students } of plan) {
    const q = `sectionid=${sectionDcid}&frn=003${sectionDcid}`;
    const summary = `/teachers/summary.html?${q}`;
    const open = async () => { await page('/teachers/home.html'); await page(summary, '/teachers/home.html'); };
    await open();
    for (const st of students) {
      const demo = `/teachers/studentpages/demo.html?frn=001${st.dcid}&sectionid=${sectionDcid}`;
      const visit = async () => {
        const menu = `/teachers/menu.html?${q}`;
        const home = `/teachers/studentpages/home.html?ac=laststudpage&sectionid=${sectionDcid}&frn=001${st.dcid}`;
        await page(menu, summary);
        await page(home, menu);
        return page(demo, home);
      };
      let html;
      try {
        try {
          html = await visit();
        } catch (err) {
          if (!err?.sessionEnded) throw err;
          await relaunch();
          await open();
          html = await visit();
        }
      } catch (err) {
        if (err?.code === 'PS_SECURITY') throw err;
        out.failed += 1;
        log(`Demographics: one student not read (${err.message})`);
        continue;
      }
      out.read += 1;
      const parsed = parseDemographics(html);
      if (!parsed.found || !st.number || parsed.studentNumber !== st.number) {
        out.mismatched += 1; // not this student's page, not the page, or nothing to check it by: nothing stored
        continue;
      }
      if (st.demographics !== false) {
        storeDemographics(db, st.id, parsed, now);
        out.stored += 1;
      }
      if (st.counselors === false) continue;
      // The counselor icon's read, as its click sends it from this page. A failure keeps the last list and the student
      // is read again next night; the Demographics just stored stay.
      try {
        await sleep(PAUSE_MS);
        const list = parseCounselors(await ps.teacherJson(`/ws/studentcounselor/${st.dcid}`, { referer: demo }), st.dcid);
        if (!list) { out.counselors.mismatched += 1; continue; }
        storeCounselors(db, st.id, list, now);
        out.counselors.stored += 1;
      } catch (err) {
        if (err?.code === 'PS_SECURITY') throw err;
        out.counselors.failed += 1;
        log(`Counselors: one student not read (${err.message})`);
      }
    }
  }
  const c = out.counselors;
  log(`Demographics: ${out.stored} students stored, ${out.read} pages read${out.mismatched ? `, ${out.mismatched} not matched` : ''}${out.failed ? `, ${out.failed} failed` : ''}; counselors stored for ${c.stored}${c.mismatched ? `, ${c.mismatched} not matched` : ''}${c.failed ? `, ${c.failed} failed` : ''}.`);
  return out;
}
