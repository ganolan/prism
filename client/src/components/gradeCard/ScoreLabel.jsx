import FlagSymbol from '../FlagSymbol.jsx';
import { LEVEL_COLORS, CELL_TEXT, masteryCodeForLevel } from '../../lib/masteryLevels.js';

// A gradeLabel() result for an unaligned task: a level chip in the level's colour
// for General Academic levels, the raw text otherwise, red when it matches no level.
// A flag (Exempt/Incomplete/Missing/Absent/Late) shows its symbol in the score's place.
// savedLevel: the grade Prism saved when the flag was set (null when none).
export default function ScoreLabel({ label, savedLevel = null, firstName = null, reasonLine = null }) {
  if (label.kind === 'exception') return <FlagSymbol code={label.exception} size="inline" showName firstName={firstName} savedLevel={savedLevel} reasonLine={reasonLine} />;
  const code = label.kind === 'scale' ? masteryCodeForLevel(label.text) : null;
  const c = code ? LEVEL_COLORS[code] : null;
  const style = label.kind === 'mismatch' ? { color: 'var(--danger)' }
    : label.kind === 'pending' ? { color: 'var(--text-muted)' }
    : c ? { background: c.headerFill, color: CELL_TEXT, border: `1px solid ${c.finalBorder}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block' }
    : null;
  return (
    <span className="text-sm" style={style}
      title={label.kind === 'mismatch' ? 'Score does not match any defined level on this grading scale: check Schoology' : undefined}>
      {label.text}
    </span>
  );
}

