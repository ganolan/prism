// Pure parsers for the rubric attached to an essay question (browser session,
// read-only; verified 2026-10-12, .claude/schoology-api-reference.md):
//   GET /iapi/grades/rubric/{rubricId}
//   GET /iapi/grades/assessment_component_submission_rubric_grade_info/{rubricId}/{qid}/{enrollmentId}/{attemptId}
// Each column description opens with the level name and a colon ("Exhibiting:").
export function parseQuizRubric(json) {
  const body = json?.body;
  if (!body || !Array.isArray(body.rows)) return null;
  return {
    id: String(body.id),
    title: body.title ?? '',
    totalPoints: Number(body.total_points),
    rows: body.rows.map(r => ({
      id: String(r.id),
      title: r.title ?? '',
      maxPoints: Number(r.max_points),
      levels: (r.columns || [])
        .map(c => ({
          points: Number(c.pts),
          name: String(c.description ?? '').split(':')[0].trim(),
          descriptionHtml: String(c.description ?? ''),
        }))
        .sort((a, b) => b.points - a.points),
    })),
  };
}

export function parseRubricGradeInfo(json) {
  const info = json?.body?.gradeInfo;
  if (!info || typeof info !== 'object') return null;
  const out = {};
  for (const [rowId, v] of Object.entries(info)) {
    const g = v?.grade;
    out[rowId] = { points: g === '' || g == null ? null : Number(g), comment: v?.comment ?? '' };
  }
  return out;
}

export function levelNameFor(rubric, rowId, points) {
  const row = rubric?.rows.find(r => r.id === String(rowId));
  return row?.levels.find(l => l.points === Number(points))?.name ?? null;
}
