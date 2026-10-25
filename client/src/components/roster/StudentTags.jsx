import { useHelpPop } from '../HelpDot.jsx';
import { genderTag } from '../../lib/genderTag.js';

// The small muted tags right after a student's name on the Roster card (25 Oct 2026, #160), Private
// details only: RosterCard draws none of this with the switch off. Today the group holds the gender
// tag; age (#191) is meant to be added as its first tag, so a new tag is one more child here and the
// card's layout does not change.
//
// A tag is a short code. Its full label is the aria-label and an instant popover on hover or focus
// (a tap on a phone), the shared `.help-pop` (components/HelpDot.jsx), not a native title delay.

export function Tag({ label, children }) {
  const { handlers, popover } = useHelpPop();
  return (
    <>
      <span className="roster-tag" role="img" tabIndex={0} aria-label={label} {...handlers}>{children}</span>
      {popover(label)}
    </>
  );
}

export default function StudentTags({ student }) {
  const gender = genderTag(student.gender);
  return (
    <span className="roster-tags">
      <Tag label={gender.label}>{gender.code}</Tag>
    </span>
  );
}
