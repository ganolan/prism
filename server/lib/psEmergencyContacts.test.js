import { describe, test, expect, vi, afterEach } from 'vitest';
import { parseEmergencyContacts, slotsByDcid } from './psEmergencyContacts.js';
import { emergencyHtml } from '../testing/fakePowerSchoolWeb.js';

describe('parseEmergencyContacts', () => {
  test('parses each row into student, g1 and g2 name and email', () => {
    const html = emergencyHtml([
      { student: 'Lee, Ana', g1: ['Lee, Mei', 'Mei.Lee@Example.org'], g2: ['Park, Jin', 'jin@example.org'] },
      { student: 'Cho, Sam', g1: ['Cho, Dae', 'dae@example.org'], g2: ['', ''] },
    ]);
    expect(parseEmergencyContacts(html)).toEqual([
      { student: 'Lee, Ana', g1: { name: 'Lee, Mei', email: 'mei.lee@example.org', phone: null }, g2: { name: 'Park, Jin', email: 'jin@example.org', phone: null } },
      { student: 'Cho, Sam', g1: { name: 'Cho, Dae', email: 'dae@example.org', phone: null }, g2: { name: null, email: null, phone: null } },
    ]);
  });

  test('keeps each slot\'s phone', () => {
    const html = emergencyHtml([
      { student: 'Lee, Ana', g1: ['Lee, Mei', 'm@example.org', ' 5550&nbsp;0100 '], g2: ['Park, Jin', 'j@example.org', '+00-555-0101'] },
      { student: 'Cho, Sam', g1: ['Cho, Dae', 'd@example.org', ''], g2: ['', '', ''] },
    ]);
    const [lee, cho] = parseEmergencyContacts(html);
    expect(lee.g1.phone).toBe('5550 0100');
    expect(lee.g2.phone).toBe('+00-555-0101');
    expect(cho.g1.phone).toBeNull();
    expect(cho.g2).toEqual({ name: null, email: null, phone: null });
  });

  afterEach(() => vi.restoreAllMocks());

  test('a list without phone columns parses with null phones, and warns once naming them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = '<table><tr><th>Student</th><th>Guardian 1</th><th>G1 Email</th><th>Guardian 2</th><th>G2 Email</th></tr>'
      + '<tr><td>Lee, Ana</td><td>Lee, Mei</td><td>m@example.org</td><td>Park, Jin</td><td>j@example.org</td></tr></table>';
    const rows = parseEmergencyContacts(html);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toMatch(/G1 Phone, G2 Phone/);
    expect(rows).toEqual([
      { student: 'Lee, Ana', g1: { name: 'Lee, Mei', email: 'm@example.org', phone: null }, g2: { name: 'Park, Jin', email: 'j@example.org', phone: null } },
    ]);
  });

  test('a list with both phone columns does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseEmergencyContacts(emergencyHtml([{ student: 'Lee, Ana', g1: ['Lee, Mei', 'm@example.org'], g2: ['', ''] }]));
    expect(warn).not.toHaveBeenCalled();
  });

  test('takes the first address of an email cell', () => {
    const html = emergencyHtml([{ student: 'Lee, Ana', g1: ['Lee, Mei', 'A@Example.org; b@example.org'], g2: ['', ''] }]);
    expect(parseEmergencyContacts(html)[0].g1.email).toBe('a@example.org');
  });

  test('decodes entities and trims', () => {
    const html = emergencyHtml([{ student: '  O&#39;Brien,  Kim ', g1: ['Smith &amp; Co, Pat', 'p@example.org'], g2: ['', ''] }]);
    const [row] = parseEmergencyContacts(html);
    expect(row.student).toBe("O'Brien, Kim");
    expect(row.g1.name).toBe('Smith & Co, Pat');
  });

  test('finds the table by header text, ignoring a layout table before it', () => {
    const html = `<table><tr><td>Menu</td><td>Student</td></tr></table>${emergencyHtml([{ student: 'Lee, Ana', g1: ['Lee, Mei', 'm@example.org'], g2: ['', ''] }])}`;
    expect(parseEmergencyContacts(html)).toHaveLength(1);
  });

  test('a list with a header and no rows is an empty list', () => {
    expect(parseEmergencyContacts(emergencyHtml([]))).toEqual([]);
  });

  test('a header without G2 Email throws', () => {
    const html = '<table><tr><th>Student</th><th>Guardian 1</th><th>G1 Email</th><th>Guardian 2</th></tr><tr><td>Lee, Ana</td><td>a</td><td>b</td><td>c</td></tr></table>';
    expect(() => parseEmergencyContacts(html)).toThrow(/header not found/);
  });
});

describe('slotsByDcid', () => {
  const rows = [
    { student: 'Lee, Ana', g1: { name: 'Lee, Mei', email: 'm@example.org' }, g2: { name: null, email: null } },
    { student: 'Cho, Sam', g1: { name: 'Cho, Dae', email: 'd@example.org' }, g2: { name: null, email: null } },
  ];

  test('joins by lastfirst, any case and spacing', () => {
    const map = slotsByDcid(rows, [{ lastfirst: ' lee,   ANA ', studentdcid: '5001' }, { lastfirst: 'Cho, Sam', studentdcid: 5002 }]);
    expect([...map.keys()].sort()).toEqual(['5001', '5002']);
    expect(map.get('5001')).toEqual({ g1: rows[0].g1, g2: rows[0].g2 });
  });

  test('duplicate roster names join neither', () => {
    const map = slotsByDcid(rows, [{ lastfirst: 'Lee, Ana', studentdcid: '5001' }, { lastfirst: 'Lee, Ana', studentdcid: '5003' }, { lastfirst: 'Cho, Sam', studentdcid: '5002' }]);
    expect([...map.keys()]).toEqual(['5002']);
  });

  test('a name repeated in the list joins neither', () => {
    const twice = [...rows, { student: 'lee, ana', g1: { name: 'Other, Pat', email: 'p@example.org' }, g2: { name: null, email: null } }];
    const map = slotsByDcid(twice, [{ lastfirst: 'Lee, Ana', studentdcid: '5001' }, { lastfirst: 'Cho, Sam', studentdcid: '5002' }]);
    expect([...map.keys()]).toEqual(['5002']);
  });

  test('a roster student with no row is left out', () => {
    expect(slotsByDcid(rows, [{ lastfirst: 'Kim, Zed', studentdcid: '5009' }]).size).toBe(0);
  });
});
