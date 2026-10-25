// Needs attention on the Roster tab (#160, spec "Needs attention"): this course's triage rows grouped
// by student. A client step over triage's own rows (getTriage({ courseId })), so the roster and the
// rail can never disagree: no lateness is worked out here, only which rows count and their order.
//
// A row is in when the next move is the student's, or a referral Graham decides about the student:
//  - Overdue work: overdue (nothing handed in), and handed in late at the limit (Refer or Waive).
//  - Make-up tests still owed.
//  - Resubmissions asked for and not yet arrived (pending, or overdue once red).
//  - Flags that leave the student owing work: Incomplete (2) and Absent (5).
// Out: Feedback owed, Unfinished grading, arrived resubmissions, and the Missing (3), Late (6) and
// saved-grade flag rows, whose advice is Graham's own grading.

export const NEEDS_ATTENTION_LABELS = {
  overdue: 'Overdue',
  late_at_limit: 'Late, handed in',
  make_up: 'Make-up test',
  resub_pending: 'Resubmission pending',
  resub_overdue: 'Resubmission overdue',
  incomplete: 'Incomplete',
  absent: 'Absent',
};

const FLAG_KIND = { 2: 'incomplete', 5: 'absent' };
const TONE_RANK = { red: 0, amber: 1 };

// The rail's order: red, then amber, then the rest; within a tone, the larger share of the limit.
const compareRows = (a, b) => (TONE_RANK[a.tone] ?? 2) - (TONE_RANK[b.tone] ?? 2)
  || b.day / b.limit - a.day / a.limit;

const entry = (kind, row, limit, id = row.assignmentId) => ({
  key: `${kind}:${row.studentId}:${id}`, kind, label: NEEDS_ATTENTION_LABELS[kind],
  day: row.day, limit, tone: row.tone, row,
});

function rowsOf(triage) {
  const { settings = {} } = triage;
  const out = [];
  for (const r of triage.lateWork ?? []) {
    if (r.kind === 'outstanding') out.push(entry('overdue', r, settings.referralLimitDays));
    else if (r.kind === 'submitted_late' && r.tone === 'red') out.push(entry('late_at_limit', r, settings.referralLimitDays));
  }
  for (const r of triage.makeUps ?? []) out.push(entry('make_up', r, settings.makeUpRedDay));
  for (const r of triage.resubmissions ?? []) {
    if (r.state !== 'waiting') continue;
    out.push(entry(r.tone === 'red' ? 'resub_overdue' : 'resub_pending', r, r.limit, r.id));
  }
  for (const r of triage.flags ?? []) {
    const kind = r.kind === 'flag' && FLAG_KIND[r.flag];
    if (kind) out.push(entry(kind, r, r.limit));
  }
  return out;
}

// → [{ studentId, rows: [{ key, kind, label, day, limit, tone, row }] }], students with at least one
// row, most urgent first (each by their first row). `activeStudentIds`: the enrolled (not dropped)
// students, whose rows are the only ones kept.
export function studentRows(triage, activeStudentIds = []) {
  if (!triage) return [];
  const active = new Set([...activeStudentIds].map(Number));
  const byStudent = new Map();
  for (const e of rowsOf(triage)) {
    if (!active.has(Number(e.row.studentId))) continue;
    if (!byStudent.has(e.row.studentId)) byStudent.set(e.row.studentId, []);
    byStudent.get(e.row.studentId).push(e);
  }
  return [...byStudent].map(([studentId, rows]) => ({ studentId, rows: rows.sort(compareRows) }))
    .sort((a, b) => compareRows(a.rows[0], b.rows[0]));
}

// Rows an action just took off triage (referred, waived, extended past today), kept in their place
// so Undo stays reachable: each `held` entry (a studentRows row) joins its student's rows unless
// triage still lists that key. Re-sorted the same way, so nothing jumps.
export function withHeld(groups, held = []) {
  const byStudent = new Map(groups.map((g) => [g.studentId, [...g.rows]]));
  for (const e of held) {
    const id = e.row.studentId;
    if (!byStudent.has(id)) byStudent.set(id, []);
    const rows = byStudent.get(id);
    if (!rows.some((r) => r.key === e.key)) rows.push(e);
  }
  return [...byStudent].map(([studentId, rows]) => ({ studentId, rows: rows.sort(compareRows) }))
    .sort((a, b) => compareRows(a.rows[0], b.rows[0]));
}

const schoolDays = (n) => `${n} school day${n === 1 ? '' : 's'}`;
// The rail's days-left words (LateWorkPanel, ResubmissionsPanel): `last` is the last allowed day.
const left = (day, last) => (last - day > 0 ? `${last - day} left` : 'last day');

// The muted line under a row, in the rail's numbers: the ring shows day - 1, the school days since
// the clock's day 1 (the due date, the test, the ask or the flag).
export function rowWhen(e) {
  const n = e.day - 1;
  const red = e.tone === 'red';
  switch (e.kind) {
    case 'overdue':
    case 'late_at_limit':
      return `${schoolDays(n)} late, ${red ? 'at the limit' : left(e.day, e.limit)}`;
    case 'make_up':
      // Red from makeUpRedDay, so the last day to sit it is the day before.
      return `${schoolDays(n)} since the test, ${red ? 'at the limit' : left(e.day, e.limit - 1)}`;
    case 'resub_pending':
    case 'resub_overdue':
      return `${schoolDays(n)} since asked, ${red ? 'past the deadline' : left(e.day, e.limit)}`;
    default:
      return `${schoolDays(n)} since flagged.${e.row.advice ? ` ${e.row.advice}` : ''}`;
  }
}

// The Schoology flag code the course gradebook (CoursePage's getGradebook) holds for a row's student
// and task (internal ids), or 0. Overdue work rows carry no flag; the gradebook has it.
export function flagOnRow(gradebook, row) {
  return Number(gradebook?.grades?.[row.studentId]?.[row.assignmentId]?.exception) || 0;
}
