// #190: counselors' emails from the student's Schoology Advisors row, matched by name, copied across students.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { fillCounselorEmails } from './counselorEmails.js';
import { storeCounselors } from './psDemographicsSync.js';

const NOW = new Date('2026-10-28T01:00:00Z');
let db;
const student = (uid) => db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'A', 'B')").run(uid).lastInsertRowid;
const SAM = { userDcid: '71', firstName: 'Sam', lastName: 'Lee', isPrimary: true };
const JO = { userDcid: '72', firstName: 'Jo', lastName: 'Chan', isPrimary: false };
const infoPage = (uids) => `<table><tr><th>Parents</th><td><a href="/user/9">P</a></td></tr><tr><th>Advisors</th><td>${uids.map((u) => `<a href="/user/${u}">x</a>`).join(', ')}</td></tr></table>`;
const PROFILES = {
  21: { uid: '21', name_first: 'Samuel', name_first_preferred: 'Sam', name_last: 'Lee', primary_email: 'slee@hkis.edu.hk' },
  22: { uid: '22', name_first: 'Jo', name_last: 'Chan', primary_email: 'jchan@hkis.edu.hk' },
  23: { uid: '23', name_first: 'Pat', name_last: 'Principal', primary_email: 'pp@hkis.edu.hk' },
};
const emails = (id) => db.prepare('SELECT ps_user_dcid, email, schoology_uid FROM student_counselors WHERE student_id = ? ORDER BY ps_user_dcid').all(id);

function deps(pages) {
  const reads = [];
  const asked = [];
  return {
    reads, asked,
    readInfoPage: async (uid) => { reads.push(uid); return pages[uid]; },
    getProfiles: async (uids) => { asked.push(uids); return new Map(uids.filter((u) => PROFILES[u]).map((u) => [u, PROFILES[u]])); },
    now: NOW,
  };
}

beforeEach(() => { db = new Database(':memory:'); migrate(db); });

describe('fillCounselorEmails', () => {
  test('matches each counselor in the Advisors row and copies the email to the next student with the same counselor', async () => {
    const ana = student('101');
    const bo = student('102');
    storeCounselors(db, ana, [SAM, JO], NOW);
    storeCounselors(db, bo, [SAM, JO], NOW);
    const d = deps({ 101: infoPage(['21', '22', '23']) });
    const r = await fillCounselorEmails(db, d);
    expect(r).toEqual({ copied: 2, pages: 1, matched: 2, unmatched: 0, failed: 0 });
    expect(d.reads).toEqual(['101']); // the second student's page is not needed
    expect(emails(bo)).toEqual([
      { ps_user_dcid: '71', email: 'slee@hkis.edu.hk', schoology_uid: '21' },
      { ps_user_dcid: '72', email: 'jchan@hkis.edu.hk', schoology_uid: '22' },
    ]);
  });

  test('a counselor not in the row is marked tried and not looked for again; profiles are fetched once', async () => {
    const ana = student('101');
    const bo = student('102');
    storeCounselors(db, ana, [SAM, { ...JO, userDcid: '79', firstName: 'Nobody' }], NOW);
    storeCounselors(db, bo, [SAM, { ...JO, userDcid: '80', firstName: 'Else' }], NOW);
    const d = deps({ 101: infoPage(['21', '23']), 102: infoPage(['21', '23']) });
    const r = await fillCounselorEmails(db, d);
    expect(r).toMatchObject({ pages: 2, matched: 1, unmatched: 2 });
    expect(d.asked).toEqual([['21', '23']]);
    const again = deps({});
    expect(await fillCounselorEmails(db, again)).toMatchObject({ pages: 0 });
    expect(again.reads).toEqual([]);
  });

  test('a page that fails is counted and the student tried next night; an ended Schoology session stops', async () => {
    const ana = student('101');
    storeCounselors(db, ana, [SAM], NOW);
    const failing = { ...deps({}), readInfoPage: async () => { throw new Error('Schoology answered 500'); } };
    expect(await fillCounselorEmails(db, failing)).toMatchObject({ pages: 1, failed: 1 });
    expect(emails(ana)[0].email).toBeNull();
    const expired = { ...deps({}), readInfoPage: async () => { throw Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' }); } };
    await expect(fillCounselorEmails(db, expired)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(await fillCounselorEmails(db, deps({ 101: infoPage(['21']) }))).toMatchObject({ matched: 1 });
  });

  test('reads at most `cap` pages a run', async () => {
    for (let i = 0; i < 3; i++) storeCounselors(db, student(String(200 + i)), [{ ...SAM, userDcid: String(90 + i) }], NOW);
    const d = deps({});
    expect(await fillCounselorEmails(db, { ...d, cap: 2 })).toMatchObject({ pages: 2 });
  });
});
