// The Attendance tab's rules (#39). A lesson comes from GET /api/attendance/:courseId (services/attendanceMarking.js):
// { taken, codes: [{ code, description }], students: [{ ps_student_id, code, office, markable, ... }] }.
// PowerSchool stores Present as a blank code; Prism makes it a choice (Graham, 29 Oct 2026): until attendance is
// taken, a blank mark is shown as not marked yet, and Save waits until every student is marked.

export const PRESENT = '';
export const MAIN_CODES = [
  { code: PRESENT, label: 'Present' },
  { code: 'T', label: 'Tardy' },
  { code: 'A', label: 'Absent' },
];
const MAIN = new Set(MAIN_CODES.map((c) => c.code));

// A student Prism can mark: one mark in the lesson, not entered by the office.
export const editable = (st) => st.markable && !st.office;

// The choice each student starts with: their mark once attendance is taken; before that, an office mark or a code
// the teacher already set, and null (not marked) for a blank. → { [ps_student_id]: code | null }.
export function initialChoices(lesson) {
  const out = {};
  for (const st of lesson?.students || []) {
    if (!st.markable) out[st.ps_student_id] = null;
    else if (lesson.taken || st.office || (st.code ?? '') !== PRESENT) out[st.ps_student_id] = st.code ?? '';
    else out[st.ps_student_id] = null;
  }
  return out;
}

// Fill the rest as Present: every editable student not marked yet becomes Present; marks already chosen stay.
export function markAllPresent(choices, lesson) {
  const out = { ...choices };
  for (const st of lesson?.students || []) if (editable(st) && out[st.ps_student_id] == null) out[st.ps_student_id] = PRESENT;
  return out;
}

// The fill button's label, with the count, so it never reads as overriding marks already chosen (Graham, 29 Oct
// 2026: "Mark all present" might make teachers think it overrides what they entered). → null when none is left.
export function fillLabel(choices, lesson) {
  const markable = (lesson?.students || []).filter(editable).length;
  const left = counts(choices, lesson).unmarked;
  if (!left) return null;
  return left === markable ? `Mark all ${left} present` : `Mark the remaining ${left} present`;
}

// → { present, tardy, absent, other, unmarked } over the students who can be marked or carry an office mark.
export function counts(choices, lesson) {
  const c = { present: 0, tardy: 0, absent: 0, other: 0, unmarked: 0 };
  for (const st of lesson?.students || []) {
    if (!st.markable) continue;
    const code = choices[st.ps_student_id];
    if (code == null) c.unmarked += 1;
    else if (code === PRESENT) c.present += 1;
    else if (code === 'T') c.tardy += 1;
    else if (code === 'A') c.absent += 1;
    else c.other += 1;
  }
  return c;
}

// Any editable student whose choice is not the mark PowerSchool holds.
export function isDirty(choices, lesson) {
  return (lesson?.students || []).some((st) => editable(st) && choices[st.ps_student_id] != null && choices[st.ps_student_id] !== (st.code ?? ''));
}

// Save when every student is marked and there is something to save: a change, or attendance not taken yet.
export function canSave(choices, lesson) {
  if (!lesson?.lesson) return false;
  return counts(choices, lesson).unmarked === 0 && (isDirty(choices, lesson) || !lesson.taken);
}

// The marks the save sends: every editable student's choice. → { [ps_student_id]: code }.
export function marksToSend(choices, lesson) {
  const out = {};
  for (const st of lesson?.students || []) if (editable(st) && choices[st.ps_student_id] != null) out[st.ps_student_id] = choices[st.ps_student_id];
  return out;
}

// The codes for the Other menu: every school code but Present, Tardy and Absent, in PowerSchool's order.
export const otherCodes = (lesson) => (lesson?.codes || []).filter((c) => !MAIN.has(c.code));

// "Illness (I)", or "Present" for the blank code.
export function codeLabel(code, lesson) {
  if (code === PRESENT) return 'Present';
  const c = (lesson?.codes || []).find((x) => x.code === code);
  return c ? `${c.description} (${code})` : code;
}
