import HelpDot from './HelpDot.jsx';

// The "?" beside every Synced time (#171; Graham, 20/10/2026): what a refresh covers and when, in
// the teacher's words (the data, not the systems behind it). `button` is the page's sync button;
// `nightly` is whether the night's refresh is on (the scheduler is armed and Settings has it on);
// `onDashboard` says where the button lives when the night's refresh is off.
export const HELP_INTRO = 'Prism keeps this up to date for you.';
export const HELP_LIVE = { label: 'Courses, students, grades and submissions:', text: 'refreshed when you open a page, if older than 10 minutes.' };

export function syncHelpParts({ button, nightly, onDashboard = false }) {
  const night = nightly
    ? 'refreshed every night.'
    : onDashboard ? `refreshed when you press ${button}.` : 'refreshed when you press Sync Courses on the dashboard.';
  return {
    intro: HELP_INTRO,
    bullets: [HELP_LIVE, { label: 'Blocks, calendar and alerts:', text: night }],
    last: `Press ${button} only if you changed something in Schoology just now.`,
  };
}

export default function SyncHelp(props) {
  const { intro, bullets, last } = syncHelpParts(props);
  const label = [intro, ...bullets.map((b) => `${b.label} ${b.text}`), last].join(' ');
  return (
    <HelpDot text={label}>
      <span className="sync-help__intro">{intro}</span>
      <ul className="sync-help__list">
        {bullets.map((b) => <li key={b.label}><strong>{b.label}</strong> {b.text}</li>)}
      </ul>
      <span className="sync-help__last">{last}</span>
    </HelpDot>
  );
}
