// The mastery reads over plain HTTP (#141), on the fake web seam: no browser.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, __setTestDb } from '../db/index.js';
import {
  masteryDeps, masteryBuildingId, openMasteryReader, syncMasteryForCourse, syncMasteryForAssignment, getRubricScoresForStudent,
} from './masterySync.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { sessionStatus, resetSessionStatusCache } from './schoologySession.js';

// The assignment refresh also pulls public REST grades: never reach the network here.
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(async () => []) }));

const SID = '8458134140';
const BASE = `/course/${SID}/district_mastery`;
// Two Drupal.settings blocks, as on the real page: s_common and the app's props are in the second.
const PAGE = `<html><head>
<script type="text/javascript"><!--//--><![CDATA[//><!--
jQuery.extend(Drupal.settings, {"basePath":"\\/"});
//--><!]]></script>
<script type="text/javascript"><!--//--><![CDATA[//><!--
jQuery.extend(Drupal.settings, {"s_common":{"csrf_token":"tok","csrf_key":"key","school_id":"94044023"},"district_mastery":{"props":{"buildingId":97989879}}});
//--><!]]></script></head><body></body></html>`;

const CATEGORIES = { data: [{ id: 'cat1', title: 'Cat', external_id: 'RC1', child_objectives: [{ id: 't1', title: 'Topic', external_id: 'MT1' }] }] };
const routes = (over = {}) => ({
  [BASE]: { text: PAGE },
  [`${BASE}/api/aligned-objectives`]: { json: CATEGORIES },
  [`POST ${BASE}/api/alignments/search`]: { json: { data: [{ gradeable_material: { material: { id: 900 } }, objective: { id: 't1' } }] } },
  [`POST ${BASE}/api/material-observations/search`]: { json: { data: [{ objective_id: 't1', student_uid: 701, points: '75', gradeable_material: { material: { id: 900 } } }] } },
  [`/iapi2/district-mastery/course/${SID}/materials`]: { json: { data: [{ id: 900, title: 'Task', grading_period_id: 11, grading_category_id: 22 }] } },
  [`POST ${BASE}/api/outcomes/objectives`]: { json: { data: [{ objective_id: 't1', student_outcomes: [{ student_uid: 701, outcome: { grade_percentage: 75, grade_scaled_rounded: 62.5 }, outcome_override: null }] }] } },
  ...over,
});

