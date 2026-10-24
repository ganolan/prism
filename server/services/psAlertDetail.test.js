import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { fakePowerSchoolWeb, CATALOGUE } from '../testing/fakePowerSchoolWeb.js';
import { SUPPORT_SUMMARY_HTML } from '../lib/parseSupportSummary.js';
import { clearSupportSummaryCache } from './psSupportSummary.js';
import { readAlertDetail, parseAlertPopup, clearAlertDetailCache } from './psAlertDetail.js';

// Pop-ups in the probed shapes (.claude/powerschool-api-reference.md "Alert pop-up shapes"), with
// made-up text.
const SPP_EMPTY = '<p style="margin-left:10px">\n</p>'; // the 77-byte shape, nothing between the tags
const SPP_SENTENCE = '<p style="margin-left:10px">This student has an accommodation plan on file.</p>';
const SPP_TIME = '<p style="margin-left:10px">Extra time: 25% on tests and quizzes.</p>';
const NO_PHOTO = '<p>Line one of the notice.<br>Line two of the notice.<br>Line three &amp; last.</p>';
const ALLERGIES = `<div><table><thead><tr><th>Allergy Type</th><th>Allergen</th><th>Treatment</th></tr></thead><tbody>
<tr><td>Food</td><td>Peanut</td><td></td></tr>
<tr><td>Insect</td><td>Wasp</td><td>Antihistamine</td></tr></tbody></table></div>`;
const NOT_A_TABLE = '<div><h4>Something new</h4><ul><li>Item one</li><li>Item two</li></ul></div>';

const STUBS = {
  10593860: 'mbapop_spp.html', 10593856: 'mbapop_nophoto.html', 10593855: 'mbapop_allergies.html',
  10593828: 'mbapop_epipen.html', 10593862: 'mbapop_ls1.html',
};
const noPhoto = { id: '10593856', trigger_type: 'sf', disabled: '0', name: 'No Photo', student_field: 'U_Students_Extension.X_PublicityNotice', ext_table_name: 'U_DEF_EXT_STUDENTS', querystring: '', trigger_url: '' };
const elevator = { ...noPhoto, id: '10672527', name: 'Elevator Alert', stub_url: '' };
const catalogue = [noPhoto, elevator, ...CATALOGUE].map((t) => (STUBS[t.id] ? { ...t, stub_url: STUBS[t.id] } : t));

const NOW = Date.parse('2026-10-25T10:00:00Z');
let db;
let studentId;

