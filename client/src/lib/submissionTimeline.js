// The submission timeline (server: services/submissionTimeline.js) in words, the
// same everywhere it shows: /assessment/ cards, gradebook, student page.
// Lateness is said as a distance, "3 school days late", never "day N": the
// timetable has cycle days 1-8, so "day 5" read as a timetable day. The server's
// clock day (due date = day 1) is school days late + 1.

const hm = (secs) => {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const localDate = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA');
// Dates are DD/MM with no weekday (17/10/2026: the weekday made the row long, and
// DD/MM is enough within a term). Status lines to students keep lineDate's weekday.
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const when = (secs) => `${dm(localDate(secs))} ${hm(secs)}`;
const days = (n) => `${n} school day${n === 1 ? '' : 's'}`;

export const CLOCK_HELP = (limit = 8) =>
  `Counted in school days after the due date (or the extended date). Work ${limit} or more school days late is referred.`;

const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

// showDue false (the /assessment/ card, whose page header shows the due date): only an
// extension, since it moves the deadline the lateness counts from.
function dueLine(t, showDue) {
  if (!t.due?.date) return null;
  if (!showDue) {
    return t.extension ? { key: 'due', text: `Extended to ${dm(t.extension.until)}`, title: t.extension.note || undefined } : null;
  }
  const due = `Due ${dm(t.due.date)}${t.due.time ? ` ${t.due.time}` : ''}`;
  if (!t.extension) return { key: 'due', text: due };
  return {
    key: 'due', text: `${due}, extended to ${dm(t.extension.until)}`,
    title: t.extension.note || undefined,
  };
}

function submissionLine(t) {
  const s = t.submission;
  const clock = (prefix) => {
    if (!t.overdue) return { key: 'submission', text: prefix };
    const over = t.overdue.overLimit ? ', over the limit' : '';
    return { key: 'submission', text: `${prefix} (${days(t.overdue.day - 1)} overdue${over})`, tone: t.overdue.overLimit ? 'over' : 'late' };
  };
  switch (s.state) {
    case 'excused': return { key: 'submission', text: 'Excused' };
    case 'in_progress': return clock(t.overdue ? 'In progress, not submitted' : 'In progress');
    case 'not_started': return clock('Not started');
    case 'not_submitted': return t.overdue ? clock('Not submitted') : null;
    case 'submitted': {
      if (!s.firstAt) {
        return s.late ? { key: 'submission', text: 'Submitted (late, per Schoology)', tone: 'late' } : { key: 'submission', text: 'Submitted' };
      }
      let text = `Submitted ${when(s.firstAt)}`;
      let tone;
      let title;
      if (s.late) {
        const lateness = lateText(t);
        text += ` (${lateness[0].toLowerCase()}${lateness.slice(1)})`;
        tone = 'late';
      } else if (t.extension) {
        text += ' (on time, extension)';
        if (s.schoologyLate) title = 'Schoology marks it late against the original due date; it was on time against the extension.';
      }
      // A later revision: the resubmission part says it when one has arrived.
      if (s.latestAt && s.latestAt - s.firstAt >= 60 && t.resubmission?.state !== 'arrived') text += `, latest ${when(s.latestAt)}`;
      return { key: 'submission', text, tone, title };
    }
    default: return null; // untracked: not handed in online
  }
}

function resubmissionLine(t) {
  const r = t.resubmission;
  if (!r) return null;
  if (r.state === 'arrived' && r.arrivedOn) {
    // The latest revision's time, when it is the arrival (same day).
    const latest = t.submission?.latestAt;
    const at = latest && localDate(latest) === r.arrivedOn ? when(latest) : dm(r.arrivedOn);
    return {
      key: 'resubmission', text: `Resubmitted ${at}${r.afterDeadline ? ', after its deadline' : ''}`,
      tone: r.afterDeadline ? 'late' : undefined,
    };
  }
  if (r.askedOn) return { key: 'resubmission', text: `Resubmission asked ${dm(r.askedOn)}${r.until ? `, due ${dm(r.until)}` : ''}` };
  return null;
}

// How late the submission was, for the late clock's hover ("1 h 23 min late").
export function lateText(t) {
  const s = t?.submission;
  if (!s?.late) return 'Late';
  if (s.lateMinutes) return `${minutes(s.lateMinutes)} late`;
  if (s.day > 1) return `${days(s.day - 1)} late`;
  return 'Late, before the next school day';
}

// → [{ key, text, tone?: 'late' | 'over', title? }] in reading order.
export function timelineParts(t, { showDue = true } = {}) {
  if (!t) return [];
  return [
    dueLine(t, showDue),
    submissionLine(t),
    resubmissionLine(t),
    t.referral?.on ? (t.referral.action === 'waived'
      ? { key: 'referral', text: `Referral waived ${dm(t.referral.on)} (${days(t.referral.day - 1)} late)`, title: t.referral.note || undefined }
      : { key: 'referral', text: `Referred ${dm(t.referral.on)} (${days(t.referral.day - 1)} late)`, tone: 'over', title: t.referral.note || undefined }) : null,
  ].filter(Boolean);
}

// One string per line, for a hover tooltip.
export const timelineSummary = (t, opts) => timelineParts(t, opts).map((p) => p.text).join('\n');
