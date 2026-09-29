// One-row level picker for an unaligned assignment graded on a plain Schoology
// scale (#41): Completion, General Academic Scale (Unaligned), Approaches to
// Learning. Levels arrive best → worst and render left → right. Visual states
// mirror the rubric grid: the synced grade is a filled cell with a solid
// border; a pending (unpublished) choice is a light fill with a dashed border;
// an agent's suggestion (PrisMCP scale_level) gets the fuchsia suggestion ring.
import { LEVEL_COLORS, CELL_TEXT, LEVELS } from '../lib/masteryLevels.js';

// Colour key into the shared 5-level palette. GAS codes use their own colour;
// other scales map by rank so best reads green and worst reads red.
export function paletteKeyFor(scale, index) {
  const code = scale.levels[index].code;
  if (scale.levels.every(l => LEVELS.includes(l.code))) return code;
  const n = scale.levels.length;
  if (index === 0) return 'EX';
  if (index === n - 1) return 'IE';
  return 'D';
}

export default function ScaleLevelPicker({ scale, syncedCode = null, pendingCode = null, suggestedCode = null, locked = false, onSelect }) {
  return (
    <div
      role="group"
      aria-label={scale.name}
      style={{ display: 'grid', gridTemplateColumns: `repeat(${scale.levels.length}, minmax(0, 1fr))`, gap: '0.4rem' }}
    >
      {scale.levels.map((level, i) => {
        const c = LEVEL_COLORS[paletteKeyFor(scale, i)];
        const isPending = level.code === pendingCode;
        const isSynced = level.code === syncedCode && pendingCode == null;
        const isSuggested = level.code === suggestedCode;
        return (
          <button
            key={level.code}
            type="button"
            aria-pressed={isPending || isSynced}
            disabled={locked}
            onClick={() => { if (!locked) onSelect(level.code); }}
            title={isSynced ? 'Current grade in Schoology' : isPending ? 'Not yet published' : undefined}
            style={{
              // Column flex pins the label to the top: a bare <button> centres its
              // content, so levels with shorter descriptors drifted down (#41).
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
              textAlign: 'left', padding: '0.45rem 0.6rem', borderRadius: 6, cursor: locked ? 'default' : 'pointer',
              color: CELL_TEXT, font: 'inherit', fontSize: '0.78rem',
              background: isSynced ? c.headerFill : isPending ? c.draftFill : 'var(--card-bg)',
              border: isSynced ? `2px solid ${c.finalBorder}` : isPending ? `2px dashed ${c.finalBorder}` : '1px solid var(--border)',
              borderTop: `4px solid ${c.headerFill}`,
              boxShadow: isSuggested ? '0 0 0 2px var(--ai-suggest)' : 'none',
            }}
          >
            <strong style={{ display: 'block' }}>
              {level.label}
              {isSuggested && (
                <span style={{ marginLeft: '0.4rem', color: 'var(--ai-suggest)', fontSize: '0.68rem', fontWeight: 700 }}>✦ Suggested</span>
              )}
            </strong>
            {level.descriptor && (
              <span style={{ display: 'block', marginTop: '0.2rem', fontSize: '0.72rem', opacity: 0.8, lineHeight: 1.35 }}>
                {level.descriptor}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
