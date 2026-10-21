// Schoology's grade flags ("exceptions"), as probed live on 21 October 2026 (#40,
// .claude/schoology-api-reference.md "Grade exceptions (flags)"): 1 Exempt, 2 Incomplete,
// 3 Missing, 5 Absent, 6 Late. 4 is invalid. Every flag removes the grade (Missing sets 0).
export const FLAG_CODES = [1, 2, 3, 5, 6];

export const isFlagCode = (code) => FLAG_CODES.includes(Number(code)) && code !== '' && code != null;

// Exempt (1) is the only flag that is a decision: the student is not doing this task, so it is
// never owed, late, referred, made up or waiting on feedback. Absent (5) is a marker (teachers use
// it as "their one chance" or as "a reminder to follow up", and Prism assumes neither), so it changes
// nothing in Prism's own tracking; Incomplete, Missing and Late leave the work owed too.
export const isExempt = (code) => isFlagCode(code) && Number(code) === 1;

// Names and status-line verbs, as client/src/lib/flags.js FLAGS has them (UI word "Exempt").
export const FLAG_NAMES = { 1: 'Exempt', 2: 'Incomplete', 3: 'Missing', 5: 'Absent', 6: 'Late' };
export const FLAG_VERBS = { 1: 'exempt', 2: 'incomplete', 3: 'missing', 5: 'absent', 6: 'late' };

// Every flag but Missing makes Schoology remove the score AND blank every topic level (each
// observation's points become null). Missing sets the score to 0 and keeps the levels (probe).
export const removesLevels = (code) => isFlagCode(code) && Number(code) !== 3;
