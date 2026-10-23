// server/lib/pointsTask.js: a mirror of client/src/lib/pointsTask.js (the grade card's rule), so the
// server writes points, builds a draft's baseline and restores a saved score by the rule the card
// draws by. Keep the two identical: client/src/lib/pointsTask.test.js checks parity against this module.
//
// Points-only tasks (#181): scored in plain points ("42 / 50") with no scale and no topics. The
// grade card offers a points box on them.

// Schoology's grading_scale_id for a task scored in plain points ('0'; older rows hold none).
export const hasNoScale = (scaleId) => scaleId == null || String(scaleId) === '' || String(scaleId) === '0';
// A Schoology test or quiz (REST type 'assessment'): Schoology scores it, so Prism writes no points.
export const isTestTask = (assignment) => assignment?.assignment_type === 'assessment' || Number(assignment?.is_test) === 1;

// `topics`: the task's aligned topics, as the card draws them; `scoreScale`: its score scale or null.
export function canEditPoints(assignment, topics, scoreScale) {
  return !!assignment && topics.length === 0 && !scoreScale && hasNoScale(assignment.grading_scale_id) && !isTestTask(assignment);
}

// Typed points → a number of 0 or more, or null when the text is not one.
export function parsePoints(text) {
  const t = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
