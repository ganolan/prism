import { describe, test, expect } from 'vitest';
import { parseSharedStrings, parseSheetRows, excelSerialToIso, planDays, compareCalendars } from './masterPlanCalendar.js';

const SHARED = '<sst><si><t>Date</t></si><si><t>SAT</t></si><si><r><t>Fall</t></r><r><t> Break</t></r></si></sst>';
const SHEET = `<worksheet><sheetData>
  <row r="1"><c r="E1" t="s"><v>0</v></c></row>
  <row r="3"><c r="B3"><v>1</v></c><c r="E3"><v>46247</v></c><c r="F3"><v>1</v></c></row>
  <row r="12"><c r="E12"><v>46256</v></c><c r="F12" t="s"><v>1</v></c></row>
  <row r="13"><c r="E13"><v>46257</v></c></row>
</sheetData></worksheet>`;

describe('Master Plan parsing', () => {
  test('shared strings join rich-text runs', () => {
    expect(parseSharedStrings(SHARED)).toEqual(['Date', 'SAT', 'Fall Break']);
  });

  test('rows resolve shared strings by column', () => {
    const rows = parseSheetRows(SHEET, parseSharedStrings(SHARED));
    expect(rows[1]).toEqual({ B: '1', E: '46247', F: '1' });
    expect(rows[2].F).toBe('SAT');
  });

  test('Excel serial → ISO date (46247 = 13/08/2026)', () => {
    expect(excelSerialToIso(46247)).toBe('2026-08-13');
  });

  test('planDays: numeric F = school day; text/blank = not', () => {
    expect(planDays(parseSheetRows(SHEET, parseSharedStrings(SHARED)))).toEqual([
      { date: '2026-08-13', cycleDay: 1 },
      { date: '2026-08-22', cycleDay: null },
      { date: '2026-08-23', cycleDay: null },
    ]);
  });
});

describe('compareCalendars', () => {
  const plan = [
    { date: '2026-10-05', cycleDay: 2 },
    { date: '2026-10-06', cycleDay: 3 },
    { date: '2026-10-07', cycleDay: 4 },
    { date: '2026-10-08', cycleDay: null },
  ];

  test('identical → no differences; parity→letter mapping learned', () => {
    const ps = [
      { date: '2026-10-05', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-06', in_session: 1, cycle_letter: 'A' },
      { date: '2026-10-07', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-08', in_session: 0, cycle_letter: null },
    ];
    const r = compareCalendars(ps, plan);
    expect(r).toMatchObject({ onlyInPs: [], onlyInPlan: [], letterMismatches: [], planSchoolDays: 3, psSchoolDays: 3 });
    expect(r.letterByParity).toEqual({ 0: 'B', 1: 'A' });
  });

  test('reports differing dates and broken alternation', () => {
    const ps = [
      { date: '2026-10-05', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-06', in_session: 0, cycle_letter: null },
      { date: '2026-10-07', in_session: 1, cycle_letter: 'A' },
      { date: '2026-10-08', in_session: 1, cycle_letter: 'B' },
    ];
    const r = compareCalendars(ps, plan);
    expect(r.onlyInPlan).toEqual(['2026-10-06']);
    expect(r.onlyInPs).toEqual(['2026-10-08']);
    expect(r.letterMismatches).toEqual([{ date: '2026-10-07', cycleDay: 4, letter: 'A' }]);
  });
});
