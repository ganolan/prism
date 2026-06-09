import { LEVELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';

// Compact rubric shown in place of the score column for aligned assignments.
// One row per measurement topic, one column per level. The student's current
// level is filled solid green (matching the AssessmentSummaryPage rubric).
export default function CompactRubric({ topics }) {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.7rem', lineHeight: 1.2, width: '100%', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{
            padding: '0.2rem 0.45rem', textAlign: 'left',
            background: 'var(--bg-subtle)', border: '1px solid var(--border)',
            fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.65rem',
            width: 'auto',
          }}>Measurement Topic</th>
          {LEVELS.map(l => (
            <th key={l} style={{
              padding: '0.15rem 0.3rem', textAlign: 'center',
              background: LEVEL_COLORS[l].headerFill, color: CELL_TEXT,
              border: '1px solid var(--border)', fontWeight: 700,
              fontSize: '0.68rem', width: '7%',
            }}>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {topics.map(t => (
          <tr key={t.topic_id}>
            <td style={{
              padding: '0.2rem 0.45rem', border: '1px solid var(--border)',
              fontSize: '0.7rem', color: 'var(--text)',
              whiteSpace: 'normal', wordBreak: 'break-word',
            }}>
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              {(t.external_id || t.category_title) && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                  {t.external_id}{t.external_id && t.category_title ? ' · ' : ''}{t.category_title || ''}
                </div>
              )}
            </td>
            {LEVELS.map(l => {
              const isCurrent = t.grade === l;
              const c = LEVEL_COLORS[l];
              return (
                <td key={l} style={{
                  border: `1px solid ${isCurrent ? c.finalBorder : 'var(--border)'}`,
                  textAlign: 'center',
                  padding: '0.2rem 0.3rem',
                  background: isCurrent ? c.headerFill : 'var(--card-bg)',
                  color: isCurrent ? CELL_TEXT : 'var(--text-muted)',
                  fontWeight: isCurrent ? 700 : 400,
                  fontSize: '0.7rem',
                }}>{isCurrent ? l : ''}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
