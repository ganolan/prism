// Single source of truth for how a student is named for display.
//
// App-wide precedence: a teacher-set override (`preferred_name_teacher`) beats
// Schoology's synced preferred name (`preferred_name`), which beats the legal
// `first_name`. The client pages (SearchPage, StudentPage, CoursePage, …) and
// server/routes/tools.js all follow this order; centralising it here keeps the
// PrisMCP roster naming students identically to the UI, so AI-suggested
// feedback addresses each student by the name the teacher expects.
//
// Empty strings count as unset (`''` is falsy), so a blank override falls
// through to the next source rather than blanking the name.

export function preferredFirstName(student) {
  return student.preferred_name_teacher || student.preferred_name || student.first_name;
}

export function studentFullName(student) {
  return [preferredFirstName(student), student.last_name].filter(Boolean).join(' ').trim();
}
