// Prominent per-student submission-status pill for the assessment summary page.
// Reuses gradeLabel.submissionStatus so the colours + due-date rules match the
// gradebook exactly. Always computes the submission badge (score: null) because
// here the pill and the grade coexist — the rubric grid shows the grade.
// One pill for the student's state: a resubmission that has arrived reads
// "Resubmitted" (the blue resubmission tone), and lateness is a clock on the pill's
// corner (LateClock), not a pill of its own (17/10/2026). A Schoology flag (Exempt, Late, Absent,
// Incomplete, Missing; #40) shows as its symbol with its name, as everywhere a flag shows, with the
// popover (what it does, the reason line, the grade Prism saved). `aligned`: the task has topics.

import { submissionStatus, ltiStatusUnavailable } from '../lib/gradeLabel.js';
import { TONE_VARS } from '../lib/assessmentFilters.js';
import { lateText } from '../lib/submissionTimeline.js';
import LateClock from './LateClock.jsx';
import { Tip } from './HelpDot.jsx';
import FlagSymbol from './FlagSymbol.jsx';
import { preferredFirstName } from '../lib/studentNames.js';

const PILL = {
  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
  height: '1.7rem', boxSizing: 'border-box', padding: '0 0.7rem',
  borderRadius: 999, fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap',
};

export default function SubmissionStatusPill({ student, assignment, aligned = false }) {
  const badges = submissionStatus({
    score: null,
    exception: student.exception ?? 0,
    // The timeline's lateness counts a Prism extension; Schoology's flag doesn't.
    late: student.timeline?.submission?.late ?? student.late,
    draft: student.draft,
    submitted_at: student.submitted_at,
    submission_type: student.submission_type,
    is_lti_submission: assignment.is_lti_submission,
    lti_submission_state: student.lti_submission_state,
    due_date: assignment.due_date,
    accepts_submissions: assignment.accepts_submissions,
    is_test: assignment.is_test,
  });

  if (badges.length === 0) {
    if (ltiStatusUnavailable({
      is_lti_submission: assignment.is_lti_submission,
      lti_fetch_status: assignment.lti_fetch_status,
      score: null,
      exception: student.exception ?? 0,
    })) {
      return (
        <Tip style={{ ...PILL, background: 'var(--warning-light)', color: 'var(--warning)', border: '2px solid var(--warning)' }}
          text="Prism couldn't read the submission status for this assignment at the last sync, re-sync to refresh.">
          <span aria-hidden="true">⚠ </span>Status unavailable
        </Tip>
      );
    }
    return null;
  }

  const resubmitted = student.resubmission?.state === 'arrived' || !!student.resubmitted;
  return (
    <span style={{ display: 'inline-flex', gap: '0.35rem' }}>
      {badges.map(b => {
        if (b.kind === 'exception') {
          return (
            <span key={b.kind} className="status-pill-wrap status-pill-wrap--flag">
              <FlagSymbol code={Number(student.exception)} size="inline" showName firstName={preferredFirstName(student)} aligned={aligned}
                savedLevel={student.saved_grade?.summary ?? null} reasonLine={student.flag_line ?? null} />
            </span>
          );
        }
        const shown = resubmitted && b.kind === 'submitted' ? { ...b, label: 'Resubmitted', tone: 'resubmit' } : b;
        const v = TONE_VARS[shown.tone] || TONE_VARS.neutral;
        return (
          <span key={b.kind} className="status-pill-wrap">
            <span style={{ ...PILL, background: v.bg, color: v.text, border: `1px solid ${v.text}` }}>
              {shown.label}
            </span>
            {b.late && <LateClock text={lateText(student.timeline)} />}
          </span>
        );
      })}
    </span>
  );
}
