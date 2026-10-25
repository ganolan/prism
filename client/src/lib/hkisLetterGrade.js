// HKIS's "HS Proficiency to Letter Grade Translation Scale" (Translation_Scale_HKIS_FINAL.pdf, from
// Graham 25 Oct 2026, #193): the letter grade for each combination of reporting category levels, for
// 2 to 5 categories. Each key counts the categories at ED, EX, D and EM, in that order ("3100" is
// 3 ED and 1 EX). Any IE is F. The chart has no grade for other category counts, so Prism shows none.
//
// One combination is missing from the chart: 1 ED, 1 EX, 2 D, 1 EM with 5 categories. Every other
// 5-category combination with one EM and no IE is a C, so Prism uses C and marks it (INFERRED).
export const HKIS_CHART = {
  2: {
    A: ['2000'], 'A-': ['1100'], 'B+': ['0200'], B: ['1010'], 'B-': ['0110'], 'C+': ['0020'],
    C: ['1001', '0101', '0011'],
    D: ['0002'],
  },
  3: {
    A: ['3000'], 'A-': ['2100', '1200'], 'B+': ['0300'], B: ['2010', '1110', '0210'], 'B-': ['1020', '0120'], 'C+': ['0030'],
    C: ['2001', '1101', '1011', '0201', '0111', '0021'],
    D: ['0012', '1002', '0102', '0003'],
  },
  4: {
    A: ['4000', '3100'], 'A-': ['2200', '1300'], 'B+': ['0400'], B: ['3010', '2110', '1210', '0310'],
    'B-': ['2020', '1120', '0220'], 'C+': ['1030', '0130', '0040'],
    C: ['3001', '2101', '2011', '1201', '1111', '1021', '0301', '0211', '0121', '0031'],
    D: ['2002', '1102', '1012', '0202', '0112', '0022', '1003', '0103', '0013', '0004'],
  },
  5: {
    A: ['5000', '4100'], 'A-': ['3200', '2300', '1400'], 'B+': ['0500'],
    B: ['4010', '3110', '3020', '2210', '2120', '1310', '1220', '0410'],
    'B-': ['2030', '1130', '0320', '0230'], 'C+': ['1040', '0140', '0050'],
    C: ['4001', '3101', '3011', '2201', '2111', '2021', '1301', '1211', '1121', '1031', '0401', '0311', '0221', '0131', '0041',
      '3002', '2102', '1202', '1112', '0302'],
    D: ['2012', '1022', '0212', '0122', '0032', '2003', '1103', '1013', '0203', '0113', '0023', '1004', '0104', '0014', '0005'],
  },
};

export const INFERRED = { 5: ['1121'] };

// Best to worst; F (any IE) is not in the chart's rows.
export const LETTERS = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F'];

export const CHART_COUNTS = [2, 3, 4, 5];

const COUNTED = ['ED', 'EX', 'D', 'EM'];

const LOOKUP = Object.fromEntries(CHART_COUNTS.map((n) => [n, Object.fromEntries(
  Object.entries(HKIS_CHART[n]).flatMap(([letter, keys]) => keys.map((k) => [k, letter])),
)]));

export function comboKey(levels) {
  return COUNTED.map((code) => levels.filter((l) => l === code).length).join('');
}

// The levels a key stands for, best first ("3100" -> ED ED ED EX).
export function comboLevels(key) {
  return COUNTED.flatMap((code, i) => Array(Number(key[i])).fill(code));
}

export const chartCovers = (n) => CHART_COUNTS.includes(n);

// Why a course has no letter grade at all, when the chart does not cover its category count.
export const uncoveredText = (n) => `No letter grade: HKIS's letter grade chart covers 2 to 5 reporting categories, and this course has ${n}.`;

export const isInferred = (n, key) => (INFERRED[n] || []).includes(key);

// The HKIS letter grade for one level per reporting category, or null while a category has no level
// or the course has a category count the chart does not cover.
export function hkisLetterGrade(levels) {
  if (!levels.length || levels.some((l) => l == null)) return null;
  if (!LOOKUP[levels.length]) return null;
  if (levels.includes('IE')) return 'F';
  return LOOKUP[levels.length][comboKey(levels)] ?? null;
}
