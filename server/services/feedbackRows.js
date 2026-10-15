// Feedback rows (spec 2026-10-13): a rubric attached to an UNALIGNED
// (score-scale) task. Every criterion is a row the teacher marks in Prism; the
// row levels are Prism-only feedback data and never reach Schoology. Only the
// overall scale level is published. Row finals live in rubric_row_levels,
// keyed by criterion name.
import { getRubric } from './rubricStore.js';
import { LEVELS } from '../lib/proficiencyScale.js';

export const ROW_PREFIX = 'row:';

// The task's feedback rows, or null when it is not graded on a score scale.
// The caller passes the scale (scoreScaleFor) so this module needs no topic reads.
export function getFeedbackRows(db, assignmentSchoologyId, scoreScale) {
  if (!scoreScale) return null;
  const att = db.prepare('SELECT rubric_id FROM rubric_attachments WHERE assignment_schoology_id = ?')
    .get(String(assignmentSchoologyId));
  const rubric = att ? getRubric(db, att.rubric_id) : null;
  if (!rubric) return { rubric: null, rows: [] };
  return {
    rubric: { id: rubric.id, name: rubric.name },
    rows: rubric.criteria.map((c) => ({
      criterion: c.criterion_name,
      standard: c.standard_title ?? null,
      category: c.reporting_category ?? null,
      descriptors: Object.fromEntries(
        LEVELS.map((l) => [l, c.descriptors?.[l] ?? (l === 'IE' ? 'Insufficient Evidence' : null)])
      ),
    })),
  };
}

export function getRowLevels(db, assignmentSchoologyId) {
  const out = {};
  const rows = db.prepare(
    'SELECT student_uid, criterion_name, level FROM rubric_row_levels WHERE assignment_schoology_id = ?'
  ).all(String(assignmentSchoologyId));
  for (const r of rows) (out[r.student_uid] ||= {})[r.criterion_name] = r.level;
  return out;
}

export function rowLevelsError(rows, rowLevels) {
  if (!rowLevels || typeof rowLevels !== 'object' || Array.isArray(rowLevels)) return 'rowLevels must be an object of { criterion: level }';
  if (!rows?.length) return 'This assignment has no feedback rows: attach a rubric to it first';
  const names = new Set(rows.map((r) => r.criterion));
  for (const [name, level] of Object.entries(rowLevels)) {
    if (!names.has(name)) return `"${name}" is not a row of the attached rubric`;
    if (level !== null && !LEVELS.includes(level)) return `${JSON.stringify(level)} is not a level (${LEVELS.join(', ')})`;
  }
  return null;
}

export function saveRowLevels(db, { assignmentSchoologyId, studentUid, rowLevels }) {
  const upsert = db.prepare(`
    INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (assignment_schoology_id, student_uid, criterion_name)
    DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at
  `);
  const del = db.prepare(
    'DELETE FROM rubric_row_levels WHERE assignment_schoology_id = ? AND student_uid = ? AND criterion_name = ?'
  );
  db.transaction(() => {
    for (const [name, level] of Object.entries(rowLevels || {})) {
      if (level == null) del.run(String(assignmentSchoologyId), String(studentUid), name);
      else upsert.run(String(assignmentSchoologyId), String(studentUid), name, level);
    }
  })();
}

export function resolveRowKey(rows, key) {
  const k = String(key ?? '').trim().toLowerCase();
  if (!k) return null;
  const byName = rows.find((r) => String(r.criterion ?? '').trim().toLowerCase() === k);
  if (byName) return byName.criterion;
  // A standard text two rows share names no single row: unresolved, never the first one.
  const byStandard = rows.filter((r) => String(r.standard ?? '').trim().toLowerCase() === k);
  return byStandard.length === 1 ? byStandard[0].criterion : null;
}

export function hiddenRowLevelCount(db, assignmentSchoologyId, rowNames) {
  const names = new Set(rowNames);
  return db.prepare('SELECT criterion_name FROM rubric_row_levels WHERE assignment_schoology_id = ?')
    .all(String(assignmentSchoologyId))
    .filter((r) => !names.has(r.criterion_name)).length;
}

export function orderedRowLevels(rowNames, levelsByName) {
  const levels = levelsByName || {};
  const known = rowNames.filter((n) => levels[n] != null).map((n) => ({ criterion: n, level: levels[n] }));
  const extra = Object.keys(levels).filter((n) => !rowNames.includes(n)).sort()
    .map((n) => ({ criterion: n, level: levels[n] }));
  return [...known, ...extra];
}
