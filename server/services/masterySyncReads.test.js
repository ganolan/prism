// The mastery reads over plain HTTP (#141), on the fake web seam: no browser.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, __setTestDb } from '../db/index.js';
import {
  masteryDeps, masteryBuildingId, openMasteryReader, syncMasteryForCourse, syncMasteryForAssignment, getRubricScoresForStudent, readPairLevels, writeMasteryScores,
  writeMasteryScoresBatch, writeMasteryOverride,
} from './masterySync.js';
import { getSectionGrades, getAssignmentGrades } from './schoology.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { sessionStatus, resetSessionStatusCache } from './schoologySession.js';

// The assignment refresh also pulls public REST grades: never reach the network here.
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(async () => []), getAssignmentGrades: vi.fn(async () => []) }));

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
    const r = await syncMasteryForCourse(5);
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
    // #52: the course is stamped with when its mastery was read.
    expect(Date.parse(db.prepare('SELECT mastery_synced_at FROM courses WHERE id = 5').get().mastery_synced_at)).toBeGreaterThan(Date.now() - 60000);
  });

  test('an observation with no level (points null) stores no score row and clears an old one', async () => {
    // An empty row counted as a level, so a comment-only student showed as Graded, not Partially graded.
    db.prepare(`INSERT INTO measurement_topics (id, title) VALUES ('t1', 'Topic')`).run();
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('701', '900', 't1', 75, 'Exhibiting')`).run();
    useWeb(routes({
      [`POST ${BASE}/api/material-observations/search`]: { json: { data: [{ objective_id: 't1', student_uid: 701, points: null, gradeable_material: { material: { id: 900 } } }] } },
    }));
    const r = await syncMasteryForCourse(5);
    expect(r.scoresCount).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_scores').get().n).toBe(0);
  });

  test('a non-2xx API answer fails the read as the in-page fetch did ("HTTP 500 for …"), and leaves no stamp', async () => {
    useWeb(routes({ [`${BASE}/api/aligned-objectives`]: { status: 500, text: '' } }));
    await expect(syncMasteryForCourse(5)).rejects.toThrow(/HTTP 500 for .*aligned-objectives/);
    expect(db.prepare('SELECT mastery_synced_at FROM courses WHERE id = 5').get().mastery_synced_at).toBeNull();
  });

  test('signed out (no silent renewal): the sync stops at once, points to Settings, notes the session expired', async () => {
    useWeb(routes({ [BASE]: { login: true } }));
    await expect(syncMasteryForCourse(5)).rejects.toThrow(/Log in to Schoology in Settings/);
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });

  test('no saved session counts as signed out', async () => {
    masteryDeps.web = () => ({ jar: null });
    await expect(syncMasteryForCourse(5)).rejects.toThrow(/mastery session has expired/);
  });

  test('a page with no building id is an error, before any API read', async () => {
    useWeb(routes({ [BASE]: { text: '<html><body>no settings</body></html>' } }));
    await expect(syncMasteryForCourse(5)).rejects.toThrow(/building_id/);
    expect(fake.requests).toHaveLength(1);
  });

  test('a page without the CSRF pair: the POST searches fail before sending', async () => {
    useWeb(routes({ [BASE]: { text: PAGE.replace('"csrf_token":"tok","csrf_key":"key",', '') } }));
    const r = await openMasteryReader(SID);
    await expect(r.postJson(`https://schoology.hkis.edu.hk${BASE}/api/alignments/search`, {})).rejects.toMatchObject({ code: 'NO_CSRF' });
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });
});

