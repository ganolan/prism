// Prominent per-student submission-status pill for the assessment summary page.
// Reuses gradeLabel.submissionStatus so the colours + due-date rules match the
// gradebook exactly. Always computes the submission badge (score: null) because
// here the pill and the grade coexist — the rubric grid shows the grade.

import { submissionStatus, ltiStatusUnavailable } from '../lib/gradeLabel.js';
import { TONE_VARS } from '../lib/assessmentFilters.js';

const PILL = {
  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
  height: '1.7rem', boxSizing: 'border-box', padding: '0 0.7rem',
  borderRadius: 999, fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap',
};

export default function SubmissionStatusPill({ student, assignment }) {
  const badges = submissionStatus({
    score: null,
    exception: student.exception ?? 0,
    late: student.late,
    draft: student.draft,
    submitted_at: student.submitted_at,
    submission_type: student.submission_type,
    is_lti_submission: assignment.is_lti_submission,
    lti_submission_state: student.lti_submission_state,
    due_date: assignment.due_date,
  });

  if (badges.length === 0) {
    if (ltiStatusUnavailable({
      is_lti_submission: assignment.is_lti_submission,
      lti_fetch_status: assignment.lti_fetch_status,
      score: null,
      exception: student.exception ?? 0,
    })) {
      return (
        <span style={{ ...PILL, background: 'var(--warning-light)', color: 'var(--warning)', border: '2px solid var(--warning)' }}
          title="Prism couldn't read the submission status for this assignment at the last sync — re-sync to refresh.">
          <span aria-hidden="true">⚠ </span>Status unavailable
        </span>
      );
    }
    return null;
  }

  return (
    <span style={{ display: 'inline-flex', gap: '0.35rem' }}>
      {badges.map(b => {
        const v = TONE_VARS[b.tone] || TONE_VARS.neutral;
        return (
          <span key={b.kind} style={{ ...PILL, background: v.bg, color: v.text, border: `1px solid ${v.text}` }}>
            {b.label}
          </span>
        );
      })}
    </span>
  );
}
