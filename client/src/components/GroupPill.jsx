// The filter rows' group pill (docs/design-language.md, "Assessment page filter controls"): an outlined
// pill with a select-all checkbox (empty = none on, dash = some, tick on a filled pill = all), the row's
// label and how many students it covers. Presentational: the caller works out the state and what a
// click does. Used by the assessment page (AssessmentFilterBar) and the Roster tab (RosterFilters).
// className: the row's colour modifier (`group-pill--watch` is the muted ink). What a click does shows
// as the instant popover (Tip), not a native title.
import { Tip } from './HelpDot.jsx';

// none / some / all, from how many of a row's pills are on.
export const groupState = (on, total) => (on === 0 ? 'none' : on === total ? 'all' : 'some');

export default function GroupPill({ label, state, count, className = '', onClick }) {
  return (
    <Tip
      as="button" named={false}
      type="button" className={`group-pill${className ? ` ${className}` : ''}`} data-state={state}
      aria-pressed={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      text={state === 'all' ? `Clear every ${label} filter` : `Select every ${label} filter`}
      onClick={onClick}
    >
      <span className="group-pill__box" aria-hidden="true" />
      {label}
      <span className="group-pill__n">{count}</span>
    </Tip>
  );
}
