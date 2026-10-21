/**
 * psAlertsSync.js — read each active course's students' PowerSchool alerts
 * (#117): accommodation and learning-support plans, health alerts and a few
 * others (server/lib/psAlerts.js ALERT_DEFS), plus the raw guardian-contact
 * fields that decide which parents the copies leave out (#66: do-not-contact,
 * deceased, the correspondence code). Behind the
 * powerschool_alerts feature.
 *
 * Plain HTTP, no browser (#141): the PowerSchool session comes from the attendance
 * LTI launch (server/services/powerschoolWeb.js), then per section:
 *   getStudentsInSection.json → roster (studentid, studentdcid)
 *   stuFieldValues.json       → the student-field values the sf alerts test
 *   getAdvTriggerMatches.html → one read per kept advanced alert
 *   getAlerts.json            → manual alerts (when a kept one exists)
 * The alert catalogue (getAlertTypes.json) is read once per sync, so the trigger
 * rules are PowerSchool's current ones, never a copy.
 * Then, once the section's alerts are read, its Emergency Contact List (#66): GET
 * /teachers/home.html, then /teachers/StudEmgContacts.html?sectionid= with home as the
 * Referer (the click path PowerTeacher expects), joined to the roster by name
 * (server/lib/psEmergencyContacts.js) into each student's two guardian slots.
 *
 * Fresh every sync, reconciled per student: a student read this sync gets exactly
 * the alerts that fire now (cleared ones go). A section that fails keeps its
 * students' last-known alerts. The guardian slots follow the same rule, separately: a
 * list that fails to read (or a student it cannot match) keeps the last-known slots,
 * and the section's alerts are still stored. Students without an active course are not
 * read and keep theirs (their alerts_synced_at shows how old they are).
 *
 * See .claude/powerschool-api-reference.md "Student alerts (#117)".
 */
import { getDb } from '../db/index.js';
import { cookieJar } from './schoologyWeb.js';
import { PowerSchoolWeb } from './powerschoolWeb.js';
import { alertPlan, fieldValuesParams, sectionAlerts, dropMeta } from '../lib/psAlerts.js';
import { parseEmergencyContacts, slotsByDcid } from '../lib/psEmergencyContacts.js';
import { applyPsAlerts, applyPsGuardians } from './psAlertStore.js';

const Q = '/teachers/mba_alerts/queries/';
// PowerSchool school number for the high school; the plugin passes the same.
export const PS_SCHOOL_ID = 40;

const LOGIN_MESSAGE = 'Not logged in to Schoology: run `npm run mastery:login` and retry.';

// One section's reads. Throws on any failed read, so a partial answer never
// clears a student's alerts. → { found: Map<dcid, entry>, roster } (roster rows with a studentdcid).
async function readSection(ps, plan, sectionDcid) {
  const roster = await ps.read(`${Q}getStudentsInSection.json`, { sectionIds: sectionDcid });
  const rows = (Array.isArray(roster) ? roster : []).filter((r) => r && r.studentid != null);
  const ids = rows.map((r) => String(r.studentid));
  if (!ids.length) return { found: new Map(), roster: [] };
  const values = await ps.read(`${Q}stuFieldValues.json`, fieldValuesParams(ids, plan.sf), { method: 'GET' });
  const adv = [];
  for (const type of plan.adv) {
    const path = `${Q}getAdvTriggerMatches.html${type.querystring ? `?${type.querystring}` : ''}`;
    const answer = await ps.read(path, { trigger_url: type.trigger_url, studentIds: ids.join(','), frn: '', querystring: type.querystring || '' });
    adv.push({ type, answer });
  }
  const manual = plan.man.length
    ? dropMeta(await ps.read(`${Q}getAlerts.json`, { typeIds: plan.man.map((t) => t.id).join(','), studentIds: ids.join(',') }))
    : [];
  return { found: sectionAlerts({ plan, roster, values, adv, manual }), roster: rows.filter((r) => r.studentdcid != null) };
}

// A section's Emergency Contact List (#66), read the way a teacher reaches it: home, then
// the list with home as the Referer. → the parsed rows. Throws on a failed read.
async function readGuardianList(ps, sectionDcid) {
  await ps.teacherPage('/teachers/home.html');
  return parseEmergencyContacts(await ps.teacherPage(`/teachers/StudEmgContacts.html?sectionid=${sectionDcid}`, { referer: '/teachers/home.html' }));
}

/**
 * Read every active course's students' alerts. Best-effort per section: a failed
 * section is logged and skipped. Throws only when there is no usable Schoology
 * session (login-recoverable message) or PowerSchool will not start a session.
 *
 * deps: { fetchImpl, jar } for tests. → { processed, read, failed, skipped,
 * students, withAlerts, guardians: { read, failed, students } (sections whose list was read /
 * not read, students given slots), results: [{ courseId, courseName, status, students?, reason? }] }
 */