function seed(alerts) {
  db = new Database(':memory:');
  migrate(db);
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'AP CSP')`).run().lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, school_uid) VALUES ('u1', 'A', 'B', '1_5001')`).run().lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(studentId, courseId);
  for (const k of alerts) db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key, ps_alert_id) VALUES (?, ?, 'x')`).run(studentId, k);
}
const web = (popup) => fakePowerSchoolWeb({ catalogue, sections: { 9001: [{ studentid: '41001', studentdcid: '5001' }] }, popups: popup === undefined ? {} : { 5001: popup } });
const deps = (w, now = () => NOW) => ({ jar: w.jar, fetchImpl: w.fetchImpl, now });
const popupRequests = (w) => w.requests.filter((q) => q.path.endsWith('custompopup.html'));

beforeEach(() => { clearAlertDetailCache(); clearSupportSummaryCache(); });

describe('parseAlertPopup', () => {
  test('a Category | Description table gives rows, with a link kept', () => {
    const d = parseAlertPopup(SUPPORT_SUMMARY_HTML);
    expect(d.kind).toBe('rows');
    expect(d.rows).toHaveLength(9);
    expect(d.rows[7]).toEqual({ category: 'Support Plan URL', description: 'Open plan', url: 'https://example.org/plan' });
  });
  test('a wider table pairs each header with its cell, leaves blanks out and numbers the body rows', () => {
    expect(parseAlertPopup(ALLERGIES).rows).toEqual([
      { category: 'Allergy Type', description: 'Food', group: 1 }, { category: 'Allergen', description: 'Peanut', group: 1 },
      { category: 'Allergy Type', description: 'Insect', group: 2 }, { category: 'Allergen', description: 'Wasp', group: 2 },
      { category: 'Treatment', description: 'Antihistamine', group: 2 },
    ]);
  });
  test('a table with no header cells takes its first row as headers when it is not two columns wide', () => {
    const d = parseAlertPopup('<table><tr><td>A</td><td>B</td><td>C</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>');
    expect(d.rows).toEqual([{ category: 'A', description: '1' }, { category: 'B', description: '2' }, { category: 'C', description: '3' }]);
  });
  test('text lines, one per paragraph or break; no table is assumed', () => {
    expect(parseAlertPopup(NO_PHOTO)).toEqual({ kind: 'text', text: 'Line one of the notice.\nLine two of the notice.\nLine three & last.' });
    expect(parseAlertPopup(NOT_A_TABLE)).toEqual({ kind: 'text', text: 'Something new\nItem one\nItem two' });
  });
  test('nothing visible is kind none', () => {
    expect(parseAlertPopup(SPP_EMPTY)).toEqual({ kind: 'none' });
    expect(parseAlertPopup('<script>var x = 1;</script>')).toEqual({ kind: 'none' });
    expect(parseAlertPopup('')).toEqual({ kind: 'none' });
  });
});

describe('readAlertDetail', () => {
  test('parses a readable pop-up into rows, opened as the alert icon does with the catalogue stub and the sf extras', async () => {
    seed(['allergies']);
    const w = web(ALLERGIES);
    const r = await readAlertDetail(db, studentId, 'allergies', deps(w));
    expect(r).toMatchObject({ alertKey: 'allergies', kind: 'rows', suggestedPercent: null, readAt: '2026-10-25T10:00:00.000Z' });
    expect(r.rows[0]).toEqual({ category: 'Allergy Type', description: 'Food', group: 1 });
    const [popup] = popupRequests(w);
    expect(popup.params).toMatchObject({ url: 'mbapop_allergies.html', frn: '0015001', id: '10593855', studentid: '41001' });
    expect(popup.referer).toBe('https://powerschool.hkis.edu.hk/integrations/attendance/index.html');
    expect(popup.xhr).toBe('XMLHttpRequest');
  });

  test('a text pop-up is kind text', async () => {
    seed(['no_photo']);
    const r = await readAlertDetail(db, studentId, 'no_photo', deps(web(NO_PHOTO)));
    expect(r).toMatchObject({ kind: 'text', text: 'Line one of the notice.\nLine two of the notice.\nLine three & last.', suggestedPercent: null });
  });

  test('an sf alert\'s link carries its field and table', async () => {
    seed(['epipen']);
    const w = web('<p>Carries an EpiPen.</p>');
    await readAlertDetail(db, studentId, 'epipen', deps(w));
    expect(popupRequests(w)[0].params).toMatchObject({ url: 'mbapop_epipen.html', mba_frn: '0015001', student_field: 'U_DEF_EXT_STUDENTS.X_ALLERGYEPI', tableName: 'U_DEF_EXT_STUDENTS' });
  });

  test('returns kind none for an empty pop-up', async () => {
    seed(['no_photo']);
    const r = await readAlertDetail(db, studentId, 'no_photo', deps(web(SPP_EMPTY)));
    expect(r).toMatchObject({ alertKey: 'no_photo', kind: 'none', suggestedPercent: null });
    expect(r).not.toHaveProperty('rows');
    expect(r).not.toHaveProperty('text');
  });

  test('an alert with no stub_url in the catalogue is kind none after no pop-up read', async () => {
    seed(['elevator']);
    const w = web(NO_PHOTO);
    const r = await readAlertDetail(db, studentId, 'elevator', deps(w));
    expect(r.kind).toBe('none');
    expect(popupRequests(w)).toEqual([]);
  });

  test('mobility is kind none without any request', async () => {
    seed(['mobility']);
    const w = web();
    expect((await readAlertDetail(db, studentId, 'mobility', deps(w))).kind).toBe('none');
    expect(w.requests).toEqual([]);
  });

  test('a learning alert uses the Support Summary when the student holds it', async () => {
    seed(['accommodation_plan', 'support_summary']);
    const w = web(SUPPORT_SUMMARY_HTML);
    const r = await readAlertDetail(db, studentId, 'accommodation_plan', deps(w));
    expect(r.kind).toBe('rows');
    expect(r.rows).toHaveLength(9);
    expect(r.suggestedPercent).toBe(25);
    const [popup] = popupRequests(w);
    expect(popup.params.url).toBe('mbapop_studentsupportsummary.html');
    expect(popupRequests(w)).toHaveLength(1);
  });

  test('a learning alert without the Support Summary reads the plan pop-up, else kind none', async () => {
    seed(['accommodation_plan']);
    const w = web(SPP_TIME);
    const r = await readAlertDetail(db, studentId, 'accommodation_plan', deps(w));
    expect(r).toMatchObject({ kind: 'text', text: 'Extra time: 25% on tests and quizzes.', suggestedPercent: 25 });
    expect(popupRequests(w)[0].params.url).toBe('mbapop_spp.html');

    clearAlertDetailCache();
    expect((await readAlertDetail(db, studentId, 'accommodation_plan', deps(web(SPP_SENTENCE))))).toMatchObject({ kind: 'text', suggestedPercent: null });
    clearAlertDetailCache();
    expect((await readAlertDetail(db, studentId, 'accommodation_plan', deps(web(SPP_EMPTY))))).toMatchObject({ kind: 'none', suggestedPercent: null });
  });

  test('a suggested percentage is for learning alerts only', async () => {
    seed(['no_photo']);
    const r = await readAlertDetail(db, studentId, 'no_photo', deps(web('<p>25% extra time.</p>')));
    expect(r.suggestedPercent).toBeNull();
  });

  test('refuses a family alert key and an unknown key (NOT_ROSTER), before any request', async () => {
    seed(['siblings']);
    const w = web();
    await expect(readAlertDetail(db, studentId, 'siblings', deps(w))).rejects.toMatchObject({ code: 'NOT_ROSTER' });
    await expect(readAlertDetail(db, studentId, 'nonsense', deps(w))).rejects.toMatchObject({ code: 'NOT_ROSTER' });
    expect(w.requests).toEqual([]);
  });

  test('refuses an alert the student does not hold (NO_ALERT), and an unknown student (NOT_FOUND)', async () => {
    seed(['no_photo']);
    const w = web();
    await expect(readAlertDetail(db, studentId, 'allergies', deps(w))).rejects.toMatchObject({ code: 'NO_ALERT' });
    await expect(readAlertDetail(db, 9999, 'allergies', deps(w))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(w.requests).toEqual([]);
  });

  test('a Security Violation page stops the read', async () => {
    seed(['no_photo']);
    const w = web('<html><h1>Security Violation Logged</h1></html>');
    await expect(readAlertDetail(db, studentId, 'no_photo', deps(w))).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
  });

  test('caches each answer for 10 minutes, per student and alert', async () => {
    seed(['no_photo', 'allergies']);
    const w = web(NO_PHOTO);
    let t = NOW;
    const d = deps(w, () => t);
    await readAlertDetail(db, studentId, 'no_photo', d);
    const before = w.requests.length;
    expect((await readAlertDetail(db, studentId, 'no_photo', d)).readAt).toBe('2026-10-25T10:00:00.000Z');
    expect(w.requests.length).toBe(before);
    await readAlertDetail(db, studentId, 'allergies', d); // another alert: read again
    expect(w.requests.length).toBeGreaterThan(before);
    const mid = w.requests.length;
    t += 10 * 60 * 1000 + 1;
    await readAlertDetail(db, studentId, 'no_photo', d);
    expect(w.requests.length).toBeGreaterThan(mid);
  });
});
