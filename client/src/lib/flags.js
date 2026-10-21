// Schoology's grade flags ("exceptions"), as probed live on 21 October 2026 (#40,
// .claude/schoology-api-reference.md "Grade exceptions (flags)"): 1 Exempt, 2 Incomplete,
// 3 Missing, 5 Absent, 6 Late. 4 is invalid. Exempt, Incomplete, Absent and Late remove the score
// and every topic level on this account; Missing sets the score to 0 and keeps the levels already
// entered, which still count. The server mirror of the codes is server/lib/flags.js.
export const FLAGS = {
  1: { key: 'exempt', name: 'Exempt', verb: 'exempt' },
  2: { key: 'incomplete', name: 'Incomplete', verb: 'incomplete' },
  3: { key: 'missing', name: 'Missing', verb: 'missing' },
  5: { key: 'absent', name: 'Absent', verb: 'absent' },
  6: { key: 'late', name: 'Late', verb: 'late' },
};

// The Flags menu's order (Graham, 21 October 2026).
export const FLAG_ORDER = [1, 6, 5, 2, 3];

// The menu's subheading, shown once above the five items.
export const FLAGS_MENU_HEADING = 'Flag in Schoology';

export const isFlag = (code) => code !== '' && code != null && Object.hasOwn(FLAGS, Number(code));

// Exempt (1) is the only decision flag: the student is not doing this task, so it is never owed,
// late or extendable. Absent (5) is a marker (Prism assumes no meaning for it) and the rest leave the
// work owed. Mirrors server/lib/flags.js.
export const isExempt = (code) => isFlag(code) && Number(code) === 1;

// Two final flags, three markers (Graham, 21 October 2026; server/lib/flags.js has the same).
// Exempt (1) and Missing (3) are final: the assessment card keeps its rubric locked and they count as handled (the shared feedback view shows Missing as IE).
// Late (6), Incomplete (2) and Absent (5) are markers the teacher grades straight through:
// publishing a grade clears them, and until then the work stays in feedback owed.
export const FINAL_FLAGS = [1, 3];
export const isFinalFlag = (code) => isFlag(code) && FINAL_FLAGS.includes(Number(code));
export const isMarker = (code) => isFlag(code) && !FINAL_FLAGS.includes(Number(code));

// What Schoology does to the grade while a flag is set (probed 21 Oct 2026): Missing sets it to 0
// (and keeps the topic levels); every other flag removes it.
export function flagEffect(code) {
  if (!isFlag(code)) return '';
  return Number(code) === 3 ? 'Schoology counts this as zero while it is flagged.' : 'Schoology removes the grade while it is flagged.';
}

// One line per flag for the menu and the symbol's popover. The student's first name makes it
// read as theirs; with none it says "the student". `aligned` (the task has measurement topics)
// picks Missing's line: Missing keeps the topic levels already entered and they still count
// (probe, 22 Oct 2026), which only an aligned task has.
export function flagGuide(code, firstName, { aligned = false } = {}) {
  const who = firstName ? `${firstName}'s` : "the student's";
  switch (Number(code)) {
    case 1: return `Left out of ${who} grade.`;
    case 6: return `Left out of ${who} grade while flagged.`;
    case 5: return `Absent for this task. Left out of ${who} grade.`;
    case 2: return 'No grade while flagged.';
    case 3: return aligned ? 'Scores this task as zero. Topic levels already entered still count.' : 'Scores this task as zero.';
    default: return '';
  }
}
