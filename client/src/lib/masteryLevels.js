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

const LEVEL_POINTS_FOR_LETTER = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };

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

// Approximate HKIS letter grade from per-category levels. Moved verbatim from
// MasteryPerformanceSummary (single home now). See the letter-grade popup for
// the authoritative combination table.
export function computeLetterGrade(categoryLevels) {
  if (!categoryLevels.length || categoryLevels.some((l) => l == null)) return null;
  if (categoryLevels.includes('IE')) return 'F';
  const n = categoryLevels.length;
  const pts = categoryLevels.map((l) => LEVEL_POINTS_FOR_LETTER[l] || 0);
  const avg = pts.reduce((a, b) => a + b, 0) / n;
  if (n === 2) {
    const sorted = [...categoryLevels].sort().join('+');
    return ({
      'ED+ED': 'A', 'ED+EX': 'A-', 'EX+EX': 'B+', 'D+ED': 'B+',
      'D+EX': 'B', 'ED+EM': 'B', 'D+D': 'B-', 'EM+EX': 'B-',
      'D+EM': 'C+', 'EM+EM': 'C',
    })[sorted] || 'D';
  }
  const scaled = avg / 25;
  if (scaled >= 3.75) return 'A';
  if (scaled >= 3.25) return 'A-';
  if (scaled >= 2.83) return 'B+';
  if (scaled >= 2.33) return 'B';
  if (scaled >= 2.0) return 'B-';
  if (scaled >= 1.75) return 'C+';
  if (scaled >= 1.25) return 'C';
  if (scaled >= 1.0) return 'D';
  return 'F';
}
