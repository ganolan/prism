import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { contactsForStudents } from './guardianContactStore.js';

// Masked fixtures: invented names and example.test addresses only.
let db;
const addStudent = (n) => db.prepare(
  'INSERT INTO students (schoology_uid, school_uid, first_name, last_name) VALUES (?, ?, ?, ?)'
).run(`s${n}`, `1_${n}`, `Student${n}`, 'Sample').lastInsertRowid;
const addParent = (studentId, uid, first, last, email) => db.prepare(
  'INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)'
).run(studentId, uid, first, last, email).lastInsertRowid;
const addSlot = (studentId, slot, name, email) => db.prepare(
  'INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, ?, ?, ?)'
).run(studentId, slot, name, email);
const setPs = (studentId, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`INSERT INTO student_powerschool (student_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(studentId, ...cols.map((c) => fields[c]));
};
const SYNCED = '2026-10-21T01:00:00.000Z';

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('contactsForStudents', () => {
  test('an unread student\'s parents are not_checked', () => {
    const a = addStudent(1);
    const p = addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test'); // slots without a read stamp do not count
    setPs(a, { alerts_synced_at: SYNCED });
    const out = contactsForStudents(db, [a]);
    expect(out.get(a).guardiansSyncedAt).toBeNull();
    expect(out.get(a).byParent.get(p)).toEqual({ status: 'not_checked', primary: false, reason: 'Not checked against PowerSchool yet' });
  });

  test('a parent with no slot is not_matched', () => {
    const a = addStudent(1);
    const p = addParent(a, 'p1', 'Jordan', 'Other', 'jordan@example.test');
    const q = addParent(a, 'p2', 'Robin', 'Sample', 'robin@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, { guardians_synced_at: SYNCED, correspondence: '1' });
    const out = contactsForStudents(db, [a]).get(a);
    expect(out.guardiansSyncedAt).toBe(SYNCED);
    expect(out.byParent.get(p)).toEqual({ status: 'not_matched', primary: false, reason: 'Not matched to a PowerSchool guardian' });
    expect(out.byParent.get(q)).toEqual({ status: 'contactable', primary: true, reason: null });
  });

  test('a flagged slot gives do_not_contact with its reason', () => {
    const a = addStudent(1);
    const p = addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    const q = addParent(a, 'p2', 'Kit', 'Sample', 'kit@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { guardians_synced_at: SYNCED, dnc_g1: '1', g2_deceased: '1' });
    const out = contactsForStudents(db, [a]).get(a);
    expect(out.byParent.get(p)).toEqual({ status: 'do_not_contact', primary: false, reason: 'Do not contact (PowerSchool)' });
    expect(out.byParent.get(q)).toEqual({ status: 'deceased', primary: false, reason: 'Deceased (PowerSchool)' });
  });

  test('a flag for one child applies to a sibling with the same uid or email', () => {
    const a = addStudent(1);
    const b = addStudent(2);
    // Student A's record flags guardian 1 and guardian 2.
    addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    addParent(a, 'p2', 'Kit', 'Sample', 'KIT@example.test ');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { guardians_synced_at: SYNCED, dnc_g1: '1', g2_deceased: '1' });
    // Student B's record flags no one; B's rows for the same guardians differ in uid or email.
    const bRobin = addParent(b, 'p1', 'Robin', 'Sample', 'robin.work@example.test');
    const bKit = addParent(b, 'p9', 'Kit', 'Sample', 'kit@example.test');
    const bOther = addParent(b, 'p3', 'Jordan', 'Sample', 'jordan@example.test');
    addSlot(b, 1, 'Sample, Robin', 'robin.work@example.test');
    addSlot(b, 2, 'Sample, Jordan', 'jordan@example.test');
    setPs(b, { guardians_synced_at: SYNCED });
    // Only B is asked for: A is decided because its rows share a uid or an email with B's.
    const out = contactsForStudents(db, [b]);
    expect([...out.keys()]).toEqual([b]);
    const byParent = out.get(b).byParent;
    expect(byParent.get(bRobin)).toEqual({ status: 'do_not_contact', primary: false, reason: 'Do not contact (PowerSchool)' });
    expect(byParent.get(bKit)).toEqual({ status: 'deceased', primary: false, reason: 'Deceased (PowerSchool)' });
    expect(byParent.get(bOther)).toEqual({ status: 'contactable', primary: false, reason: null });
  });

  test('a flag spreads along a chain of uids and emails', () => {
    // A's row (uid X, e1) is flagged by A's own record; B's row (uid X, e2) and C's row
    // (uid Y, e2) carry no flags, but all three are one guardian.
    const a = addStudent(1);
    const b = addStudent(2);
    const c = addStudent(3);
    addParent(a, 'uX', 'Robin', 'Sample', 'e1@example.test');
    addSlot(a, 1, 'Sample, Robin', 'e1@example.test');
    setPs(a, { guardians_synced_at: SYNCED, dnc_g1: '1' });
    const pb = addParent(b, 'uX', 'Robin', 'Sample', 'e2@example.test');
    addSlot(b, 1, 'Sample, Robin', 'e2@example.test');
    setPs(b, { guardians_synced_at: SYNCED });
    const pc = addParent(c, 'uY', 'Robin', 'Sample', 'E2@example.test');
    const cOther = addParent(c, 'uZ', 'Jordan', 'Sample', 'jordan@example.test');
    addSlot(c, 1, 'Sample, Robin', 'e2@example.test');
    addSlot(c, 2, 'Sample, Jordan', 'jordan@example.test');
    setPs(c, { guardians_synced_at: SYNCED });
    const dnc = { status: 'do_not_contact', primary: false, reason: 'Do not contact (PowerSchool)' };

    const both = contactsForStudents(db, [b, c]);
    expect(both.get(b).byParent.get(pb)).toEqual(dnc);
    expect(both.get(c).byParent.get(pc)).toEqual(dnc);
    expect(both.get(c).byParent.get(cOther).status).toBe('contactable');

    const onlyC = contactsForStudents(db, [c]);
    expect([...onlyC.keys()]).toEqual([c]);
    expect(onlyC.get(c).byParent.get(pc)).toEqual(dnc);
    expect(onlyC.get(c).byParent.get(cOther).status).toBe('contactable');
  });

  test('do_not_contact wins over deceased across rows', () => {
    const a = addStudent(1);
    const b = addStudent(2);
    const pa = addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, { guardians_synced_at: SYNCED, g1_deceased: '1' });
    const pb = addParent(b, 'p1', 'Robin', 'Sample', 'robin@example.test');
    addSlot(b, 2, 'Sample, Robin', 'robin@example.test');
    setPs(b, { guardians_synced_at: SYNCED, dnc_g2: '1' });
    const out = contactsForStudents(db, [a, b]);
    expect(out.get(a).byParent.get(pa).status).toBe('do_not_contact');
    expect(out.get(b).byParent.get(pb).status).toBe('do_not_contact');
  });

  // Controller ruling, 21 October 2026: a flagged slot no parent is placed in.
  test('a not_matched parent takes a flagged empty slot\'s status, uncertain, with its reason', () => {
    const a = addStudent(1);
    const placed = addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    const unplaced = addParent(a, 'p2', 'Jordan', 'Other', 'jordan@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { guardians_synced_at: SYNCED, g2_deceased: '1' });
    const out = contactsForStudents(db, [a]).get(a);
    expect(out.byParent.get(unplaced)).toEqual({
      status: 'deceased', primary: false, uncertain: true,
      reason: 'Not matched to a PowerSchool guardian. Guardian 2 is flagged: Deceased (PowerSchool)',
    });
    expect(out.byParent.get(placed)).toEqual({ status: 'contactable', primary: false, reason: null });
  });

  test('a student with flags but no guardian read: every parent takes the flag', () => {
    const a = addStudent(1);
    const p = addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    const q = addParent(a, 'p2', 'Kit', 'Sample', 'kit@example.test');
    setPs(a, { alerts_synced_at: SYNCED, dnc_g1: '1' });
    const out = contactsForStudents(db, [a]).get(a);
    const dnc = { status: 'do_not_contact', primary: false, uncertain: true, reason: 'Not checked against PowerSchool yet. Guardian 1 is flagged: Do not contact (PowerSchool)' };
    expect(out.byParent.get(p)).toEqual(dnc);
    expect(out.byParent.get(q)).toEqual(dnc);
  });

  test('an uncertain flag spreads to a sibling\'s rows with the same uid or email, with the plain reason', () => {
    const a = addStudent(1);
    const b = addStudent(2);
    // A: slot 2 is deceased and no parent is placed in it, so A's two unplaced parents take it.
    addParent(a, 'uJ', 'Jordan', 'Other', 'jordan@example.test');
    addParent(a, 'uM', 'Morgan', 'Else', 'morgan@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { guardians_synced_at: SYNCED, g2_deceased: '1' });
    // B: the same two guardians, each uniquely placed in an unflagged slot of B's record.
    const bJordan = addParent(b, 'uJ', 'Jordan', 'Other', 'jordan.work@example.test');
    const bMorgan = addParent(b, 'uX', 'Morgan', 'Else', ' MORGAN@example.test');
    addSlot(b, 1, 'Other, Jordan', 'jordan.work@example.test');
    addSlot(b, 2, 'Else, Morgan', 'morgan@example.test');
    setPs(b, { guardians_synced_at: SYNCED });
    const out = contactsForStudents(db, [b]).get(b);
    const deceased = { status: 'deceased', primary: false, reason: 'Deceased (PowerSchool)' };
    expect(out.byParent.get(bJordan)).toEqual(deceased); // same uid
    expect(out.byParent.get(bMorgan)).toEqual(deceased); // same email, any case
  });

  test('a sibling is found by an email padded with no-break spaces, as JS trim reads it', () => {
    const a = addStudent(1);
    const b = addStudent(2);
    addParent(a, 'p1', 'Robin', 'Sample', 'robin@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, { guardians_synced_at: SYNCED, dnc_g1: '1' });
    const pb = addParent(b, 'p7', 'Robin', 'Sample', '\u00a0Robin@example.test\u00a0');
    addSlot(b, 1, 'Sample, Robin', 'robin@example.test');
    setPs(b, { guardians_synced_at: SYNCED });
    expect(contactsForStudents(db, [b]).get(b).byParent.get(pb).status).toBe('do_not_contact');
  });

  test('every requested student is listed, with no parents or none asked for', () => {
    const a = addStudent(1);
    const out = contactsForStudents(db, [a, String(a), 999]);
    expect([...out.keys()]).toEqual([a, 999]);
    expect(out.get(a)).toEqual({ guardiansSyncedAt: null, byParent: new Map() });
    expect(contactsForStudents(db, []).size).toBe(0);
  });
});
