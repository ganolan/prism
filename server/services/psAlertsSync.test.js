import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { syncPsAlerts } from './psAlertsSync.js';
import { applyPsAlerts, applyPsGuardians, psAlertsByStudent, psAlertsForStudent } from './psAlertStore.js';
import { PowerSchoolWeb, launchForm } from './powerschoolWeb.js';
import { fakePowerSchoolWeb, emergencyHtml } from '../testing/fakePowerSchoolWeb.js';
import { parseEmergencyContacts } from '../lib/psEmergencyContacts.js';

let db;
const addCourse = (sectionId, name, extra = {}) => db.prepare(
  'INSERT INTO courses (schoology_section_id, course_name, archived, excluded) VALUES (?, ?, ?, ?)'
).run(sectionId, name, extra.archived ?? 0, extra.excluded ?? 0).lastInsertRowid;
const addStudent = (dcid, first = `S${dcid}`) => db.prepare(
  'INSERT INTO students (schoology_uid, school_uid, first_name, last_name) VALUES (?, ?, ?, ?)'
).run(`u${dcid}`, `1_${dcid}`, first, 'X').lastInsertRowid;
const keysOf = (id) => db.prepare('SELECT alert_key FROM student_ps_alerts WHERE student_id = ? ORDER BY alert_key').all(id).map((r) => r.alert_key);

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('launchForm', () => {
  test('reads the form action and decoded hidden fields', () => {
    const f = launchForm('<form action="https://powerschool.hkis.edu.hk/x?a=1&amp;b=2" method="post"><input type="hidden" name="oauth_signature" value="a&amp;b=" /><input name="n" value=\'v\'></form>');
    expect(f).toEqual({ action: 'https://powerschool.hkis.edu.hk/x?a=1&b=2', fields: { oauth_signature: 'a&b=', n: 'v' } });
    expect(launchForm('<html></html>')).toBeNull();
  });
});

