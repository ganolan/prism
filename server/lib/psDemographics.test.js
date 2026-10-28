import { describe, test, expect } from 'vitest';
import { parseDemographics, isoFromUsDate } from './psDemographics.js';

// The probed row shape (#116, #191), made-up values.
const row = (label, value) => `<tr><td class="bold"><strong>${label}</strong></td><td>${value}</td></tr>`;
const PAGE = `<html><body><script>var x = "<tr><td>DOB</td><td>01/01/1900</td></tr>";</script><table>
${row('Name', 'Lee, Ana M')}${row('Address', '1 Example Road<br>Hong Kong')}${row('Age', '16 years 4 months')}
${row('DOB', '06/15/2010')}${row('Gender', 'F')}${row('Graduation Year', '2028')}${row('Guardianship', '')}
${row('Home Room', 'Teacher, Sam')}${row('Student ID', '41001')}${row('Student number', '280123')}
</table></body></html>`;

describe('parseDemographics', () => {
  test('keeps only the date of birth, graduation year, home room, guardianship and student number', () => {
    expect(parseDemographics(PAGE)).toEqual({
      found: true, dateOfBirth: '2010-06-15', graduationYear: 2028, homeRoom: 'Teacher, Sam', guardianship: null, studentNumber: '280123',
    });
  });

  test('never reads a row inside a script, and a page without these rows is not found', () => {
    expect(parseDemographics('<script>"<tr><td>DOB</td><td>01/01/1900</td></tr>"</script>')).toMatchObject({ found: false, dateOfBirth: null });
    expect(parseDemographics('')).toMatchObject({ found: false });
  });

  test('entities are decoded; an odd graduation year is none', () => {
    const p = parseDemographics(`<table>${row('Home Room', 'O&#39;Brien, Jo')}${row('Graduation Year', '28')}${row('Guardianship', 'Court order &amp; notes')}</table>`);
    expect(p).toMatchObject({ homeRoom: "O'Brien, Jo", graduationYear: null, guardianship: 'Court order & notes' });
  });
});

describe('isoFromUsDate', () => {
  test.each([
    ['06/15/2010', '2010-06-15'], [' 12/31/2009 ', '2009-12-31'], ['02/29/2008', '2008-02-29'],
    ['02/30/2010', null], ['13/01/2010', null], ['15/06/2010', null], ['2010-06-15', null], ['', null], [null, null],
  ])('%j → %j', (v, want) => expect(isoFromUsDate(v)).toBe(want));
});