// `courseIds` (#58): only those courses (a Sync Course or a retry); absent = every active course.
export async function syncPsAlerts({ onProgress, courseIds = null, db = getDb(), deps = {} } = {}) {
  const log = (message) => { console.log(`[psAlertsSync] ${message}`); onProgress?.({ message }); };
  const summary = { processed: 0, read: 0, failed: 0, skipped: 0, students: 0, withAlerts: 0, guardians: { read: 0, failed: 0, students: 0 }, results: [] };
  const courses = db.prepare(`
    SELECT id, schoology_section_id, course_name FROM courses
    WHERE excluded = 0 AND archived = 0 AND schoology_section_id IS NOT NULL
      AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))
    ORDER BY course_name
  `).all(courseIds ? 1 : null, JSON.stringify(courseIds ?? []));
  if (!courses.length) { log('No active courses.'); return summary; }

  const sgyJar = deps.jar ?? cookieJar();
  if (!sgyJar) throw new Error('No Schoology browser session: run `npm run mastery:login` first.');
  const ps = new PowerSchoolWeb({ sgyJar, fetchImpl: deps.fetchImpl ?? fetch });
  const asLogin = (err) => (err?.code === 'SESSION_EXPIRED' ? new Error(LOGIN_MESSAGE) : err);

  let plan = null;
  const byDcid = new Map();
  const guardiansByDcid = new Map();
  for (const c of courses) {
    summary.processed++;
    try {
      const { sectionDcid } = await ps.launchIds(c.schoology_section_id).catch((err) => { throw asLogin(err); });
      if (!sectionDcid) {
        summary.skipped++;
        summary.results.push({ courseId: c.id, courseName: c.course_name, status: 'skipped', reason: 'no-section-dcid' });
        continue;
      }
      if (!ps.launched) {
        log(`Starting the PowerSchool session (via ${c.course_name})...`);
        await ps.launch(c.schoology_section_id).catch((err) => { throw asLogin(err); });
      }
      if (!plan) {
        const read = alertPlan(await ps.read(`${Q}getAlertTypes.json`, { disabled: 0, student_schoolid: PS_SCHOOL_ID }));
        const kept = read.sf.length + read.adv.length + read.man.length;
        // None of Prism's alert ids in the catalogue means PowerSchool's set-up changed:
        // stop rather than clear every student's alerts.
        if (!kept) throw new Error('none of Prism\'s alerts are in the PowerSchool catalogue (see ALERT_DEFS)');
        plan = read;
        log(`Alert catalogue: ${kept} kept alerts.`);
      }
      let section;
      try {
        section = await readSection(ps, plan, sectionDcid);
      } catch (err) {
        if (err.code !== 'PS_SESSION') throw err;
        log(`${c.course_name}: PowerSchool session ended, starting a new one`);
        await ps.launch(c.schoology_section_id).catch((e) => { throw asLogin(e); });
        section = await readSection(ps, plan, sectionDcid);
      }
      const { found, roster } = section;
      for (const [dcid, entry] of found) byDcid.set(dcid, entry);
      if (roster.length) {
        // Its own try: a list that will not read costs the guardians, never the alerts just read.
        try {
          let list;
          try {
            list = await readGuardianList(ps, sectionDcid);
          } catch (err) {
            if (!err.sessionEnded) throw err;
            log(`${c.course_name}: PowerSchool session ended, starting a new one`);
            await ps.launch(c.schoology_section_id).catch((e) => { throw asLogin(e); });
            list = await readGuardianList(ps, sectionDcid);
          }
          for (const [dcid, slots] of slotsByDcid(list, roster)) guardiansByDcid.set(dcid, slots);
          summary.guardians.read++;
        } catch (err) {
          if (err.message === LOGIN_MESSAGE || err.code === 'PS_SECURITY') throw err;
          summary.guardians.failed++;
          log(`${c.course_name}: guardians not read (${err.message}), kept the last ones`);
        }
      }
      summary.read++;
      summary.results.push({ courseId: c.id, courseName: c.course_name, status: 'read', students: found.size });
      log(`${c.course_name}: ${found.size} students read`);
    } catch (err) {
      if (err.message === LOGIN_MESSAGE || err.code === 'PS_SECURITY') throw err; // a security page stops the sync
      summary.failed++;
      summary.results.push({ courseId: c.id, courseName: c.course_name, status: 'failed', reason: err.message });
      log(`${c.course_name}: not read (${err.message}), kept the last alerts`);
    }
  }

  if (summary.read === 0 && summary.failed > 0) {
    throw new Error(`PowerSchool alerts not read: ${summary.results.find((r) => r.status === 'failed')?.reason}`);
  }
  if (!plan) { log('No course has a PowerSchool section.'); return summary; }
  const idByKey = new Map([...plan.sf, ...plan.adv, ...plan.man].map((t) => [t.def.key, String(t.id)]));
  const applied = applyPsAlerts(db, byDcid, { idByKey });
  summary.students = applied.students;
  summary.withAlerts = applied.withAlerts;
  summary.guardians.students = applyPsGuardians(db, guardiansByDcid).students;
  log(`Done: ${applied.students} students read, ${applied.withAlerts} with alerts (${summary.failed} courses not read), ${summary.guardians.students} with guardians (${summary.guardians.failed} lists not read).`);
  return summary;
}
