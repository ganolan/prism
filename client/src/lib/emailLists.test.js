import { describe, it, expect } from 'vitest';
import {
  stillOwing, buildEmailMenu, uniqueAddresses, formatAddresses, copiedMessage, mailtoFor,
} from './emailLists.js';

const row = (o) => ({
  studentId: 1, studentName: 'Ada L', studentEmail: 'ada@example.test', tone: 'red',
  assignmentId: 9, title: 'CPT 1', blockNumber: null, ...o,
});

describe('stillOwing', () => {
  it('late: outstanding owes, submitted_late does not', () => {
    expect(stillOwing('late', row({ kind: 'outstanding' }))).toBe(true);
    expect(stillOwing('late', row({ kind: 'submitted_late' }))).toBe(false);
  });
  it('resubmissions: waiting owes, arrived does not', () => {
    expect(stillOwing('resubmissions', row({ state: 'waiting' }))).toBe(true);
    expect(stillOwing('resubmissions', row({ state: 'arrived' }))).toBe(false);
  });
  it('makeUps: every row owes', () => {
    expect(stillOwing('makeUps', row({}))).toBe(true);
  });
});

describe('buildEmailMenu', () => {
  const late = [
    row({ studentId: 1, studentEmail: 'a@example.test', tone: 'red', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 1, studentEmail: 'a@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 10, title: 'Unit 2 quiz' }),
    row({ studentId: 2, studentEmail: 'b@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 3, studentEmail: 'c@example.test', tone: 'green', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 4, studentEmail: 'd@example.test', tone: 'red', kind: 'submitted_late', assignmentId: 9, title: 'CPT 1' }),
  ];

  it('tiers count distinct still-owing students, narrow to broad', () => {
    const { tiers } = buildEmailMenu('late', late);
    expect(tiers.map((t) => [t.key, t.label, t.students])).toEqual([
      ['red', 'Red', 1],
      ['redAmber', 'Red + amber', 2],
      ['all', 'Everyone still owing', 3],
    ]);
    expect(tiers[2].emails).toEqual(['a@example.test', 'b@example.test', 'c@example.test']); // student 1 once, student 4 excluded
  });

  it('drops a tier that is empty or repeats the previous tier', () => {
    const rows = [
      row({ studentId: 1, tone: 'amber', kind: 'outstanding' }),
      row({ studentId: 2, studentEmail: 'b@example.test', tone: 'amber', kind: 'outstanding' }),
    ];
    expect(buildEmailMenu('late', rows).tiers.map((t) => t.key)).toEqual(['redAmber']);
  });

  it('no still-owing rows → no tiers and no assessments', () => {
    const rows = [row({ kind: 'submitted_late' })];
    expect(buildEmailMenu('late', rows)).toEqual({ tiers: [], byAssessment: [] });
    expect(buildEmailMenu('late', [])).toEqual({ tiers: [], byAssessment: [] });
  });

  it('by assessment: one item per assignment, most students first, block shown when showCourse', () => {
    const rows = [
      row({ studentId: 1, assignmentId: 9, title: 'CPT 1', blockNumber: '4' }),
      row({ studentId: 2, studentEmail: 'b@example.test', assignmentId: 9, title: 'CPT 1', blockNumber: '4' }),
      row({ studentId: 3, studentEmail: 'c@example.test', assignmentId: 11, title: 'CPT 1', blockNumber: '7' }),
    ];
    const course = buildEmailMenu('makeUps', rows, { showCourse: true }).byAssessment;
    expect(course.map((a) => [a.label, a.students])).toEqual([['CPT 1 · BK 4', 2], ['CPT 1 · BK 7', 1]]);
    const page = buildEmailMenu('makeUps', rows).byAssessment;
    expect(page.map((a) => a.label)).toEqual(['CPT 1', 'CPT 1']);
  });

  it('omits by-assessment when only one assessment is involved', () => {
    const rows = [row({ studentId: 1 }), row({ studentId: 2, studentEmail: 'b@example.test' })];
    expect(buildEmailMenu('makeUps', rows).byAssessment).toEqual([]);
  });

  it('counts students without an email as missing', () => {
    const rows = [row({ studentId: 1, studentEmail: null }), row({ studentId: 2, studentEmail: 'b@example.test' })];
    const [all] = buildEmailMenu('makeUps', rows).tiers;
    expect(all).toMatchObject({ students: 2, emails: ['b@example.test'], missing: 1 });
  });
});

describe('addresses', () => {
  it('dedupes case-insensitively, keeps first spelling and order, drops blanks', () => {
    expect(uniqueAddresses(['B@example.test', ' a@example.test ', 'b@example.test', '', null]))
      .toEqual(['B@example.test', 'a@example.test']);
    expect(formatAddresses(['a@example.test', 'b@example.test'])).toBe('a@example.test; b@example.test');
    expect(formatAddresses([])).toBe('');
  });

  it('copiedMessage: plural, singular, missing clause, nothing to copy', () => {
    expect(copiedMessage(5)).toBe('5 addresses copied. Paste into Outlook To or Bcc.');
    expect(copiedMessage(1)).toBe('1 address copied. Paste into Outlook To or Bcc.');
    expect(copiedMessage(4, 1)).toBe('4 addresses copied. Paste into Outlook To or Bcc. 1 student has no email in Prism.');
    expect(copiedMessage(4, 2)).toBe('4 addresses copied. Paste into Outlook To or Bcc. 2 students have no email in Prism.');
    expect(copiedMessage(0, 2)).toBe('Nothing copied: 2 students have no email in Prism.');
  });
});

describe('mailtoFor', () => {
  it('builds a mailto with an encoded subject per kind', () => {
    expect(mailtoFor(row({ title: 'CPT 1' }), 'late')).toBe('mailto:ada@example.test?subject=CPT%201%3A%20late%20work');
    expect(mailtoFor(row({ title: 'Unit 1 test' }), 'makeUps')).toBe('mailto:ada@example.test?subject=Unit%201%20test%3A%20make-up%20test');
    expect(mailtoFor(row({ title: 'A & B' }), 'resubmissions')).toBe('mailto:ada@example.test?subject=A%20%26%20B%3A%20resubmission');
  });
  it('null without an email', () => {
    expect(mailtoFor(row({ studentEmail: null }), 'late')).toBeNull();
    expect(mailtoFor(row({ studentEmail: '  ' }), 'late')).toBeNull();
  });
});
