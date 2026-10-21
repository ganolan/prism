// Schoology's grade flags ("exceptions"), as probed live on 21 October 2026 (#40,
// .claude/schoology-api-reference.md "Grade exceptions (flags)"): 1 Exempt, 2 Incomplete,
// 3 Missing, 5 Absent, 6 Late. 4 is invalid. Every flag removes the grade on this account
// (Missing sets it to 0). The server mirror of the codes is server/lib/flags.js.
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

// One line per flag for the menu and the symbol's popover. The student's first name makes it
// read as theirs; with none it says "the student".
export function flagGuide(code, firstName) {
  const who = firstName ? `${firstName}'s` : "the student's";
  switch (Number(code)) {
    case 1: return `Left out of ${who} grade.`;
    case 6: return `Left out of ${who} grade while flagged.`;
    case 5: return `Absent for this task. Left out of ${who} grade.`;
    case 2: return 'No grade while flagged.';
    case 3: return `Counts as zero in ${who} grade.`;
    default: return '';
  }
}