let db;
let fake;
const useWeb = (r) => { fake = fakeSchoologyWeb({ routes: r }); masteryDeps.web = () => ({ jar: fake.jar, fetchImpl: fake.fetchImpl }); };
const realDeps = { ...masteryDeps };
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (5, ?, 'AP CSP')`).run(SID);
  __setTestDb(db);
  resetSessionStatusCache();
  masteryDeps.interactiveLogin = vi.fn(async () => {});
});
afterEach(() => { Object.assign(masteryDeps, realDeps); });

describe('masteryBuildingId', () => {
  test('the page\'s buildingId (not s_common.school_id), else a building_id= in the markup', () => {
    expect(masteryBuildingId({ s_common: { school_id: '94044023' }, x: { y: { buildingId: 97989879 } } })).toBe('97989879');
    expect(masteryBuildingId(null, '<a href="/x?building_id=123">')).toBe('123');
    expect(masteryBuildingId({ s_common: { school_id: '94044023' } }, '')).toBeNull();
  });
});

describe('syncMasteryForCourse over plain HTTP', () => {
  test('reads the page once, then the API with the building id and the CSRF pair; stores the course', async () => {
    useWeb(routes());
    const r = await syncMasteryForCourse(5, { allowInteractiveLogin: false });
    expect(r).toMatchObject({ categoriesCount: 1, topicsCount: 1, scoresCount: 1, rollupsCount: 1, alignmentsCount: 1, materialsCount: 1 });
    const objectives = fake.requests.find((q) => q.path.endsWith('/aligned-objectives'));
    expect(objectives.query.get('building_id')).toBe('97989879');
    expect(objectives.headers).toMatchObject({ cookie: 'SESS=old', Accept: 'application/json' });
    const posts = fake.requests.filter((q) => q.method === 'POST');
    expect(posts.map((q) => q.path.split('/api/')[1])).toEqual(['alignments/search', 'material-observations/search', 'outcomes/objectives']);
    for (const p of posts) {
      expect(p.headers).toMatchObject({ 'X-CSRF-Token': 'tok', 'X-CSRF-Key': 'key', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
      expect(p.json).toMatchObject({ building_id: 97989879, section_id: Number(SID) });
    }
    expect(db.prepare('SELECT student_uid, assignment_schoology_id, topic_id, points FROM mastery_scores').all())
      .toEqual([{ student_uid: '701', assignment_schoology_id: '900', topic_id: 't1', points: 75 }]);
    expect(db.prepare('SELECT title FROM assignments WHERE schoology_assignment_id = ?').get('900').title).toBe('Task');
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('connected');
  });

  test('a non-2xx API answer fails the read as the in-page fetch did ("HTTP 500 for …")', async () => {
    useWeb(routes({ [`${BASE}/api/aligned-objectives`]: { status: 500, text: '' } }));
    await expect(syncMasteryForCourse(5, { allowInteractiveLogin: false })).rejects.toThrow(/HTTP 500 for .*aligned-objectives/);
  });

  test('signed out with interactive login off: the sync error, the session noted expired, no login opened', async () => {
    useWeb(routes({ [BASE]: { login: true } }));
    await expect(syncMasteryForCourse(5, { allowInteractiveLogin: false })).rejects.toThrow(/mastery session has expired/);
    expect(masteryDeps.interactiveLogin).not.toHaveBeenCalled();
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });

  test('signed out with interactive login on: opens the login once, then reads with the new session', async () => {
    useWeb(routes({ [BASE]: { login: true } }));
    masteryDeps.interactiveLogin = vi.fn(async () => useWeb(routes()));
    const r = await syncMasteryForCourse(5);
    expect(masteryDeps.interactiveLogin).toHaveBeenCalledTimes(1);
    expect(r.scoresCount).toBe(1);
  });

  test('still signed out after the login: "Still not logged in after login attempt"', async () => {
    useWeb(routes({ [BASE]: { login: true } }));
    await expect(syncMasteryForCourse(5)).rejects.toThrow(/Still not logged in after login attempt/);
  });

  test('no saved session counts as signed out', async () => {
    masteryDeps.web = () => ({ jar: null });
    await expect(syncMasteryForCourse(5, { allowInteractiveLogin: false })).rejects.toThrow(/mastery session has expired/);
  });

  test('a page with no building id is an error, before any API read', async () => {
    useWeb(routes({ [BASE]: { text: '<html><body>no settings</body></html>' } }));
    await expect(syncMasteryForCourse(5, { allowInteractiveLogin: false })).rejects.toThrow(/building_id/);
    expect(fake.requests).toHaveLength(1);
  });

  test('a page without the CSRF pair: the POST searches fail before sending', async () => {
    useWeb(routes({ [BASE]: { text: PAGE.replace('"csrf_token":"tok","csrf_key":"key",', '') } }));
    const r = await openMasteryReader(SID, { allowInteractiveLogin: false });
    await expect(r.postJson(`https://schoology.hkis.edu.hk${BASE}/api/alignments/search`, {})).rejects.toMatchObject({ code: 'NO_CSRF' });
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });
});

describe('syncMasteryForAssignment over plain HTTP', () => {
  test('one per-topic GET with the building id; stores this assignment\'s scores', async () => {
    db.prepare(`INSERT INTO measurement_topics (id, course_id, title) VALUES ('t1', 5, 'Topic')`).run();
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id, synced_at) VALUES ('900', 't1', 5, 'x')`).run();
    useWeb(routes({
      [`${BASE}/api/material-observations/search`]: { json: { data: [
        { student_uid: 701, points: 50, gradeable_material: { material_id: 900 } },
        { student_uid: 702, points: 100, gradeable_material: { material_id: 999 } },
      ] } },
    }));
    const r = await syncMasteryForAssignment(5, '900');
    expect(r).toMatchObject({ topicsCount: 1, scoresCount: 1 });
    const get = fake.requests.find((q) => q.path.endsWith('/material-observations/search'));
    expect(Object.fromEntries(get.query)).toEqual({ building_id: '97989879', objective_id: 't1', section_id: SID });
    expect(db.prepare('SELECT student_uid, points FROM mastery_scores').all()).toEqual([{ student_uid: '701', points: 50 }]);
  });
});

describe('getRubricScoresForStudent over plain HTTP', () => {
  test('one GET, no page load; the rows of data', async () => {
    useWeb(routes({ [`${BASE}/api/observations/search`]: { json: { data: [{ alignment_id: 't1', points: 75 }] } } }));
    expect(await getRubricScoresForStudent({ sectionId: SID, studentUid: '701', assignmentId: '900' })).toEqual([{ alignment_id: 't1', points: 75 }]);
    expect(fake.requests.map((q) => q.path)).toEqual([`${BASE}/api/observations/search`]);
    expect(Object.fromEntries(fake.requests[0].query)).toEqual({ student_uids: '701', section_id: SID, material_type: 'ASSIGNMENT', material_id: '900' });
  });

  test('signed out: an error saying so, the session noted expired', async () => {
    useWeb(routes({ [`${BASE}/api/observations/search`]: { login: true } }));
    await expect(getRubricScoresForStudent({ sectionId: SID, studentUid: '701', assignmentId: '900' })).rejects.toThrow(/mastery session has expired/);
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });
});