describe('PowerSchoolWeb', () => {
  test('launches by posting the signed form to PowerSchool, then reads with its session cookie', async () => {
    const web = fakePowerSchoolWeb();
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    const post = web.requests.find((r) => r.path === '/integrations/attendance/index.html');
    expect(post.form).toMatchObject({ custom_sectiondcid: '9001', oauth_signature: 'sig&=' });
    const types = await ps.read('/teachers/mba_alerts/queries/getAlertTypes.json', { disabled: 0, student_schoolid: 40 });
    expect(types).toHaveLength(9);
    expect(web.requests.at(-1)).toMatchObject({ method: 'POST', cookie: 'JSESSIONID=s1', params: { disabled: '0', student_schoolid: '40' } });
  });

  test('a read without a live session is PS_SESSION, never data', async () => {
    const web = fakePowerSchoolWeb();
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await expect(ps.read('/teachers/mba_alerts/queries/getAlertTypes.json', {})).rejects.toMatchObject({ code: 'PS_SESSION' });
  });

  test('a Schoology session sent to sign-in is SESSION_EXPIRED', async () => {
    const web = fakePowerSchoolWeb({ loginRedirect: true });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await expect(ps.launch('S1')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  test('a /ws read sends Accept: application/json; an error status is not a session end, a redirect is', async () => {
    const web = fakePowerSchoolWeb({ sectionInfo: { 9001: { periodIdToPsmPeriodIdMap: {} }, 9002: { status: 500 } }, expireOnce: 'section_info' });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    const get = (dcid) => ps.read('/ws/attendance/section_info', { sectionDcid: dcid }, { method: 'GET', accept: 'application/json' });
    await expect(get('9001')).rejects.toMatchObject({ code: 'PS_SESSION', status: 302, sessionEnded: true });
    await ps.launch('S1');
    expect(await get('9001')).toEqual([{ periodIdToPsmPeriodIdMap: {} }]);
    await expect(get('9002')).rejects.toMatchObject({ code: 'PS_SESSION', status: 500, sessionEnded: false });
    expect(web.requests.filter((r) => r.path === '/ws/attendance/section_info').every((r) => r.accept === 'application/json')).toBe(true);
  });

  test('launch posts a form already read, without reading it again', async () => {
    const web = fakePowerSchoolWeb();
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    const { sectionDcid, userDcid, form } = await ps.launchIds('S1');
    expect({ sectionDcid, userDcid }).toEqual({ sectionDcid: '9001', userDcid: '100' });
    await ps.launch('S1', { form });
    expect(web.requests.filter((r) => r.path.startsWith('/apps/lti/'))).toHaveLength(1);
    expect(ps.launched).toBe(true);
  });

  test('teacherPage sends the Referer and no X-Requested-With', async () => {
    const web = fakePowerSchoolWeb({ emergency: { 9001: emergencyHtml([{ student: 'Lee, Ana', g1: ['Lee, Mei', 'm@example.org'], g2: ['', ''] }]) } });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    expect(await ps.teacherPage('/teachers/home.html')).toContain('<html');
    const html = await ps.teacherPage('/teachers/StudEmgContacts.html?sectionid=9001', { referer: '/teachers/home.html' });
    expect(html).toContain('Guardian 1');
    const [home, list] = web.requests.filter((r) => r.path === '/teachers/home.html' || r.path === '/teachers/StudEmgContacts.html');
    expect(home).toMatchObject({ method: 'GET', cookie: 'JSESSIONID=s1', accept: 'text/html', referer: null, xhr: null });
    expect(list).toMatchObject({ method: 'GET', cookie: 'JSESSIONID=s1', params: { sectionid: '9001' }, referer: 'https://powerschool.hkis.edu.hk/teachers/home.html', xhr: null });
  });

  test('a Security Violation page is PS_SECURITY', async () => {
    const web = fakePowerSchoolWeb({ failRead: (name) => name === 'StudEmgContacts.html' && '<h1>Security Violation Logged</h1>' });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    await expect(ps.teacherPage('/teachers/StudEmgContacts.html?sectionid=9001')).rejects.toMatchObject({ code: 'PS_SECURITY' });
  });

  test('a redirect is PS_SESSION with sessionEnded; an error status is not a session end', async () => {
    const web = fakePowerSchoolWeb({ expireOnce: 'home.html', failRead: (name) => name === 'StudEmgContacts.html' });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    await expect(ps.teacherPage('/teachers/home.html')).rejects.toMatchObject({ code: 'PS_SESSION', status: 302, sessionEnded: true });
    await ps.launch('S1');
    await expect(ps.teacherPage('/teachers/StudEmgContacts.html?sectionid=9001')).rejects.toMatchObject({ code: 'PS_SESSION', status: 500, sessionEnded: false });
  });

  test('a section without a configured list answers a valid empty list', async () => {
    const web = fakePowerSchoolWeb();
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await ps.launch('S1');
    expect(parseEmergencyContacts(await ps.teacherPage('/teachers/StudEmgContacts.html?sectionid=9001'))).toEqual([]);
  });

  test('a refused launch is PS_LAUNCH', async () => {
    const web = fakePowerSchoolWeb({ launchStatus: 403 });
    const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
    await expect(ps.launch('S1')).rejects.toMatchObject({ code: 'PS_LAUNCH' });
  });
});

describe('syncPsAlerts', () => {
  const sections = {
    9001: [
      { studentid: '101', studentdcid: '5001', values: { x_spp: '1', x_dnc_g1: '1' }, adv: ['10593855'] },
      { studentid: '102', studentdcid: '5002', values: { x_ls_support_level: '1' }, man: ['39472338'] },
    ],
    9002: [{ studentid: '103', studentdcid: '5003', values: { x_allergyepi: '1' } }],
  };

  test('reads every active course over plain HTTP and stores each student\'s alerts and contact fields', async () => {
    addCourse('S1', 'Alpha'); addCourse('S2', 'Beta');
    addCourse('S3', 'Old', { archived: 1 }); addCourse('S4', 'Template', { excluded: 1 });
    const a = addStudent('5001'); const b = addStudent('5002'); const c = addStudent('5003');
    const web = fakePowerSchoolWeb({ schoology: { S1: '9001', S2: '9002' }, sections });
    const r = await syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(r).toMatchObject({ processed: 2, read: 2, failed: 0, students: 3, withAlerts: 3 });
    expect(web.launches()).toBe(1); // one PowerSchool session for the whole sync
    expect(web.requests.filter((q) => q.path.endsWith('getAlertTypes.json'))).toHaveLength(1);
    expect(keysOf(a)).toEqual(['accommodation_plan', 'allergies']);
    expect(keysOf(b)).toEqual(['learning_support_1', 'mobility']);
    expect(keysOf(c)).toEqual(['epipen']);
    expect(db.prepare('SELECT dnc_g1, dnc_g2, alerts_synced_at IS NOT NULL synced FROM student_powerschool WHERE student_id = ?').get(a))
      .toEqual({ dnc_g1: '1', dnc_g2: null, synced: 1 });
    expect(db.prepare('SELECT ps_alert_id FROM student_ps_alerts WHERE student_id = ? AND alert_key = ?').get(a, 'accommodation_plan').ps_alert_id).toBe('10593860');
    // stuFieldValues lists the section's studentids, not dcids
    expect(web.requests.find((q) => q.path.endsWith('stuFieldValues.json')).params.stuList).toBe('101,102');
  });


  test('#58: a course list reads only those courses', async () => {
    const s1 = addCourse('S1', 'Alpha'); addCourse('S2', 'Beta');
    addStudent('5001'); addStudent('5002'); addStudent('5003');
    const web = fakePowerSchoolWeb({ schoology: { S1: '9001', S2: '9002' }, sections });
    const r = await syncPsAlerts({ db, courseIds: [s1], deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(r).toMatchObject({ processed: 1, students: 2 });
  });

  test('a student read again loses the alerts that no longer fire', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp'), (?, 'epipen')").run(a, a);
    const web = fakePowerSchoolWeb({ sections: { 9001: [{ studentid: '101', studentdcid: '5001', values: {} }] } });
    await syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(keysOf(a)).toEqual([]);
  });

  test('a section that fails keeps its students\' last-known alerts; the others are still read', async () => {
    addCourse('S1', 'Alpha'); addCourse('S2', 'Beta');
    const a = addStudent('5001'); const c = addStudent('5003');
    db.prepare("INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp')").run(a);
    const web = fakePowerSchoolWeb({
      schoology: { S1: '9001', S2: '9002' }, sections,
      failRead: (name, e) => name === 'getAdvTriggerMatches.html' && e.params.studentIds === '101,102',
    });
    const r = await syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(r).toMatchObject({ read: 1, failed: 1 });
    expect(r.results.find((x) => x.courseName === 'Alpha')).toMatchObject({ status: 'failed' });
    expect(keysOf(a)).toEqual(['ilp']);
    expect(keysOf(c)).toEqual(['epipen']);
  });

  test('a PowerSchool session that ends mid-sync is started again once and the section re-read', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    const web = fakePowerSchoolWeb({ sections, expireOnce: 'stuFieldValues.json' });
    const r = await syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(r).toMatchObject({ read: 1, failed: 0 });
    expect(web.launches()).toBe(2);
    expect(keysOf(a)).toEqual(['accommodation_plan', 'allergies']);
  });

  test('a "Security Violation Logged" page stops the sync at once: no other section is read, nothing cleared', async () => {
    addCourse('S1', 'Alpha'); addCourse('S2', 'Beta');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp')").run(a);
    const web = fakePowerSchoolWeb({
      schoology: { S1: '9001', S2: '9002' }, sections,
      failRead: (name) => name === 'getStudentsInSection.json' && '<h1>Security Violation Logged: Attempted to run an unauthorized action</h1>',
    });
    await expect(syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } })).rejects.toMatchObject({ code: 'PS_SECURITY' });
    expect(web.requests.filter((q) => q.path.endsWith('getStudentsInSection.json'))).toHaveLength(1);
    expect(web.launches()).toBe(1);
    expect(keysOf(a)).toEqual(['ilp']);
  });

  test('an expired Schoology session stops the sync with the log-in message', async () => {
    addCourse('S1', 'Alpha');
    const web = fakePowerSchoolWeb({ loginRedirect: true });
    await expect(syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } })).rejects.toThrow(/mastery:login/);
  });

  test('when no section can be read the sync throws, and nothing is cleared', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp')").run(a);
    const web = fakePowerSchoolWeb({ sections, failRead: (name) => name === 'getStudentsInSection.json' });
    await expect(syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } })).rejects.toThrow(/not read/);
    expect(keysOf(a)).toEqual(['ilp']);
  });

  test('a catalogue with none of Prism\'s alerts stops the read instead of clearing everyone', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp')").run(a);
    const web = fakePowerSchoolWeb({ sections, catalogue: [{ id: '1', trigger_type: 'sf', name: 'Something new' }, {}] });
    await expect(syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } })).rejects.toThrow(/catalogue/);
    expect(keysOf(a)).toEqual(['ilp']);
  });

  test('a course with no PowerSchool section is skipped; no courses means no requests', async () => {
    addCourse('S9', 'Master');
    const web = fakePowerSchoolWeb({ schoology: { S9: null } });
    const r = await syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });
    expect(r).toMatchObject({ skipped: 1, read: 0 });
    expect(web.launches()).toBe(0);

    const empty = new Database(':memory:'); migrate(empty);
    const web2 = fakePowerSchoolWeb();
    await syncPsAlerts({ db: empty, deps: { fetchImpl: web2.fetchImpl, jar: web2.jar } });
    expect(web2.requests).toHaveLength(0);
  });
});

