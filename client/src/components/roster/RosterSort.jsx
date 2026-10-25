import { ROSTER_SORTS } from '../../lib/rosterSort.js';

// "Sort by" above the Roster mode's cards (25 Oct 2026, #160): First name, Last name, and with
// Private details on, Gender. Pills in the filter bar's own style (`.filter-btn`, `aria-pressed`).
// `sort` is the sort in force (RosterTab resolves Gender to Last name while Private details is off).
export default function RosterSort({ sort, onChange, showPrivate }) {
  return (
    <div className="roster-sort" role="group" aria-label="Sort by">
      <span className="roster-sort__label" aria-hidden="true">Sort by</span>
      {ROSTER_SORTS.filter((s) => showPrivate || !s.private).map((s) => (
        <button key={s.id} type="button" className={`filter-btn${sort === s.id ? ' active' : ''}`}
          aria-pressed={sort === s.id} onClick={() => onChange(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}
