import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { fakePowerSchoolWeb } from '../testing/fakePowerSchoolWeb.js';
import { SUPPORT_SUMMARY_HTML } from '../lib/parseSupportSummary.js';
import { readSupportSummary, SupportSummaryError, clearSupportSummaryCache } from './psSupportSummary.js';

let db;
let studentId;
const NOW = Date.parse('2026-10-18T10:00:00Z');

function seed({ alert = true, archived = 0, schoolUid = '1_5001' } = {}) {
  db = new Database(':memory:');
  migrate(db);
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('S1', 'AP CSP', ?)`).run(archived).lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, school_uid) VALUES ('u1', 'A', 'B', ?)`).run(schoolUid).lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(studentId, courseId);
  if (alert) db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key, ps_alert_id) VALUES (?, 'support_summary', '11290981')`).run(studentId);
}

const web = (over = {}) => fakePowerSchoolWeb({
  sections: { 9001: [{ studentid: '41001', studentdcid: '5001' }] },
  popups: { 5001: SUPPORT_SUMMARY_HTML },
  ...over,
});
const deps = (w) => ({ jar: w.jar, fetchImpl: w.fetchImpl, now: () => NOW });

beforeEach(() => { clearSupportSummaryCache(); seed(); });

describe('readSupportSummary (on demand)', () => {
  test('launches through the student\'s live course, finds them on the roster, opens the pop-up as the alert icon does', async () => {
    const w = web();
    const r = await readSupportSummary(db, studentId, deps(w));
    expect(r.rows).toHaveLength(9);
    expect(r.rows[8]).toEqual({ category: 'Support Notes', description: '25% extra time on tests & quizzes; seat near the front.' });
    expect(r.readAt).toBe('2026-10-18T10:00:00.000Z');
    const popup = w.requests.find((q) => q.path === '/teachers/alerts/aet_customalert_custompopup.html');
    expect(popup.params).toMatchObject({ url: 'mbapop_studentsupportsummary.html', frn: '0015001', id: '11290981', studentid: '41001' });
    expect(popup.referer).toBe('https://powerschool.hkis.edu.hk/integrations/attendance/index.html');
    expect(popup.xhr).toBe('XMLHttpRequest');
  });

  test('a second read within 10 minutes comes from the cache; later, from PowerSchool again', async () => {
    const w = web();
    let t = NOW;
    const d = { ...deps(w), now: () => t };
    await readSupportSummary(db, studentId, d);
    const before = w.requests.length;
    expect((await readSupportSummary(db, studentId, d)).readAt).toBe('2026-10-18T10:00:00.000Z');
    expect(w.requests.length).toBe(before);
    t += 10 * 60 * 1000 + 1;
    await readSupportSummary(db, studentId, d);
    expect(w.requests.length).toBeGreaterThan(before);
  });

  test('no Support Summary alert: refused before any request', async () => {
    seed({ alert: false });
    const w = web();
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'NO_ALERT' });
    expect(w.requests).toEqual([]);
  });

  test('no current course, or no PowerSchool link: refused before any request', async () => {
    seed({ archived: 1 });
    const w = web();
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'NO_COURSE' });
    seed({ schoolUid: null });
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'NOT_LINKED' });
    expect(w.requests).toEqual([]);
  });

  test('a Security Violation page stops the read and is never parsed', async () => {
    const w = web({ popups: { 5001: '<html><body><h1>Security Violation Logged</h1></body></html>' } });
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
  });

  test('not on the section roster: NOT_ON_ROSTER, no pop-up read', async () => {
    const w = web({ sections: { 9001: [{ studentid: '41999', studentdcid: '5999' }] } });
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'NOT_ON_ROSTER' });
    expect(w.requests.some((q) => q.path.endsWith('custompopup.html'))).toBe(false);
  });

  test('Schoology sends the launch to sign-in: SESSION_EXPIRED', async () => {
    const w = web({ loginRedirect: true });
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toBeInstanceOf(SupportSummaryError);
    await expect(readSupportSummary(db, studentId, deps(w))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
