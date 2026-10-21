// Schoology's grade flags ("exceptions"), as probed live on 21 October 2026 (#40,
// .claude/schoology-api-reference.md "Grade exceptions (flags)"): 1 Exempt, 2 Incomplete,
// 3 Missing, 5 Absent, 6 Late. 4 is invalid. Exempt, Incomplete, Absent and Late remove the score
// and every topic level; Missing sets the score to 0 and keeps the levels already entered, which
// still count.
export const FLAG_CODES = [1, 2, 3, 5, 6];

export const isFlagCode = (code) => FLAG_CODES.includes(Number(code)) && code !== '' && code != null;

// Exempt (1) is the only flag that is a decision: the student is not doing this task, so it is
// never owed, late, referred, made up or waiting on feedback. Absent (5) is a marker (teachers use
// it as "their one chance" or as "a reminder to follow up", and Prism assumes neither), so it changes
// nothing in Prism's own tracking; Incomplete, Missing and Late leave the work owed too.
export const isExempt = (code) => isFlagCode(code) && Number(code) === 1;

// Two final flags, three markers (Graham, 21 October 2026). Exempt (1) and Missing (3) are final:
// the rubric stays locked while they are set and they count as handled (feedback given, grading
// complete). Late (6), Incomplete (2) and Absent (5) are markers the teacher grades straight
// through: publishing a grade clears them, as Schoology's own gradebook does, and until then the
// work stays in feedback owed.
export const FINAL_FLAGS = [1, 3];
export const isFinalFlag = (code) => isFlagCode(code) && FINAL_FLAGS.includes(Number(code));
export const isMarker = (code) => isFlagCode(code) && !FINAL_FLAGS.includes(Number(code));

// Names and status-line verbs, as client/src/lib/flags.js FLAGS has them (UI word "Exempt").
export const FLAG_NAMES = { 1: 'Exempt', 2: 'Incomplete', 3: 'Missing', 5: 'Absent', 6: 'Late' };
export const FLAG_VERBS = { 1: 'exempt', 2: 'incomplete', 3: 'missing', 5: 'absent', 6: 'late' };

// Every flag but Missing makes Schoology remove the score AND blank every topic level (each
// observation's points become null). Missing sets the score to 0 and keeps the levels (probe).
export const removesLevels = (code) => isFlagCode(code) && Number(code) !== 3;
