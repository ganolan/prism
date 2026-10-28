// #190: parsing PowerSchool's counselor read and matching each counselor to the Schoology Advisors row.
import { describe, test, expect } from 'vitest';
import { parseCounselors, advisorUids, matchAdvisor } from './psCounselors.js';

const rec = (extra = {}) => ({ id: 1, studentDcid: 5001, userDcid: 77, userFirstName: 'Sam', userLastName: 'Lee', isPrimary: true, '@extensions': null, ...extra });

describe('parseCounselors', () => {
  test('keeps the user, the names and the primary flag', () => {
    expect(parseCounselors([rec(), rec({ id: 2, userDcid: 78, userFirstName: ' Jo ', userLastName: 'Chan', isPrimary: false })], '5001')).toEqual([
      { userDcid: '77', firstName: 'Sam', lastName: 'Lee', isPrimary: true },
      { userDcid: '78', firstName: 'Jo', lastName: 'Chan', isPrimary: false },
    ]);
  });
  test('an empty list is a real answer: no counselors', () => {
    expect(parseCounselors([], '5001')).toEqual([]);
  });
  test('refuses a list that is not this student\'s, or not a list', () => {
    expect(parseCounselors([rec({ studentDcid: 5002 })], '5001')).toBeNull();
    expect(parseCounselors({ studentCounselors: [] }, '5001')).toBeNull();
    expect(parseCounselors(null, '5001')).toBeNull();
    expect(parseCounselors([rec({ userDcid: null })], '5001')).toBeNull();
    expect(parseCounselors([rec({ userFirstName: '', userLastName: '' })], '5001')).toBeNull();
  });
  test('isPrimary must be true itself; a repeated user is kept once', () => {
    expect(parseCounselors([rec({ isPrimary: 'true' }), rec()], '5001')).toEqual([{ userDcid: '77', firstName: 'Sam', lastName: 'Lee', isPrimary: false }]);
  });
});

describe('advisorUids', () => {
  const page = `<table><tr><th>Email</th><td><a href="mailto:x">x</a></td></tr>
    <tr><th>Parents</th><td><a href="/user/11">P</a>, <a href="/user/12">Q</a></td></tr>
    <tr><th>Advisors</th><td><a href="/user/21">A</a>, <a href="/user/22/info">B</a>, <a href="/user/21">A</a></td></tr></table>`;
  test('reads only the Advisors row, each uid once, in order', () => {
    expect(advisorUids(page)).toEqual(['21', '22']);
  });
  test('no Advisors row: none', () => {
    expect(advisorUids('<table><tr><th>Email</th><td>x</td></tr></table>')).toEqual([]);
  });
});

describe('matchAdvisor', () => {
  const sam = { uid: '21', name_first: 'Samuel', name_first_preferred: 'Sam', name_last: 'Lee', primary_email: 'slee@hkis.edu.hk' };
  const other = { uid: '22', name_first: 'Sam', name_first_preferred: '', name_last: 'Wong', primary_email: 'swong@hkis.edu.hk' };
  test('matches the preferred or the legal first name with the last name, case-folded', () => {
    expect(matchAdvisor({ firstName: 'sam', lastName: 'LEE' }, [other, sam])).toBe(sam);
    expect(matchAdvisor({ firstName: 'Samuel', lastName: 'Lee' }, [other, sam])).toBe(sam);
  });
  test('no match, or two: null', () => {
    expect(matchAdvisor({ firstName: 'Sam', lastName: 'Ho' }, [other, sam])).toBeNull();
    expect(matchAdvisor({ firstName: 'Sam', lastName: 'Lee' }, [sam, { ...sam, uid: '23' }])).toBeNull();
  });
});