describe('syncPsAlerts: guardian slots (#66)', () => {
  const lee = { student: 'Lee, Ana', g1: ['Lee, Mei', 'mei@example.org', '5550 0100'], g2: ['Lee, Jun', 'jun@example.org'] };
  const sections = { 9001: [{ studentid: '101', studentdcid: '5001', lastfirst: 'Lee, Ana', values: { x_homeemail: '2' } }] };
  const slots = (id) => db.prepare('SELECT slot, name, email FROM student_ps_guardians WHERE student_id = ? ORDER BY slot').all(id);
  const phones = (id) => db.prepare('SELECT slot, phone FROM student_ps_guardians WHERE student_id = ? ORDER BY slot').all(id);
  const run = (web) => syncPsAlerts({ db, deps: { fetchImpl: web.fetchImpl, jar: web.jar } });

  test('stores each student\'s guardian slots, the correspondence code and guardians_synced_at', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    const web = fakePowerSchoolWeb({ sections, emergency: { 9001: emergencyHtml([lee]) } });
    const r = await run(web);
    expect(r.guardians).toEqual({ read: 1, failed: 0, students: 1 });
    expect(slots(a)).toEqual([
      { slot: 1, name: 'Lee, Mei', email: 'mei@example.org' },
      { slot: 2, name: 'Lee, Jun', email: 'jun@example.org' },
    ]);
    expect(phones(a)).toEqual([{ slot: 1, phone: '5550 0100' }, { slot: 2, phone: null }]);
    const row = db.prepare('SELECT correspondence, guardians_synced_at IS NOT NULL synced FROM student_powerschool WHERE student_id = ?').get(a);
    expect(row).toEqual({ correspondence: '2', synced: 1 });
    const pages = web.requests.filter((q) => q.path === '/teachers/home.html' || q.path === '/teachers/StudEmgContacts.html');
    expect(pages.map((q) => q.path)).toEqual(['/teachers/home.html', '/teachers/StudEmgContacts.html']);
    expect(pages[1]).toMatchObject({ params: { sectionid: '9001' }, referer: 'https://powerschool.hkis.edu.hk/teachers/home.html' });
  });

  test('a list that fails keeps last-known guardians and still stores alerts', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, 1, 'Old, Name', 'old@example.org')").run(a);
    db.prepare("INSERT INTO student_powerschool (student_id, guardians_synced_at) VALUES (?, '2026-10-01T00:00:00.000Z')").run(a);
    const web = fakePowerSchoolWeb({
      sections: { 9001: [{ studentid: '101', studentdcid: '5001', lastfirst: 'Lee, Ana', values: { x_spp: '1' } }] },
      emergency: { 9001: { status: 500 } },
    });
    const r = await run(web);
    expect(r).toMatchObject({ read: 1, failed: 0, guardians: { read: 0, failed: 1, students: 0 } });
    expect(keysOf(a)).toEqual(['accommodation_plan']);
    expect(slots(a)).toEqual([{ slot: 1, name: 'Old, Name', email: 'old@example.org' }]);
    expect(db.prepare('SELECT guardians_synced_at, alerts_synced_at IS NOT NULL alerts FROM student_powerschool WHERE student_id = ?').get(a))
      .toEqual({ guardians_synced_at: '2026-10-01T00:00:00.000Z', alerts: 1 });
  });

  test('a Security Violation on the list stops the sync', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    db.prepare("INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, 1, 'Old, Name', 'old@example.org')").run(a);
    const web = fakePowerSchoolWeb({ sections, failRead: (name) => name === 'StudEmgContacts.html' && '<h1>Security Violation Logged</h1>' });
    await expect(run(web)).rejects.toMatchObject({ code: 'PS_SECURITY' });
    expect(slots(a)).toHaveLength(1);
  });

  test('a student read again with a changed list replaces both slots', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    await run(fakePowerSchoolWeb({ sections, emergency: { 9001: emergencyHtml([lee]) } }));
    const changed = { student: 'Lee, Ana', g1: ['Lee, Mei', 'new@example.org'], g2: ['', ''] };
    const r = await run(fakePowerSchoolWeb({ sections, emergency: { 9001: emergencyHtml([changed]) } }));
    expect(r.guardians).toEqual({ read: 1, failed: 0, students: 1 });
    expect(slots(a)).toEqual([{ slot: 1, name: 'Lee, Mei', email: 'new@example.org' }]);
  });

  test('a PowerSchool session that ends on the list is started again once and the list re-read', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001');
    const web = fakePowerSchoolWeb({ sections, emergency: { 9001: emergencyHtml([lee]) }, expireOnce: 'StudEmgContacts.html' });
    const r = await run(web);
    expect(r.guardians).toEqual({ read: 1, failed: 0, students: 1 });
    expect(web.launches()).toBe(2);
    expect(slots(a)).toHaveLength(2);
  });

  test('two roster students with one name get no slots', async () => {
    addCourse('S1', 'Alpha');
    const a = addStudent('5001'); const b = addStudent('5002');
    const web = fakePowerSchoolWeb({
      sections: { 9001: [{ studentid: '101', studentdcid: '5001', lastfirst: 'Lee, Ana' }, { studentid: '102', studentdcid: '5002', lastfirst: 'Lee, Ana' }] },
      emergency: { 9001: emergencyHtml([lee]) },
    });
    const r = await run(web);
    expect(r.guardians).toEqual({ read: 1, failed: 0, students: 0 });
    expect(slots(a)).toEqual([]); expect(slots(b)).toEqual([]);
  });
});

