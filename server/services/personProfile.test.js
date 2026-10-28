// #203: a profile page for anyone People search finds, stored, read again after 7 days, kept until the teacher deletes it.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { getPersonProfile, classifyPerson, infoRows, childUids, deletePerson, addPersonNote, deletePersonNote, adoptProfiledStudents } from './personProfile.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const days = (n) => new Date(NOW.getTime() + n * 86400000);
const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
const STAFF_PAGE = `<table>${row('Position', 'HS Counselor')}${row('Subjects taught', 'Advisory')}${row('Email', 'x')}${row('Phone', '1234 5678')}</table>`;
const STUDENT_PAGE = `<table>${row('Email', 'x')}${row('Parents', '<a href="/user/11">P</a>')}${row('Advisors', '<a href="/user/21">A</a>')}</table>`;
const PROFILES = {
  500: { uid: '500', name_first: 'Sam', name_last: 'Lee', name_display: 'Sam Lee', primary_email: 'slee@hkis.edu.hk', picture_url: 'https://x/p.jpg', parents: {}, child_uids: {} },
  600: { uid: '600', name_first: 'Ana', name_last: 'Ng', name_display: 'Ana Ng', primary_email: '280123@hkis.edu.hk', parents: { parent: [{ id: 11, name_first: 'Mei', name_last: 'Ng', primary_email: 'mei@example.test' }] }, child_uids: {} },
  700: { uid: '700', name_first: 'Mei', name_last: 'Ng', primary_email: 'mei@example.test', child_uids: { uid: ['600', '601'] } },
};
let db;
function readers(pages = {}) {
  const calls = [];
  return {
    calls,
    getProfile: async (uid) => { calls.push(['profile', uid]); return PROFILES[uid]; },
    getProfiles: async (uids) => new Map(uids.filter((u) => PROFILES[u]).map((u) => [u, PROFILES[u]])),
    getSections: async () => [{ course_title: 'Robotics', section_title: 'ASA' }],
    getGroups: async () => [{ title: 'Robotics Club', category: 'clubs' }],
    readInfoPage: async (uid) => { calls.push(['page', uid]); return pages[uid] ?? '<table></table>'; },
  };
}
beforeEach(() => { db = new Database(':memory:'); migrate(db); });

describe('who a person is', () => {
  test('a student by the Parents or Advisors row or a numbered school email; staff by Position or a named school email; a parent by children', () => {
    expect(classifyPerson({}, infoRows(STUDENT_PAGE))).toBe('student');
    expect(classifyPerson({ primary_email: '280123@hkis.edu.hk' }, new Map())).toBe('student');
    expect(classifyPerson({}, infoRows(STAFF_PAGE))).toBe('staff');
    expect(classifyPerson({ primary_email: 'slee@hkis.edu.hk' }, new Map())).toBe('staff');
    expect(classifyPerson({ primary_email: 'mei@example.test', child_uids: '600,601' }, new Map())).toBe('parent');
    expect(classifyPerson({ primary_email: 'mei@example.test' }, infoRows(`<table>${row('Children', 'x')}</table>`))).toBe('parent');
    expect(classifyPerson({ primary_email: 'someone@example.test', child_uids: {} }, new Map())).toBeNull();
  });
  test('child_uids in any form', () => {
    expect(childUids({ uid: ['1', '2'] })).toEqual(['1', '2']);
    expect(childUids('3,4')).toEqual(['3', '4']);
    expect(childUids({})).toEqual([]);
    expect(childUids(null)).toEqual([]);
  });
});

