// Turns the GET /api/mastery/:courseId payload into per-cell rubric data for
// the course gradebook (#32). Pure functions — all the logic the dumb React
// renderers depend on lives here and is unit-tested.

// Order topics by category external_id, then topic external_id — the same
// ordering the mastery summary and assessment pages use.
function compareTopicMeta(a, b) {
  const byCat = String(a.category_external_id ?? '').localeCompare(String(b.category_external_id ?? ''));
  if (byCat !== 0) return byCat;
  return String(a.external_id ?? '').localeCompare(String(b.external_id ?? ''));
}

// Build { topicMeta, topicsByAssignment, gradeLookup } from the payload.
export function indexMastery(mastery) {
  const categories = mastery?.categories ?? [];
  const topics = mastery?.topics ?? [];
  const scores = mastery?.scores ?? [];
  const alignments = mastery?.alignments ?? [];

  const categoryById = {};
  for (const c of categories) categoryById[c.id] = c;

  // topicMeta: topic id → display metadata. Seed from `topics` (joined to
  // `categories`), then let `alignments` rows — which carry their own
  // metadata — overwrite as the authoritative source.
  const topicMeta = {};
  for (const t of topics) {
    const cat = categoryById[t.category_id];
    topicMeta[t.id] = {
      title: t.title,
      external_id: t.external_id,
      category_title: cat?.title ?? null,
      category_external_id: cat?.external_id ?? null,
    };
  }
  for (const a of alignments) {
    topicMeta[a.topic_id] = {
      title: a.topic_title,
      external_id: a.topic_external_id,
      category_title: a.category_title ?? null,
      category_external_id: a.category_external_id ?? null,
    };
  }

  // topicsByAssignment: assignment → ordered topic ids. Alignments are
  // authoritative; for an assignment with no alignment rows, fall back to the
  // union of topics that have a score for it.
  const alignedAssignments = new Set(alignments.map(a => a.assignment_schoology_id));
  const topicSetByAssignment = {};
  for (const a of alignments) {
    (topicSetByAssignment[a.assignment_schoology_id] ??= new Set()).add(a.topic_id);
  }
  for (const s of scores) {
    if (alignedAssignments.has(s.assignment_schoology_id)) continue;
    (topicSetByAssignment[s.assignment_schoology_id] ??= new Set()).add(s.topic_id);
  }
  const topicsByAssignment = {};
  for (const [aid, set] of Object.entries(topicSetByAssignment)) {
    topicsByAssignment[aid] = [...set].sort((x, y) =>
      compareTopicMeta(topicMeta[x] ?? {}, topicMeta[y] ?? {})
    );
  }

  // gradeLookup: student uid → assignment → topic → letter grade.
  const gradeLookup = {};
  for (const s of scores) {
    const uid = String(s.student_uid);
    ((gradeLookup[uid] ??= {})[s.assignment_schoology_id] ??= {})[s.topic_id] = s.grade ?? null;
  }

  return { topicMeta, topicsByAssignment, gradeLookup };
}

// Ordered [{ topic_id, title, external_id, category_title, grade }] for one
// (assignment, student) gradebook cell. `grade` is null for ungraded topics.
export function buildAssignmentRubric(assignmentSchoologyId, studentUid, indexed) {
  const topicIds = indexed.topicsByAssignment[assignmentSchoologyId] ?? [];
  const grades = indexed.gradeLookup[String(studentUid)]?.[assignmentSchoologyId] ?? {};
  return topicIds.map(topicId => {
    const meta = indexed.topicMeta[topicId] ?? {};
    return {
      topic_id: topicId,
      title: meta.title ?? '',
      external_id: meta.external_id ?? '',
      category_title: meta.category_title ?? null,
      grade: grades[topicId] ?? null,
    };
  });
}