describe('syncMasteryForAssignment over plain HTTP', () => {
  test('one per-topic GET with the building id; stores this assignment\'s scores', async () => {
    db.prepare(`INSERT INTO measurement_topics (id, course_id, title) VALUES ('t1', 5, 'Topic')`).run();
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id, synced_at) VALUES ('900', 't1', 5, 'x')`).run();
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (5, '900', 'Task')`).run();
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
    // #52: the assignment is stamped (not the course: rollups and other assignments were not read).
    expect(db.prepare('SELECT mastery_synced_at FROM assignments WHERE schoology_assignment_id = ?').get('900').mastery_synced_at).toBeTruthy();
    expect(db.prepare('SELECT mastery_synced_at FROM courses WHERE id = 5').get().mastery_synced_at).toBeNull();
    // #168: the grade comments come from this task's grades alone (?assignment_id=), not the section's.
    expect(getAssignmentGrades).toHaveBeenCalledWith(SID, '900');
    expect(getSectionGrades).not.toHaveBeenCalled();
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

describe('readPairLevels: one student\'s topic levels on one task, fresh (#40)', () => {
  const OBS = { json: { data: [
    { objective_id: 't1', student_uid: 701, points: '75', gradeable_material: { material: { id: 900 } } },
    { objective_id: 't2', student_uid: 701, points: '100', gradeable_material: { material: { id: 900 } } },
    { objective_id: 't3', student_uid: 701, points: null, gradeable_material: { material: { id: 900 } } }, // no score
    { objective_id: 't1', student_uid: 702, points: '25', gradeable_material: { material: { id: 900 } } }, // another student
    { objective_id: 't1', student_uid: 701, points: '50', gradeable_material: { material: { id: 901 } } }, // another task
  ] } };
  test('the page once, then one batched observations POST for the task\'s topics; levels keyed by topic', async () => {
    useWeb(routes({ [`POST ${BASE}/api/material-observations/search`]: OBS }));
    expect(await readPairLevels({ sectionId: SID, studentUid: '701', assignmentId: '900', topicIds: ['t1', 't2', 't3'] })).toEqual({ t1: 'EX', t2: 'ED' });
    const post = fake.requests.find((q) => q.method === 'POST');
    expect(post.path).toBe(`${BASE}/api/material-observations/search`);
    expect(post.json).toEqual({ building_id: 97989879, section_id: Number(SID), objective_ids: 't1,t2,t3' });
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(1);
  });

  test('no topics: nothing read', async () => {
    useWeb(routes());
    expect(await readPairLevels({ sectionId: SID, studentUid: '701', assignmentId: '900', topicIds: [] })).toEqual({});
    expect(fake.requests).toHaveLength(0);
  });

  test('a failed read throws', async () => {
    useWeb(routes({ [`POST ${BASE}/api/material-observations/search`]: { status: 500, json: {} } }));
    await expect(readPairLevels({ sectionId: SID, studentUid: '701', assignmentId: '900', topicIds: ['t1'] })).rejects.toThrow();
  });
});

describe('mastery writes over plain HTTP (#141)', () => {
  const OBS = `/iapi2/district-mastery/course/${SID}/observations`;
  const OVR = `${BASE}/api/nodes/t1/outcome-override`;
  const entry = (enrollmentId) => ({ enrollmentId, assignmentId: 900, gradeInfo: { t1: { grade: '75.00', gradingScaleId: 21337256 } }, gradingPeriodId: 11, gradingCategoryId: 22 });
  const posts = () => fake.requests.filter((q) => q.method === 'POST');

  test('writeMasteryScores: one page GET for the CSRF pair, then the observation POST with the browser\'s headers and body', async () => {
    useWeb(routes({ [`POST ${OBS}`]: { json: { data: { ok: 1 } } } }));
    expect(await writeMasteryScores({ sectionId: SID, ...entry(1) })).toEqual({ data: { ok: 1 } });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: BASE });
    const [post] = posts();
    expect(post.path).toBe(OBS);
    expect(post.headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'tok', 'X-CSRF-Key': 'key' });
    expect(post.json).toEqual({
      enrollmentId: 1, gradeInfo: { t1: { grade: '75.00', gradingScaleId: 21337256 } }, gradeItemId: 900, isGradebook: true, materialId: 900,
      materialType: 'ASSIGNMENT', maxPoints: 100, overrideGrade: null, isCollectedOnly: false, gradingPeriodId: 11, gradingCategoryId: 22,
    });
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('connected');
  });

  test('writeMasteryScoresBatch: one page GET for the whole batch, one POST per enrollment, in order', async () => {
    useWeb(routes({ [`POST ${OBS}`]: (q) => ({ json: { data: { enrollmentId: q.json.enrollmentId } } }) }));
    const results = await writeMasteryScoresBatch({ sectionId: SID, entries: [entry(1), entry(2), entry(3)] });
    expect(results.map((r) => r.enrollmentId)).toEqual([1, 2, 3]);
    expect(fake.requests.filter((q) => q.path === BASE)).toHaveLength(1);
    expect(posts().map((q) => q.json.enrollmentId)).toEqual([1, 2, 3]);
  });

  test('a batch stops at the first refused POST and says which status', async () => {
    useWeb(routes({ [`POST ${OBS}`]: (q) => (q.json.enrollmentId === 2 ? { status: 403, json: { data: null } } : { json: { data: {} } }) }));
    await expect(writeMasteryScoresBatch({ sectionId: SID, entries: [entry(1), entry(2), entry(3)] })).rejects.toThrow(/HTTP 403/);
    expect(posts().map((q) => q.json.enrollmentId)).toEqual([1, 2]);
  });

  test('writeMasteryOverride: the building id from the page, the verified body', async () => {
    useWeb(routes({ [`POST ${OVR}`]: { json: { data: { outcome_override: { grade_scaled_rounded: 87.5 } } } } }));
    const r = await writeMasteryOverride({ sectionId: SID, objectiveId: 't1', studentUid: 701, gradeScaled: '87.50', gradingScaleId: 21337256 });
    expect(r).toEqual({ data: { outcome_override: { grade_scaled_rounded: 87.5 } } });
    expect(posts()[0].json).toEqual({ building_id: 97989879, section_id: Number(SID), grading_period_id: 0, student_uid: 701, grade_scaled: '87.50', grading_scale_id: 21337256 });
    expect(posts()[0].headers).toMatchObject({ 'X-CSRF-Token': 'tok', 'X-CSRF-Key': 'key' });
  });

  test('writeMasteryOverride: a clear sends grade_scaled null', async () => {
    useWeb(routes({ [`POST ${OVR}`]: { json: { data: { outcome_override: null } } } }));
    await writeMasteryOverride({ sectionId: SID, objectiveId: 't1', studentUid: 701, gradeScaled: null, gradingScaleId: 21337256 });
    expect(posts()[0].json.grade_scaled).toBeNull();
  });

  test('signed out (the page is sent to sign-in): no POST, point to Settings, note expired', async () => {
    useWeb(routes({ [BASE]: { login: true } }));
    await expect(writeMasteryScores({ sectionId: SID, ...entry(1) })).rejects.toThrow(/Log in to Schoology in Settings/);
    expect(posts()).toHaveLength(0);
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });

  test('a write POST sent to sign-in also points to Settings', async () => {
    useWeb(routes({ [`POST ${OBS}`]: { login: true } }));
    await expect(writeMasteryScoresBatch({ sectionId: SID, entries: [entry(1)] })).rejects.toThrow(/Log in to Schoology in Settings/);
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });

  test('no saved session → points to Settings', async () => {
    masteryDeps.web = () => ({ jar: null });
    await expect(writeMasteryOverride({ sectionId: SID, objectiveId: 't1', studentUid: 701, gradeScaled: '87.50' })).rejects.toThrow(/Log in to Schoology in Settings/);
  });
});
