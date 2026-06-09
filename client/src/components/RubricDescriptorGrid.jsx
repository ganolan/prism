import AiSparkle from './AiSparkle.jsx';
import { categoryColor } from '../lib/rubricColors.js';
import { LEVEL_LABELS } from '../lib/masteryLevels.js';

export default function RubricDescriptorGrid({
  rows, levels, cellState, onSelect, palette, levelHeaderColors, levelBorderColors,
}) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
      <thead>
        <tr>
          <th style={{ padding: '0.3rem 0.6rem', textAlign: 'left', background: 'var(--bg-subtle)',
            border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.75rem',
            color: 'var(--text-muted)', minWidth: 180 }}>Measurement Topic</th>
          {levels.map(l => (
            <th key={l} style={{ padding: '0.3rem 0.5rem', textAlign: 'center', width: '15%',
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
              <div style={{ fontSize: '0.72rem', fontWeight: 600 }}>{topic.title}</div>
              <div style={{ fontSize: '0.62rem', color: '#3a3a3a' }}>
                {topic.category_title} · {topic.external_id}</div>
            </td>
            {levels.map(l => {
              const st = cellState(topic.id, l) || {};
              const raw = criterion?.descriptors?.[l] ?? '';
              // Uncovered topics (no criterion) still name the IE floor explicitly.
              const text = (l === 'IE' && !raw) ? 'Insufficient Evidence' : raw;
              const base = {
                padding: '0.35rem 0.45rem', border: '1px solid var(--border)', verticalAlign: 'top',
                background: '#fff', color: '#1a1a1a', cursor: 'pointer', position: 'relative',
                lineHeight: 1.32, fontSize: '0.74rem',
              };
              if (st.final) Object.assign(base, {
                boxShadow: `inset 0 0 0 2px ${levelBorderColors[l]}`, background: levelHeaderColors[l], fontWeight: 600 });
              else if (st.draft) Object.assign(base, {
                outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: 'var(--bg-subtle)' });
              else if (st.staged) Object.assign(base, {
                outline: '2px dotted #ef4444', outlineOffset: '-1px', background: '#fff' });
              else if (st.suggested) base.background = 'var(--ai-suggest-wash)';
              return (
                <td key={l} style={base} onClick={() => onSelect(topic.id, l)}
                    title={`Set ${topic.title} to ${LEVEL_LABELS[l]}`}>
                  {text && (l === 'IE'
                    ? <span style={{ color: '#999', fontStyle: 'italic' }}>{text}</span>
                    : text)}
                  {st.suggested && (
                    <AiSparkle size={17} style={{ position: 'absolute', top: 4, right: 5, color: 'var(--ai-suggest)' }} />)}
                  {st.staged && (
                    <span style={{ position: 'absolute', top: 2, right: 5, color: '#ef4444',
                      fontWeight: 800, fontSize: 21, lineHeight: 1 }}>×</span>)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
