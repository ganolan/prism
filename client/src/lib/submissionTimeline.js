// The submission timeline (server: services/submissionTimeline.js) in words, the
// same everywhere it shows: /assessment/ cards, gradebook, student page.
// Every "day N" is the triage clock: school days, due (or extended) date = day 1.
import { lineDate } from './statusLines.js';

const hm = (secs) => {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const localDate = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA');
const when = (secs) => `${lineDate(localDate(secs))} ${hm(secs)}`;
const days = (n) => `${n} school day${n === 1 ? '' : 's'}`;

export const CLOCK_HELP = (limit = 8) =>
  `Day 1 is the due date (or the extended date). Days are school days. Day ${limit} is the last day to submit; after it, work is referred.`;

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
    const past = t.overdue.overLimit ? `, past day ${t.limit}` : '';
    return { key: 'submission', text: `${prefix} · day ${t.overdue.day}${past}`, tone: t.overdue.overLimit ? 'over' : 'late' };
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
        text += s.day === 1 && s.lateMinutes ? ` · day 1, ${s.lateMinutes} min late` : ` · day ${s.day}, late`;
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
    t.referral?.on ? { key: 'referral', text: `Referred ${lineDate(t.referral.on)} (day ${t.referral.day})`, tone: 'over', title: t.referral.note || undefined } : null,
  ].filter(Boolean);
}

// One string per line, for a hover tooltip.
export const timelineSummary = (t) => timelineParts(t).map((p) => p.text).join('\n');