describe('getPersonProfile', () => {
  test('a Prism student goes to their student page, with no Schoology read', async () => {
    const id = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('600', 'Ana', 'Ng')").run().lastInsertRowid;
    const r = readers();
    expect(await getPersonProfile(db, '600', { readers: r, now: NOW })).toEqual({ student_id: id });
    expect(r.calls).toEqual([]);
  });

  test('staff: position, subjects and phone from the Info page; stored, and not read again within 7 days', async () => {
    const r = readers({ 500: STAFF_PAGE });
    const { profile } = await getPersonProfile(db, '500', { readers: r, now: NOW });
    expect(profile).toMatchObject({ kind: 'staff', name_display: 'Sam Lee', email: 'slee@hkis.edu.hk', position: 'HS Counselor', subjects: 'Advisory', phone: '1234 5678', groups: [{ title: 'Robotics Club', category: 'clubs' }], notes: [] });
    expect(profile.courses).toBeUndefined();
    await getPersonProfile(db, '500', { readers: r, now: days(6) });
    expect(r.calls.filter(([k]) => k === 'profile')).toHaveLength(1);
    await getPersonProfile(db, '500', { readers: r, now: days(8) });
    expect(r.calls.filter(([k]) => k === 'profile')).toHaveLength(2);
    await getPersonProfile(db, '500', { readers: r, now: days(8), refresh: true });
    expect(r.calls.filter(([k]) => k === 'profile')).toHaveLength(3);
  });

  test('opened long after its last read and Schoology cannot answer: the stored profile, dated, with why', async () => {
    await getPersonProfile(db, '600', { readers: readers({ 600: STUDENT_PAGE }), now: NOW });
    const failing = { ...readers(), getProfile: async () => { throw new Error('Schoology API 404: GET /users/600'); } };
    const { profile } = await getPersonProfile(db, '600', { readers: failing, now: days(400) });
    expect(profile).toMatchObject({ kind: 'student', courses: [{ title: 'Robotics: ASA' }], read_at: NOW.toISOString(), read_error: 'Schoology API 404: GET /users/600' });
    const expired = { ...readers(), readInfoPage: async () => { throw Object.assign(new Error('x'), { needsLogin: true }); } };
    expect((await getPersonProfile(db, '600', { readers: expired, now: days(401), refresh: true })).profile.read_error).toBe('the Schoology session has expired');
    // Never stored: the error itself.
    await expect(getPersonProfile(db, '601', { readers: failing, now: NOW })).rejects.toThrow(/404/);
    // A good read clears it.
    expect((await getPersonProfile(db, '600', { readers: readers({ 600: STUDENT_PAGE }), now: days(402) })).profile.read_error).toBeNull();
  });

  test('a student not in Prism: parents, current courses and groups', async () => {
    const { profile } = await getPersonProfile(db, '600', { readers: readers({ 600: STUDENT_PAGE }), now: NOW });
    expect(profile).toMatchObject({
      kind: 'student',
      parents: [{ uid: '11', name: 'Mei Ng', email: 'mei@example.test' }],
      courses: [{ title: 'Robotics: ASA' }],
    });
  });

  test('a parent: their children, each named and, when Prism holds them, linked to the student page', async () => {
    const kid = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('601', 'Bo', 'Ng')").run().lastInsertRowid;
    const { profile } = await getPersonProfile(db, '700', { readers: readers(), now: NOW });
    expect(profile.kind).toBe('parent');
    expect(profile.children).toEqual([{ uid: '600', name: 'Ana Ng' }, { uid: '601', name: null, student_id: kid }]);
  });

  test('not a number: refused', async () => {
    await expect(getPersonProfile(db, 'abc', { readers: readers(), now: NOW })).rejects.toMatchObject({ status: 400 });
  });
});

describe('notes and deletion', () => {
  test('notes are added newest first, deleted by id, and refused on a person never opened', async () => {
    await getPersonProfile(db, '500', { readers: readers({ 500: STAFF_PAGE }), now: NOW });
    const a = addPersonNote(db, '500', 'First', NOW);
    addPersonNote(db, '500', ' Second ', days(1));
    expect((await getPersonProfile(db, '500', { readers: readers(), now: days(1) })).profile.notes.map((n) => n.content)).toEqual(['Second', 'First']);
    expect(deletePersonNote(db, '500', a.id)).toBe(true);
    expect(() => addPersonNote(db, '999', 'x', NOW)).toThrow(/No profile/);
    expect(() => addPersonNote(db, '500', '  ', NOW)).toThrow(/some text/);
  });

  test('a profile is kept however long it goes unopened, and deleted with its notes only on request', async () => {
    const r = readers({ 500: STAFF_PAGE });
    await getPersonProfile(db, '500', { readers: r, now: NOW });
    addPersonNote(db, '500', 'Kept', NOW);
    const { profile } = await getPersonProfile(db, '500', { readers: r, now: days(800) });
    expect(profile.notes.map((n) => n.content)).toEqual(['Kept']);
    expect(deletePerson(db, '500')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM people_notes').get().n).toBe(0);
    expect(deletePerson(db, '500')).toBe(false);
  });

  test('a profiled student Graham later teaches: the notes move to the student and the profile goes; the student is untouched', async () => {
    await getPersonProfile(db, '600', { readers: readers({ 600: STUDENT_PAGE }), now: NOW });
    addPersonNote(db, '600', 'Before class', NOW);
    addPersonNote(db, '600', 'Later', days(1));
    // A sync adds them as a student (they joined a class of his).
    const id = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('600', 'Ana', 'Ng')").run().lastInsertRowid;
    expect(adoptProfiledStudents(db)).toBe(1);
    expect(db.prepare('SELECT content FROM notes WHERE student_id = ? ORDER BY id').all(id).map((n) => n.content)).toEqual(['Before class', 'Later']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM people WHERE schoology_uid = '600'").get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM students WHERE id = ?').get(id).n).toBe(1);
    expect(adoptProfiledStudents(db)).toBe(0); // nothing moves twice
  });

  test('opening the profile of someone now a student moves their notes and opens the student page', async () => {
    await getPersonProfile(db, '600', { readers: readers({ 600: STUDENT_PAGE }), now: NOW });
    addPersonNote(db, '600', 'Before class', NOW);
    const id = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('600', 'Ana', 'Ng')").run().lastInsertRowid;
    expect(await getPersonProfile(db, '600', { readers: readers(), now: days(1) })).toEqual({ student_id: id });
    expect(db.prepare('SELECT content FROM notes WHERE student_id = ?').all(id)).toEqual([{ content: 'Before class' }]);
  });
});
