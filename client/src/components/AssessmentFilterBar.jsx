// Grouped filter toggle pills for the assessment summary page. Mirrors the
// Summative/Formative TypeFilterToggle pattern (themed pill, dot, label, count;
// muted when inactive). OR within a group, AND across groups is applied by the
// page via passesFilters — this component only renders + reports toggles.

import { filterGroups, pillTone, countMatches, TONE_VARS } from '../lib/assessmentFilters.js';

function FilterPill({ label, count, active, tone, onClick }) {
  const v = TONE_VARS[tone] || TONE_VARS.neutral;
  const colorStyle = active
    ? { background: v.bg, color: v.text, boxShadow: `inset 0 0 0 1px ${v.text}` }
    : { background: 'var(--bg-subtle)', color: 'var(--text-muted)', boxShadow: 'inset 0 0 0 1px var(--border)', opacity: 0.7 };
  return (
    <button onClick={onClick} aria-pressed={active}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.3rem 0.7rem', borderRadius: 999, border: 'none',
        cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
        transition: 'opacity 0.12s, background 0.12s', ...colorStyle,
      }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor', opacity: active ? 1 : 0.5 }} />
      {label}
      <span style={{ fontWeight: 700, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

export default function AssessmentFilterBar({ students, assignment, topics, active, onToggle }) {
  const groups = filterGroups(assignment);
  const ctx = { assignment, topics };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.5rem' }}>
      <span className="text-sm text-muted" style={{ marginRight: '0.1rem' }}>Filter:</span>
      {groups.map((g, gi) => (
        <span key={g.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          {gi > 0 && <span aria-hidden="true" style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 0.2rem' }} />}
          {g.pills.map(p => (
            <FilterPill key={p.id} label={p.label} count={countMatches(students, p.id, ctx)}
              active={active.has(p.id)} tone={pillTone(p.id, assignment)} onClick={() => onToggle(p.id)} />
          ))}
        </span>
      ))}
    </div>
  );
}
