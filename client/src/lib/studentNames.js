// Single source of truth for how a student is named for display, client-side.
//
// Precedence: a teacher-set override (`preferred_name_teacher`) beats
// Schoology's synced preferred name (`preferred_name`), which beats the legal
// `first_name`. This mirrors server/services/studentNames.js so the React pages
// and the PrisMCP roster name a student identically. Empty strings count as
// unset (`''` is falsy), so a blank override falls through to the next source.

export function preferredFirstName(student) {
  return student.preferred_name_teacher || student.preferred_name || student.first_name;
}

export function studentFullName(student) {
  return [preferredFirstName(student), student.last_name].filter(Boolean).join(' ').trim();
}
