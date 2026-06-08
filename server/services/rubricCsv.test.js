import { describe, test, expect } from 'vitest';
import { parseRubricCsv, templateCsv, exportRubricCsv } from './rubricCsv.js';

const CSV = `Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging
UI/UX,Produce,"Anchor Standard 4: Select, analyze",Polished.,Clear.,Inconsistent.,Lacks clarity.
Functionality,Produce,Develop and refine,All + extra.,All reliable.,Some work.,Limited.`;

describe('rubricCsv', () => {
  test('parses rows in order, maps level headers, defaults IE', () => {
    const content = parseRubricCsv(CSV, { name: 'MAD' });
    expect(content.name).toBe('MAD');
    expect(content.source).toBe('csv');
    expect(content.criteria).toHaveLength(2);
    const [c1] = content.criteria;
    expect(c1.position).toBe(1);
    expect(c1.criterion_name).toBe('UI/UX');
    expect(c1.standard_title).toBe('Anchor Standard 4: Select, analyze');
    expect(c1.reporting_category).toBe('Produce');
    expect(c1.descriptors).toEqual({
      ED: 'Polished.', EX: 'Clear.', D: 'Inconsistent.', EM: 'Lacks clarity.',
      IE: 'Insufficient Evidence',
    });
  });

  test('reads optional External ID column when present', () => {
    const csv = `Criteria,Reporting Category,Standard,External ID,Exhibiting Depth,Exhibiting,Developing,Emerging
UI/UX,Produce,Select,ART.5.1,a,b,c,d`;
    expect(parseRubricCsv(csv, { name: 'X' }).criteria[0].external_id).toBe('ART.5.1');
  });

  test('"Exhibiting" header is not confused with "Exhibiting Depth"', () => {
    const c = parseRubricCsv(CSV, { name: 'M' }).criteria[0];
    expect(c.descriptors.EX).toBe('Clear.');
    expect(c.descriptors.ED).toBe('Polished.');
  });

  test('templateCsv has the documented header + one example row', () => {
    const t = templateCsv();
    expect(t.split('\n')[0]).toBe(
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging,Insufficient Evidence'
    );
    expect(t.trim().split('\n')).toHaveLength(2);
  });

  test('exportRubricCsv round-trips through parseRubricCsv', () => {
    const content = parseRubricCsv(CSV, { name: 'RT' });
    const reparsed = parseRubricCsv(exportRubricCsv(content), { name: 'RT' });
    expect(reparsed.criteria).toEqual(content.criteria);
  });
});
