// Schoology's grade flags ("exceptions"), as probed live on 21 October 2026 (#40,
// .claude/schoology-api-reference.md "Grade exceptions (flags)"): 1 Exempt, 2 Incomplete,
// 3 Missing, 5 Absent, 6 Late. 4 is invalid. Every flag removes the grade (Missing sets 0).
export const FLAG_CODES = [1, 2, 3, 5, 6];

export const isFlagCode = (code) => FLAG_CODES.includes(Number(code)) && code !== '' && code != null;

// Exempt (1) and Absent (5): the student is not doing this task, so it is never owed, late,
// referred, made up or waiting on feedback. Incomplete, Missing and Late still leave work owed.
export const isNotDoingTask = (code) => isFlagCode(code) && (Number(code) === 1 || Number(code) === 5);
