// Horizontal stacked bar of proficiency-level counts, best level on the left (the order the
// server sends, which follows the rubric). Prism's own levels take the rubric-grid colours
// (LEVEL_COLORS); any other level name, and "Not marked", is neutral. `mini` is the thin
// version for a question row: no labels inside it. `legend` adds swatches with full names.
import { LEVEL_COLORS, masteryCodeForLevel } from '../../lib/masteryLevels.js';

// A segment carries its label only when it has room: at least this share of the bar.
const LABEL_SHARE = 0.12;

export const levelShort = (name) => masteryCodeForLevel(name) || name;
const fill = (name) => LEVEL_COLORS[masteryCodeForLevel(name)]?.headerFill || 'var(--bg-subtle)';

export default function LevelBar({ levels, mini = false, legend = false }) {
  const shown = (levels || []).filter(l => l.count > 0);
  if (!shown.length) return null;
  const total = shown.reduce((n, l) => n + l.count, 0);
  const summary = shown.map(l => `${l.name} ${l.count}`).join(', ');
  return (
    <div className={mini ? 'level-bar level-bar--mini' : 'level-bar'}>
      <div className="level-bar__track" role="img" aria-label={summary}>
        {shown.map(l => (
          <span key={l.name} className="level-seg" title={`${l.name}: ${l.count}`} style={{ flexGrow: l.count, background: fill(l.name) }}>
            {!mini && l.count / total >= LABEL_SHARE && `${levelShort(l.name)} ${l.count}`}
          </span>
        ))}
      </div>
      {legend && (
        <div className="level-bar__legend" aria-hidden="true">
          {shown.map(l => (
            <span key={l.name}><span className="level-bar__swatch" style={{ background: fill(l.name) }} />{`${l.name} ${l.count}`}</span>
          ))}
        </div>
      )}
    </div>
  );
}
