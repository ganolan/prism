import { gradYearToLevel } from '../lib/gradeLevel.js';

// "Grade 11", or '' for a graduated or unknown year.
export const gradeText = (gradYear) => {
  const level = gradYearToLevel(gradYear);
  return level ? `Grade ${level}` : '';
};

// The line under a person's name that carries, at phone width, the columns a
// phone hides (email, grade, school): one muted line, the parts joined by a dot.
// `phone-only`, so desktop keeps its columns and never shows it (#134).
export default function PersonSub({ parts }) {
  const text = parts.filter(Boolean).join(' · ');
  if (!text) return null;
  return <div className="person-sub phone-only">{text}</div>;
}
