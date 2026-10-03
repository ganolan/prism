// server/lib/feedbackFingerprint.js — visible-feedback snapshot fingerprint (spec Amendment B).
// A fingerprint is a stable JSON string capturing only what the *student* can see: score,
// exception, rubric levels, and comment text (only when Display-to-student is on, and with
// Prism's own status line stripped). Hidden notes, unchanged re-saves and status-line swaps
// never change the fingerprint.
import { teacherText } from './statusLines.js';

// Normalise a score so 80, '80' and 80.0 (same grade, different representations coming from
// Schoology vs. SQLite vs. Prism's own writes) all collapse to one fingerprint value.
function normaliseScore(score) {
  if (score == null || score === '') return null;
  const n = Number(score);
  return Number.isNaN(n) ? null : n;
}

// levels: array of { topic_id, grade } — pass mastery_scores rows straight through.
export function fingerprint({ score = null, exception = 0, comment = '', commentStatus = 0, levels = [], storedLine = null } = {}) {
  const s = normaliseScore(score);
  const e = Number(exception) || 0;
  const l = (levels || []).map((level) => `${String(level.topic_id)}:${String(level.grade)}`).sort();
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
