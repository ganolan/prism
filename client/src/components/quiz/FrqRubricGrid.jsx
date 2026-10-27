// The Schoology rubric stored with an FRQ, one row per criterion and one button per level
// (spec §12). The final cell is filled in its level colour; the AI's cell carries the
// fuchsia sparkle; Schoology's current cell carries a small "S". Clicking sets the final cell.
import AiSparkle from '../AiSparkle.jsx';
import { Tip } from '../HelpDot.jsx';
import { LEVEL_COLORS, masteryCodeForLevel } from '../../lib/masteryLevels.js';

const colorsFor = (name) => LEVEL_COLORS[masteryCodeForLevel(name)] || null;
// Schoology's descriptions open with the level name ("Exhibiting:\n\nYou answer ...").
const descriptionOf = (level) => String(level.descriptionHtml || '').replace(/^[^:]*:\s*/, '').trim();

export default function FrqRubricGrid({ rubric, final = null, suggested = null, schoology = null, onSelect }) {
  return (
    <table className="frq-grid">
      <tbody>
        {rubric.rows.map(row => (
          <tr key={row.id}>
            <th scope="row" className="frq-grid__row">{row.title}</th>
            {row.levels.map(l => {
              const c = colorsFor(l.name);
              const isFinal = final?.[row.id] === l.points;
              const isAi = suggested?.[row.id] === l.points;
              const isSchoology = schoology?.[row.id] === l.points;
              return (
                <td key={l.points}>
                  <button
                    type="button"
                    className={`frq-cell${isFinal ? ' frq-cell--final' : ''}${isAi ? ' frq-cell--ai' : ''}`}
                    aria-label={`${row.title}: ${l.name}`}
                    aria-pressed={isFinal}
                    onClick={() => onSelect(row.id, l.points)}
                    style={isFinal && c ? { background: c.headerFill, boxShadow: `inset 0 0 0 2px ${c.finalBorder}` } : undefined}
                  >
                    <span className="frq-cell__head" style={c ? { background: c.headerFill } : undefined}>
                      {l.name} <span className="frq-cell__pts">{l.points}</span>
                      {isAi && <AiSparkle size={14} />}
                      {isSchoology && <Tip className="frq-cell__s" tabIndex={-1} text="Schoology's current mark">S</Tip>}
                    </span>
                    <span className="frq-cell__desc">{descriptionOf(l)}</span>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
