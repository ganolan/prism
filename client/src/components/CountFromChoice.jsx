import { lineDate } from '../lib/statusLines.js';
import { localIsoDate } from '../lib/formatDate.js';

// Where an extension's school days count from, shown only once the due date has passed
// (before it, both give the same deadline). 'due_date', the default, adds the days to the
// original due date, which can leave the deadline in the past: 3 days on work 5 school days
// overdue leaves it 2 school days overdue. 'today' gives the days from now.
export const overdue = (due) => Boolean(due) && due.slice(0, 10) < localIsoDate();

export default function CountFromChoice({ due, value, onChange }) {
  if (!overdue(due)) return null;
  const pick = (v, label) => (
    <button
      type="button" className={`filter-btn btn-sm${value === v ? ' active' : ''}`}
      aria-pressed={value === v} onClick={() => onChange(v)}
    >
      {label}
    </button>
  );
  return (
    <span className="count-from" role="group" aria-label="Count the school days from">
      {pick('due_date', `From due date ${lineDate(due.slice(0, 10))}`)}
      {pick('today', 'From today')}
    </span>
  );
}

// The confirm modal's "counted from ..." phrase for a choice.
export const countFromText = (due, countFrom) => (
  overdue(due) && countFrom === 'today' ? 'today' : `the due date (${lineDate(due.slice(0, 10))})`
);
