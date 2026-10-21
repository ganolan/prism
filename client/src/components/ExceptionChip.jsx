// The gradebook's stand-in for a grade when Schoology has set Excused, Incomplete or
// Missing (#40): an empty chip with a dashed border, the size of a level chip. A level is a
// filled, colored chip in capitals (ED, EX, ...); the dashed border means "no grade here", and
// the mixed-case code (Exc, Inc, Miss) keeps "Exc" apart from the level "EX". The ink and the
// border take the flag's color (Excused green, Incomplete amber, Missing red).
// savedLevel: the grade Prism saved when the task was excused, if any (Excused only).
const CHIPS = {
  1: { text: 'Exc', tone: 'excused', title: 'Excused: left out of the grade' },
  2: { text: 'Inc', tone: 'incomplete', title: 'Incomplete (set in Schoology)' },
  3: { text: 'Miss', tone: 'missing', title: 'Missing (set in Schoology): counts as zero' },
};

export default function ExceptionChip({ exception, savedLevel = null }) {
  const chip = CHIPS[Number(exception)];
  if (!chip) return null;
  const title = chip.tone === 'excused' && savedLevel ? `${chip.title}. Grade saved in Prism: ${savedLevel}` : chip.title;
  return <span className={`exception-chip exception-chip--${chip.tone}`} title={title}>{chip.text}</span>;
}