describe('applyPsGuardians', () => {
  test('replaces a read student\'s slots, skips an empty slot and leaves the others alone', () => {
    const a = addStudent('5001'); const b = addStudent('5002');
    db.prepare("INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, 2, 'Keep, Me', NULL)").run(b);
    const r = applyPsGuardians(db, new Map([
      ['5001', { g1: { name: 'Lee, Mei', email: null }, g2: { name: null, email: null } }],
      ['7777', { g1: { name: 'Nobody', email: null }, g2: { name: null, email: null } }],
    ]), { now: '2026-10-21T00:00:00.000Z' });
    expect(r).toEqual({ students: 1 });
    expect(db.prepare('SELECT student_id, slot, name FROM student_ps_guardians ORDER BY student_id, slot').all())
      .toEqual([{ student_id: a, slot: 1, name: 'Lee, Mei' }, { student_id: b, slot: 2, name: 'Keep, Me' }]);
    expect(db.prepare('SELECT student_id, guardians_synced_at FROM student_powerschool').all()).toEqual([{ student_id: a, guardians_synced_at: '2026-10-21T00:00:00.000Z' }]);
  });

  test('stores a slot\'s phone, and a slot with only a phone', () => {
    const a = addStudent('5001');
    applyPsGuardians(db, new Map([
      ['5001', { g1: { name: 'Lee, Mei', email: 'mei@example.org', phone: '5550 0100' }, g2: { name: null, email: null, phone: '5550 0101' } }],
    ]));
    expect(db.prepare('SELECT slot, name, email, phone FROM student_ps_guardians WHERE student_id = ? ORDER BY slot').all(a)).toEqual([
      { slot: 1, name: 'Lee, Mei', email: 'mei@example.org', phone: '5550 0100' },
      { slot: 2, name: null, email: null, phone: '5550 0101' },
    ]);
  });
});

