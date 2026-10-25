import { useHelpPop } from './HelpDot.jsx';
import { usePrivateDetails } from '../lib/privateDetails.js';

// Private details across Prism (#197, Graham 25 Oct 2026): one switch, in the left sidebar (the phone's
// menu drawer), that every page showing private student data follows: the dashboard (triage), course
// pages (Roster, Gradebook, Assessments, Analytics, the triage rail), the assessment page and the
// student page. Off by default and remembered on this device (lib/privateDetails.js), so a page may be
// projected. Hidden means not rendered: with the switch off the private parts are not in the page, and
// PrivateHidden stands in their place so the teacher can see what is withheld and which switch shows it.

const HELP = 'Shows private student information on every page: grades, levels, alerts, contacts, notes and triage. '
  + 'Remembered on this device. Keep it off while the screen is projected.';

function EyeIcon({ open }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {!open && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

// The sidebar switch. Amber while on, so a projected screen shows at a glance whether it is safe.
export function PrivateDetailsSwitch() {
  const [on, setOn] = usePrivateDetails();
  // The help opens on hover and focus; a tap only switches (the label is the help a phone needs).
  const { handlers, popover } = useHelpPop();
  const { onMouseEnter, onMouseLeave, onFocus, onBlur } = handlers;
  return (
    <>
      <button type="button" className="private-details-switch" aria-pressed={on}
        onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocus={onFocus} onBlur={onBlur}
        onClick={() => setOn(!on)}>
        <EyeIcon open={on} />
        <span className="private-details-switch__label">Private details</span>
        <span className="private-details-switch__state" aria-hidden="true">{on ? 'On' : 'Off'}</span>
      </button>
      {popover(HELP)}
    </>
  );
}

// The phone's top bar: the switch's state, so it shows with the drawer closed. Not a second control.
export function PrivateDetailsState() {
  const [on] = usePrivateDetails();
  return (
    <span className={`private-details-state${on ? ' private-details-state--on' : ''}`} role="status">
      <EyeIcon open={on} />
      {on ? 'Private details on' : 'Private details off'}
    </span>
  );
}

// What stands in place of private content with the switch off: the same calm box on every page.
// `title` names what is withheld ("Grades are private.").
export function PrivateHidden({ title, className = '' }) {
  return (
    <div className={`private-hidden ${className}`.trim()}>
      <b><EyeIcon open={false} /> {title}</b>
      <span>Turn on Private details in the side menu to see it. It stays hidden so the page is safe to project.</span>
    </div>
  );
}
