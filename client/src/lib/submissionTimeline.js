// The submission timeline (server: services/submissionTimeline.js) in words, the
// same everywhere it shows: /assessment/ cards, gradebook, student page.
// Lateness is said as a distance, "3 school days late", never "day N": the
// timetable has cycle days 1-8, so "day 5" read as a timetable day. The server's
// clock day (due date = day 1) is school days late + 1.
import { lineDate } from './statusLines.js';

const hm = (secs) => {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const localDate = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA');
const when = (secs) => `${lineDate(localDate(secs))} ${hm(secs)}`;
const days = (n) => `${n} school day${n === 1 ? '' : 's'}`;

export const CLOCK_HELP = (limit = 8) =>
  `Counted in school days after the due date (or the extended date). Work ${limit} or more school days late is referred.`;

const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

function dueLine(t) {
  if (!t.due?.date) return null;
  const due = `Due ${lineDate(t.due.date)}${t.due.time ? ` ${t.due.time}` : ''}`;
  if (!t.extension) return { key: 'due', text: due };
  return {
    key: 'due', text: `${due} · extended ${days(t.extension.schoolDays)} to ${lineDate(t.extension.until)}`,
    title: t.extension.note || undefined,
  };
}

function submissionLine(t) {
  const s = t.submission;
  const clock = (prefix) => {
    if (!t.overdue) return { key: 'submission', text: prefix };
    const over = t.overdue.overLimit ? ', over the limit' : '';
    return { key: 'submission', text: `${prefix} · ${days(t.overdue.day - 1)} overdue${over}`, tone: t.overdue.overLimit ? 'over' : 'late' };
  };
  switch (s.state) {
    case 'excused': return { key: 'submission', text: 'Excused' };
    case 'in_progress': return clock(t.overdue ? 'In progress, not submitted' : 'In progress');
    case 'not_started': return clock('Not started');
    case 'not_submitted': return t.overdue ? clock('Not submitted') : null;
    case 'submitted': {
      if (!s.firstAt) {
        return s.late ? { key: 'submission', text: 'Submitted · late (per Schoology)', tone: 'late' } : { key: 'submission', text: 'Submitted' };
      }
      let text = `Submitted ${when(s.firstAt)}`;
      let tone;
      let title;
      if (s.late) {
        if (s.lateMinutes) text += ` · ${minutes(s.lateMinutes)} late`;
        else if (s.day > 1) text += ` · ${days(s.day - 1)} late`;
        else text += ' · late, before the next school day';
        tone = 'late';
      } else {
        text += t.extension ? ' · on time (extension)' : ' · on time';
        if (s.schoologyLate && t.extension) title = 'Schoology marks it late against the original due date; it was on time against the extension.';
      }
      if (s.latestAt && s.latestAt - s.firstAt >= 60) text += ` · latest ${when(s.latestAt)}`;
      return { key: 'submission', text, tone, title };
    }
    default: return null; // untracked: not handed in online
  }
}

function resubmissionLine(t) {
  const r = t.resubmission;
  if (!r) return null;
  if (r.state === 'arrived' && r.arrivedOn) {
    return {
      key: 'resubmission', text: `Resubmission arrived ${lineDate(r.arrivedOn)}${r.afterDeadline ? ', after its deadline' : ''}`,
      tone: r.afterDeadline ? 'late' : undefined,
    };
  }
  if (r.askedOn) return { key: 'resubmission', text: `Resubmission asked ${lineDate(r.askedOn)}${r.until ? `, due ${lineDate(r.until)}` : ''}` };
  return null;
}

// → [{ key, text, tone?: 'late' | 'over', title? }] in reading order.
export function timelineParts(t) {
  if (!t) return [];
  return [
    dueLine(t),
    submissionLine(t),
    resubmissionLine(t),
    t.referral?.on ? { key: 'referral', text: `Referred ${lineDate(t.referral.on)} (${days(t.referral.day - 1)} late)`, tone: 'over', title: t.referral.note || undefined } : null,
  ].filter(Boolean);
}

// One string per line, for a hover tooltip.
export const timelineSummary = (t) => timelineParts(t).map((p) => p.text).join('\n');
