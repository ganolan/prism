import { hkisLetterGrade } from './hkisLetterGrade.js';

// Maps the full level names from Schoology's General Academic-family scales
// to the ED/EX/D/EM/IE codes used by the mastery rubric. Lets the gradebook
// match colors to the aligned-rubric look and shorten labels where space is
// tight (course gradebook). Returns null for levels that aren't part of this
// family (e.g. Completion's Complete/Incomplete, ATL's S/I/C).
const FULL_TO_CODE = {
  'Insufficient Evidence': 'IE',
  'Emerging': 'EM',
  'Developing': 'D',
  'Exhibiting': 'EX',
  'Exhibiting Depth': 'ED',
};

export function masteryCodeForLevel(name) {
  return FULL_TO_CODE[name] || null;
}

export const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export const LEVEL_LABELS = {
  ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence',
};

// Canonical 5-level palette — sourced from AssessmentSummaryPage (see
// docs/design-language.md "Level headers"). All level-colored UI imports this.
export const CELL_TEXT = '#1a1a1a';
export const LEVEL_COLORS = {
  ED: { headerFill: '#bfdbfe', draftFill: '#eff6ff', finalBorder: '#2563eb', draftBorder: '#93c5fd' },
  EX: { headerFill: '#bbf7d0', draftFill: '#f0fdf4', finalBorder: '#16a34a', draftBorder: '#86efac' },
  D:  { headerFill: '#fef08a', draftFill: '#fefce8', finalBorder: '#ca8a04', draftBorder: '#fcd34d' },
  EM: { headerFill: '#fed7aa', draftFill: '#fff7ed', finalBorder: '#ea580c', draftBorder: '#fdba74' },
  IE: { headerFill: '#fecaca', draftFill: '#fef2f2', finalBorder: '#dc2626', draftBorder: '#fca5a5' },
};

// Match proficiency level order: A=ED(blue), B=EX(green), C=D(yellow),
// D=EM(orange), F=IE(red). Text tones from LEVEL_COLORS[].text; +/- variants
// step one shade lighter.
export const LETTER_GRADE_COLORS = {
  A: '#1e40af', 'A-': '#2563eb',
  'B+': '#15803d', B: '#166534', 'B-': '#166534',
  'C+': '#854d0e', C: '#713f12',
  D: '#9a3412', F: '#991b1b',
};

// Returns numeric helpers bound to a fetched scale table (ordered ED→IE).
export function makeScaleHelpers(levels) {
  const byCode = Object.fromEntries(levels.map((l) => [l.code, l]));
  return {
    table: levels,
    pointsToLevel(n) {
      if (n == null) return null;
      for (const l of levels) if (n >= Number(l.gradeScaled)) return l.code;
      return levels.length ? levels[levels.length - 1].code : null;
    },
    levelToPoints: (code) => byCode[code]?.points ?? null,
    levelToGradeScaled: (code) => byCode[code]?.gradeScaled ?? null,
    levelLabel: (code) => byCode[code]?.label ?? LEVEL_LABELS[code] ?? null,
    computeLetterGrade: (categoryLevels) => computeLetterGrade(categoryLevels),
  };
}

// The HKIS letter grade from per-category levels: a lookup in HKIS's translation chart
// (`hkisLetterGrade.js`, #193), null while a category has no level or outside 2 to 5 categories.
export function computeLetterGrade(categoryLevels) {
  return hkisLetterGrade(categoryLevels);
}
