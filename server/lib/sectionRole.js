// Which of the sections Schoology lists for the teacher are the teacher's own courses.
// GET /users/{me}/sections (with or without include_past=1) lists every section the teacher is
// enrolled in, as a member too (admin 0): another teacher's class the teacher sat in, or a faculty
// group. The teacher cannot read such a section's grades (403) and its "students" are someone
// else's, with the teacher among them. Verified 24 Oct 2026: 83 listed, 3 with admin 0 (MAD
// 3(A-B) 21-22, `5166469329`, and two HS Interim (Faculty) sections). A row with no admin field is kept.
// An admin section is the teacher's course even when a colleague taught it: teachers add each other as
// admin to co-teach, and Graham took over his predecessor's 2021-22 courses that way (Graham, 24 Oct 2026).
export const isTeacherOf = (section) => !('admin' in section) || String(section.admin) === '1';