describe('applyPsAlerts + reads', () => {
  test('a contact column missing from the entry keeps its stored value; a null one clears it', () => {
    const a = addStudent('5001');
    const full = { dnc_g1: '1', dnc_g2: '1', g1_deceased: null, g2_deceased: '1', correspondence: '1' };
    applyPsAlerts(db, new Map([['5001', { alerts: [], contact: full }]]), { now: '2026-10-20T00:00:00.000Z' });
    // The next read has no dnc_g1 key (a renamed field) and clears dnc_g2.
    applyPsAlerts(db, new Map([['5001', { alerts: [], contact: { dnc_g2: null, g1_deceased: null, g2_deceased: '1', correspondence: '3' } }]]), { now: '2026-10-21T00:00:00.000Z' });
    expect(db.prepare('SELECT alerts_synced_at, dnc_g1, dnc_g2, g1_deceased, g2_deceased, correspondence FROM student_powerschool WHERE student_id = ?').get(a))
      .toEqual({ alerts_synced_at: '2026-10-21T00:00:00.000Z', dnc_g1: '1', dnc_g2: null, g1_deceased: null, g2_deceased: '1', correspondence: '3' });
  });


  test('stores only students Prism knows; reads give labels, never contact fields', () => {
    const a = addStudent('5001');
    const r = applyPsAlerts(db, new Map([
      ['5001', { alerts: ['ilp', 'epipen'], contact: { dnc_g1: null, dnc_g2: '1', g1_deceased: null, g2_deceased: null } }],
      ['7777', { alerts: ['ilp'], contact: {} }],
    ]), { now: '2026-10-17T00:00:00.000Z' });
    expect(r).toEqual({ students: 1, withAlerts: 1 });
    const by = psAlertsByStudent(db, [a, 999]);
    expect(by.get(a).map((x) => x.key)).toEqual(['ilp', 'epipen']);
    expect(by.get(999)).toEqual([]);
    expect(JSON.stringify(by.get(a))).not.toMatch(/dnc/);
    expect(psAlertsForStudent(db, a)).toMatchObject({ synced_at: '2026-10-17T00:00:00.000Z' });
    expect(psAlertsForStudent(db, 999)).toEqual({ alerts: [], synced_at: null });
  });
});
