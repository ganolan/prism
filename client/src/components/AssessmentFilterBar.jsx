// Filter rows for the assessment summary page.
//  - Needs action / Watch: one pill per reason a student needs attention, shown only
//    while some student has that reason. Any of the selected reasons matches. The
//    row's label is a button that selects (or clears) every pill in its row.
//  - Refine (collapsed): the descriptive pills (submission status, grading,
//    visibility, flag, resubmit request). OR within a group, AND across groups,
//    applied by the page via passesFilters. This component only renders + reports.

import { useState } from 'react';
import {
  filterGroups, pillTone, countMatches, TONE_VARS, REASONS, reasonIdsIn, countReasons,
} from '../lib/assessmentFilters.js';

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

function ReasonRow({ label, group, counts, active, onToggle, onSetMany, empty }) {
  const ids = reasonIdsIn(group).filter(id => counts[id] > 0);
  const all = ids.length > 0 && ids.every(id => active.has(id));
  return (
    <div role="group" aria-label={label} className="assessment-filter-row">
      {ids.length > 0 && onSetMany ? (
        <button
          type="button" className="assessment-filter-row__label assessment-filter-row__group"
          aria-pressed={all}
          title={all ? `Clear every ${label} filter` : `Select every ${label} filter`}
          // Clearing removes the whole group, including reasons no student has now.
          onClick={() => onSetMany(all ? reasonIdsIn(group) : ids, !all)}
        >
          {label}:
        </button>
      ) : (
        <span className="assessment-filter-row__label text-sm text-muted">{label}:</span>
      )}
      {ids.length === 0 && <span className="text-sm text-muted">{empty}</span>}
      {ids.map(id => (
        <FilterPill key={id} label={REASONS[id].label} count={counts[id]}
          active={active.has(id)} tone={REASONS[id].tone} onClick={() => onToggle(id)} />
      ))}
    </div>
  );
}

// hasDraft(student): the page's live "this card has an unpublished Prism draft".
// onSetMany(ids, on): select or clear several pills at once (a row's label button).
export default function AssessmentFilterBar({ students, assignment, topics, active, onToggle, onSetMany, onClear, hasDraft }) {
  const groups = filterGroups(assignment);
  const ctx = { assignment, topics, hasDraft };
  const counts = countReasons(students, ctx);
  const refineActive = groups.reduce((n, g) => n + g.pills.filter(p => active.has(p.id)).length, 0);
  const [refineOpen, setRefineOpen] = useState(refineActive > 0);
  const open = refineOpen || refineActive > 0;
  return (
    <div className="assessment-filter-bar">
      <ReasonRow label="Needs action" group="action" counts={counts} active={active} onToggle={onToggle} onSetMany={onSetMany} empty="Nothing needs action" />
      <ReasonRow label="Watch" group="watch" counts={counts} active={active} onToggle={onToggle} onSetMany={onSetMany} empty="Nothing to watch" />
      <div className="assessment-filter-row">
        <button type="button" className="ghost btn-sm" aria-expanded={open} onClick={() => setRefineOpen(o => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Refine{refineActive > 0 ? ` (${refineActive})` : ''}
        </button>
        {active.size > 0 && onClear && (
          <button type="button" className="ghost btn-sm" onClick={onClear}>Clear filters</button>
        )}
      </div>
      {open && (
        <div role="group" aria-label="Refine" className="assessment-filter-row">
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
      )}
    </div>
  );
}
