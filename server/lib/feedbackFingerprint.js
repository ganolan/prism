// server/lib/feedbackFingerprint.js — visible-feedback snapshot fingerprint (spec Amendment B).
// A fingerprint is a stable JSON string capturing only what the *student* can see: score,
// exception, rubric levels, and comment text (only when Display-to-student is on, and with
// Prism's own status line stripped). Hidden notes, unchanged re-saves and status-line swaps
// never change the fingerprint.
import { teacherText } from './statusLines.js';

// levels: array of { topic_id, grade } — pass mastery_scores rows straight through.
export function fingerprint({ score = null, exception = 0, comment = '', commentStatus = 0, levels = [], storedLine = null } = {}) {
  const s = score == null ? null : score;
  const e = Number(exception) || 0;
  const l = (levels || []).map((level) => `${level.topic_id}:${level.grade}`).sort();
  const visible = Number(commentStatus) === 1;
  const c = visible ? teacherText(comment, storedLine) : '';
  return JSON.stringify({ s, e, l, c });
}

// Did the baseline captured at an arrival represent real prior feedback (as opposed to a
// first submission with nothing graded yet)?
export function hasPriorFeedback(fingerprintString) {
  if (!fingerprintString) return false;
  let parsed;
  try {
    parsed = JSON.parse(fingerprintString);
  } catch {
    return false;
  }
  const { s, e, l, c } = parsed || {};
  return s != null || (Number(e) || 0) > 0 || (Array.isArray(l) && l.length > 0) || Boolean(c);
}
