import AiSparkle from './AiSparkle.jsx';
import { categoryColor } from '../lib/rubricColors.js';
import { LEVEL_LABELS } from '../lib/masteryLevels.js';
import { categoryLabels } from '../lib/categoryAbbr.js';
import { TopicSource } from './CategoryTag.jsx';

// Without `onSelect` the grid is read-only (the grade card's view mode, #176): no
// click, no pointer, no "Set ... to ..." hint; the awarded cell keeps its fill.
// `awardedMark` (a node) sits at the end of every awarded cell: the read-only card puts the Missing
// symbol there when it shows IE for work marked Missing (#40).
// Column balance (#176): the topic column is 16% and the level headers carry no width, so the five
// levels share the rest and no descriptor cell is far taller than the others.
export default function RubricDescriptorGrid({
  rows, levels, cellState, onSelect, palette, levelHeaderColors, levelBorderColors, levelDraftColors,
  firstColumnLabel = 'Measurement Topic', awardedMark = null,
}) {
  // Each row's category as its short label, full name on hover (#196).
  const labels = categoryLabels(rows.map(({ topic }) => topic.category_title));
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
      <thead>
        <tr>
          <th style={{ padding: '0.3rem 0.6rem', textAlign: 'left', background: 'var(--bg-subtle)',
            border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.75rem',
            color: 'var(--text-muted)', width: '16%', minWidth: 140 }}>{firstColumnLabel}</th>
          {levels.map(l => (
            <th key={l} style={{ padding: '0.3rem 0.5rem', textAlign: 'center',
              background: levelHeaderColors[l], color: '#1a1a1a', border: '1px solid var(--border)',
              fontWeight: 700, fontSize: '0.72rem' }}>{LEVEL_LABELS[l]}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ topic, criterion }) => (
          <tr key={`${topic.id}-${criterion?.id ?? 'none'}`}>
            <td style={{ padding: '0.3rem 0.6rem', border: '1px solid var(--border)', color: '#202020',
              background: categoryColor(topic.category_title, palette), verticalAlign: 'top' }}>
              {criterion?.criterion_name && (
                <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{criterion.criterion_name}</div>)}
              {/* The second line names the standard: an aligned row's topic title, or a
                  feedback row's standard (its title is the criterion, spec 2026-10-13). */}
              {(() => {
                const isRow = topic.title === criterion?.criterion_name;
                const second = isRow ? criterion?.standard_title : topic.title;
                return second ? <div style={{ fontSize: '0.72rem', fontWeight: 600 }}>{second}</div> : null;
              })()}
              <div style={{ fontSize: '0.62rem', color: '#3a3a3a' }}>
                <TopicSource topic={topic} labels={labels} /></div>
            </td>
            {levels.map(l => {
              const st = cellState(topic.id, l) || {};
              const raw = criterion?.descriptors?.[l] ?? '';
              // Uncovered topics (no criterion) still name the IE floor explicitly.
              const text = (l === 'IE' && !raw) ? 'Insufficient Evidence' : raw;
              const base = {
                padding: '0.35rem 0.45rem', border: '1px solid var(--border)', verticalAlign: 'top',
                background: '#fff', color: '#1a1a1a', cursor: onSelect ? 'pointer' : 'default', position: 'relative',
                lineHeight: 1.32, fontSize: '0.74rem',
              };
              if (st.final) Object.assign(base, {
                boxShadow: `inset 0 0 0 2px ${levelBorderColors[l]}`, background: levelHeaderColors[l], fontWeight: 600 });
              else if (st.draft) Object.assign(base, {
                outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: levelDraftColors[l] });
              else if (st.staged) Object.assign(base, {
                outline: '2px dotted #ef4444', outlineOffset: '-1px', background: '#fff' });
              else if (st.suggested) base.background = 'var(--ai-suggest-wash)';
              return (
                <td key={l} style={base} data-awarded={st.final ? 'true' : undefined}
                    onClick={onSelect ? () => onSelect(topic.id, l) : undefined}
                    title={onSelect ? `Set ${topic.title} to ${LEVEL_LABELS[l]}` : undefined}>
                  {/* Corner marks FLOAT (first, before the text) rather than sit
                      absolutely on top: the descriptor's first line wraps around
                      the mark instead of running underneath it. */}
                  {st.suggested && (
                    <span style={{ float: 'right', margin: '-0.1rem -0.15rem 0.1rem 0.3rem', lineHeight: 0, color: 'var(--ai-suggest)' }}>
                      <AiSparkle size={17} />
                    </span>)}
                  {st.staged && (
                    <span style={{ float: 'right', margin: '-0.2rem -0.1rem 0 0.3rem', color: '#ef4444',
                      fontWeight: 800, fontSize: 21, lineHeight: 1 }}>×</span>)}
                  {text && (l === 'IE'
                    ? <span style={{ color: '#999', fontStyle: 'italic' }}>{text}</span>
                    : text)}
                  {st.final && awardedMark && <span className="rubric-cell-mark">{awardedMark}</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
