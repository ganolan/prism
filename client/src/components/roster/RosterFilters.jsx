import { ClearIcon } from '../AssessmentFilterBar.jsx';

// The Roster tab's filters (#160), shown only with Private details on, built from the assessment
// page's controls (docs/design-language.md, "Assessment page filter controls"):
//  - Alerts: a group pill (none / some / all, counting students who hold any alert), a divider, then one
//    pill per alert type some student holds (learning alerts share Learning plan).
//  - Follow up: the muted group pill, then Unread comments.
//  - The status line: "Showing 4 of 12 students" with Copy emails (N) beside it; Clear all on the right.
// Pills combine as "any of". This component renders and reports; RosterTab owns the selection.
// options: rosterFilterOptions (lib/rosterVitals.js). onChange(nextSelectedSet).

const MailIcon = () => (
  <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2.5 4.5 8 9l5.5-4.5" />
  </svg>
);

function Row({ label, watch = false, pills, students, selected, onChange }) {
  if (!pills.length) return null;
  const on = pills.filter((p) => selected.has(p.key)).length;
  const state = on === 0 ? 'none' : on === pills.length ? 'all' : 'some';
  const set = (keys, value) => {
    const next = new Set(selected);
    keys.forEach((k) => (value ? next.add(k) : next.delete(k)));
    onChange(next);
  };
  const toggle = (key) => set([key], !selected.has(key));
  return (
    <div role="group" aria-label={label} className="assessment-filter-row">
      <button type="button" className={`group-pill${watch ? ' group-pill--watch' : ''}`} data-state={state}
        aria-pressed={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
        title={state === 'all' ? `Clear every ${label} filter` : `Select every ${label} filter`}
        onClick={() => set(pills.map((p) => p.key), state !== 'all')}>
        <span className="group-pill__box" aria-hidden="true" />
        {label}
        <span className="group-pill__n">{students}</span>
      </button>
      <span className="assessment-filter-row__sep" aria-hidden="true" />
      {pills.map((p) => (
        <button key={p.key} type="button" className={`filter-btn${selected.has(p.key) ? ' active' : ''}`}
          aria-pressed={selected.has(p.key)} onClick={() => toggle(p.key)}>
          {p.label}
          <span className="filter-btn__n">{p.count}</span>
        </button>
      ))}
    </div>
  );
}

export default function RosterFilters({ options, selected, onChange, shown, total, onCopyEmails }) {
  const students = (n) => (n === 1 ? 'student' : 'students');
  return (
    <div className="assessment-filter-bar roster-filters">
      <Row label="Alerts" pills={options.alerts} students={options.alertStudents} selected={selected} onChange={onChange} />
      <Row label="Follow up" watch pills={options.followUp} students={options.followUpStudents} selected={selected} onChange={onChange} />
      <div className="assessment-filter-status">
        <span className="roster-filter-status__left">
          <span className="assessment-filter-status__count">
            {selected.size > 0
              ? <>Showing <b>{shown}</b> of {total} {students(total)}</>
              : <>Showing all {total} {students(total)}</>}
          </span>
          <button type="button" className="filter-btn-outline" aria-haspopup="dialog" disabled={shown === 0}
            onClick={(e) => onCopyEmails(e.currentTarget)}>
            <MailIcon />Copy emails ({shown})
          </button>
        </span>
        {selected.size > 0 && (
          <button type="button" className="filter-btn-clear" onClick={() => onChange(new Set())}><ClearIcon /> Clear all</button>
        )}
      </div>
    </div>
  );
}
