// Filter rows for the assessment summary page (design: docs/design-language.md,
// "Assessment page filter controls").
//  - Needs action / Watch: one pill per reason a student needs attention, shown only
//    while some student has that reason. Any of the selected reasons matches. Each row
//    opens with a group pill: a select-all checkbox (empty / dash / tick) that selects
//    every pill in its row, or clears the row.
//  - Refine (a button at the end of the Watch row, collapsed): the descriptive pills
//    (submission status, grading, visibility, flag). OR within a group, AND across
//    groups, applied by the page via passesFilters.
//  - Under the rows: how many students show, and Clear all while a filter is on.
// This component only renders and reports; the page owns the selection.

import { useState } from 'react';
import {
  filterGroups, pillTone, countMatches, TONE_VARS, REASONS, reasonIdsIn, countReasons, studentReasons,
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

const FilterIcon = () => (
  <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M2 3h12M4.5 8h7M7 13h2" />
  </svg>
);
const ClearIcon = () => (
  <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

// A row's group pill: state none / some / all over the row's visible pills; the count is
// how many students have at least one reason in the row.
function GroupPill({ label, group, ids, students, ctx, active, onSetMany }) {
  const on = ids.filter(id => active.has(id)).length;
  const state = on === 0 ? 'none' : on === ids.length ? 'all' : 'some';
  const groupIds = new Set(reasonIdsIn(group));
  const students_ = students.filter(s => studentReasons(s, ctx).some(r => groupIds.has(r.id))).length;
  return (
    <button
      type="button" className={`group-pill group-pill--${group}`} data-state={state}
      aria-pressed={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      title={state === 'all' ? `Clear every ${label} filter` : `Select every ${label} filter`}
      // Clearing removes the whole row, including reasons no student has now.
      onClick={() => onSetMany(state === 'all' ? reasonIdsIn(group) : ids, state !== 'all')}
    >
      <span className="group-pill__box" aria-hidden="true" />
      {label}
      <span className="group-pill__n">{students_}</span>
    </button>
  );
}

function ReasonRow({ label, group, counts, students, ctx, active, onToggle, onSetMany, empty, children }) {
  const ids = reasonIdsIn(group).filter(id => counts[id] > 0);
  return (
    <div role="group" aria-label={label} className="assessment-filter-row">
      {ids.length > 0 ? (
        <>
          <GroupPill label={label} group={group} ids={ids} students={students} ctx={ctx} active={active} onSetMany={onSetMany} />
          <span className="assessment-filter-row__sep" aria-hidden="true" />
        </>
      ) : (
        <span className="text-sm text-muted">{empty}</span>
      )}
      {ids.map(id => (
        <FilterPill key={id} label={REASONS[id].label} count={counts[id]}
          active={active.has(id)} tone={REASONS[id].tone} onClick={() => onToggle(id)} />
      ))}
      {children}
    </div>
  );
}

// hasDraft(student): the page's live "this card has an unpublished Prism draft".
// onSetMany(ids, on): select or clear several pills at once (a group pill).
// shown / total: how many students the filter shows, for the line under the rows.
export default function AssessmentFilterBar({ students, assignment, topics, active, onToggle, onSetMany, onClear, hasDraft, shown = null, total = null, footer = null }) {
  const groups = filterGroups(assignment);
  const ctx = { assignment, topics, hasDraft };
  const counts = countReasons(students, ctx);
  const refineActive = groups.reduce((n, g) => n + g.pills.filter(p => active.has(p.id)).length, 0);
  const [refineOpen, setRefineOpen] = useState(refineActive > 0);
  const open = refineOpen || refineActive > 0;
  const rowProps = { counts, students, ctx, active, onToggle, onSetMany };
  const all = total ?? students.length;
  return (
    <div className="assessment-filter-bar">
      <ReasonRow label="Needs action" group="action" empty="Nothing needs action" {...rowProps} />
      <ReasonRow label="Watch" group="watch" empty="Nothing to watch" {...rowProps}>
        <button type="button" className="filter-btn-outline" aria-expanded={open} onClick={() => setRefineOpen(o => !o)}>
          <FilterIcon /> Refine
          {refineActive > 0 && <span className="filter-btn-outline__badge">{refineActive}</span>}
          <span aria-hidden="true" className="filter-btn-outline__chev">{open ? '▴' : '▾'}</span>
        </button>
      </ReasonRow>
      {open && (
        <div role="group" aria-label="Refine" className="assessment-filter-row assessment-filter-refine">
          <span className="assessment-filter-refine__label">Refine</span>
          {groups.map((g) => (
            <span key={g.key} className="assessment-filter-refine__group">
              {g.pills.map(p => (
                <FilterPill key={p.id} label={p.label} count={countMatches(students, p.id, ctx)}
                  active={active.has(p.id)} tone={pillTone(p.id, assignment)} onClick={() => onToggle(p.id)} />
              ))}
            </span>
          ))}
        </div>
      )}
      <div className="assessment-filter-status">
        <span className="assessment-filter-status__count">
          {active.size > 0 && shown != null
            ? <>Showing <b>{shown}</b> of {all} student{all === 1 ? '' : 's'}</>
            : <>Showing all {all} student{all === 1 ? '' : 's'}</>}
          {footer}
        </span>
        {active.size > 0 && onClear && (
          <button type="button" className="filter-btn-clear" onClick={onClear}><ClearIcon /> Clear all</button>
        )}
      </div>
    </div>
  );
}
