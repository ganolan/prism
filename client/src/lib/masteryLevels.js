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
