import { useHelpPop } from './HelpDot.jsx';
import { genderTag } from '../lib/genderTag.js';
import { formatDate } from '../lib/formatDate.js';

// The small muted tags beside a student's name in the student page header (27 Oct 2026), Private details
// only: StudentPage draws none of this with the switch off. The group holds the age (#191, from PowerSchool's date
// of birth; its popover gives the date) and then the gender tag. The Roster tab's
// cards drew this group from 25 Oct (#160) until Graham moved it here on 27 Oct: the roster keeps the
// Gender filter and sort, and shows no tag.
//
// A tag is a short code. Its full label is the aria-label and an instant popover on hover or focus
// (a tap on a phone), the shared `.help-pop` (components/HelpDot.jsx), not a native title delay.

export function Tag({ label, children }) {
  const { handlers, popover } = useHelpPop();
  return (
    <>
      <span className="student-tag" role="img" tabIndex={0} aria-label={label} {...handlers}>{children}</span>
      {popover(label)}
    </>
  );
}

export default function StudentTags({ student }) {
  const gender = genderTag(student.gender);
  const dob = student.date_of_birth ? formatDate(`${student.date_of_birth}T00:00:00`) : null;
  return (
    <span className="student-tags">
      {student.age != null && <Tag label={`Age ${student.age}${dob ? `, born ${dob}` : ''}`}>{student.age}</Tag>}
      <Tag label={gender.label}>{gender.code}</Tag>
    </span>
  );
}
