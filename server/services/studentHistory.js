/**
 * studentHistory.js — one student across every course Prism holds for them,
 * archived years included: the read side of PrisMCP find_student and
 * get_student_history. Built for reference letters, so the rules are about
 * fidelity:
 *   - Only the teacher's published finals (the Schoology gradebook as synced:
 *     grades + mastery_scores). AI suggestions (feedback table) are never read.
 *     The teacher's own unpublished drafts are opt-in and labelled.
 *   - Comments are returned exactly as stored. The only thing ever removed is a
 *     Prism status line Prism itself added (status_lines), and the response says
 *     so when it happens.
 *   - Read-only: every query is a SELECT.
 * Spec: docs/superpowers/specs/2026-10-08-prismcp-student-history-design.md
 */
import { preferredFirstName, studentFullName } from './studentNames.js';
import { teacherText } from '../lib/statusLines.js';
import { normalizeLevel, pointsToLevel } from '../lib/proficiencyScale.js';
import { schoolYearOf } from '../lib/schoolYear.js';

export class StudentHistoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

// ── Identity ─────────────────────────────────────────────────────────────────

// HKIS student emails are "<6 digits>@hkis.edu.hk" and the first two digits
// usually match the class year (270555 → 2027). Checked 2026-10-08 against the
// 158 students with a synced grad_year: 152 agree, 6 are a year out (repeat or
// accelerated students). So it is a hint, never the grad year.
export function emailCohortHint(email) {
  const m = String(email ?? '').match(/^(\d{2})\d{4}@/);
  return m ? 2000 + Number(m[1]) : null;
}

const NAME_FIELDS = ['first_name', 'last_name', 'preferred_name', 'preferred_name_teacher'];
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();

// Courses that are Prism plumbing, not teaching (#56 templates) never count.
const enrolmentsFor = (db, studentId) => db.prepare(`
  SELECT c.id AS course_id, c.course_name, c.section_name, c.block_number, c.grading_period,
         c.archived, c.hidden, c.schoology_section_id, e.dropped_at, e.status
  FROM enrolments e JOIN courses c ON c.id = e.course_id
  WHERE e.student_id = ? AND c.excluded = 0
`).all(studentId);

function courseSummary(r) {
  const { school_year, term } = schoolYearOf(r.grading_period);
  return {
    course_id: r.course_id,
    course_name: r.course_name,
    section_name: r.section_name ?? null,
    block_number: r.block_number ?? null,
    school_year,
    term,
    archived: r.archived === 1,
    // Archived sections keep everyone; a drop is only known for current courses.
    enrolment: r.dropped_at ? 'dropped' : (r.archived === 1 ? 'completed' : 'current'),
  };
}

// Oldest year first; within a year, Semester 1 before Semester 2.
const TERM_ORDER = { 'Full year': 0, 'Semester 1': 1, 'Semester 2': 2, Summer: 3 };
const byYear = (a, b) => String(a.school_year ?? '9999').localeCompare(String(b.school_year ?? '9999'))
  || (TERM_ORDER[a.term] ?? 9) - (TERM_ORDER[b.term] ?? 9)
  || a.course_name.localeCompare(b.course_name);

function identity(st) {
  const preferred = preferredFirstName(st);
  return {
    id: st.id,
    schoology_uid: st.schoology_uid,
    legal_first_name: st.first_name,
    legal_last_name: st.last_name,
    preferred_first_name: preferred,
    display_name: studentFullName(st),
    preferred_differs_from_legal: norm(preferred) !== norm(st.first_name),
    email: st.email ?? null,
    grad_year: st.grad_year ?? null,
    email_cohort_hint: emailCohortHint(st.email),
  };
}

// Which fields a query token hits, best first: exact, then prefix, then substring.
function tokenHit(st, token) {
  let best = null;
  for (const f of NAME_FIELDS) {
    const v = norm(st[f]);
    if (!v) continue;
    const words = v.split(/[\s-]+/);
    const rank = v === token || words.includes(token) ? 3 : words.some((w) => w.startsWith(token)) ? 2 : v.includes(token) ? 1 : 0;
    if (rank && (!best || rank > best.rank)) best = { rank, field: f };
  }
  const local = norm(String(st.email ?? '').split('@')[0]);
  if (local && local.includes(token)) {
    const rank = local === token ? 3 : 1;
    if (!best || rank > best.rank) best = { rank, field: 'email' };
  }
  return best;
}

/**
 * Search students by legal name, preferred name (Schoology's or the teacher's
 * override), email, schoology_uid or local id, across every course Prism holds,
 * archived ones included. Every word of a name query must match some name field,
 * so "Molly Wong" finds legal "Mei Lin Wong" whose teacher-preferred name is Molly.
 */
export function findStudents(db, { query, include_archived = true, limit = 20 } = {}) {
  const q = norm(query);
  if (!q) throw new StudentHistoryError('BAD_VALUE', 'query is required: a name, email, schoology_uid or student id');
  const all = db.prepare('SELECT * FROM students').all();

  let scored;
  const byUid = all.filter((st) => norm(st.schoology_uid) === q);
  if (byUid.length && !/^\d+$/.test(q)) {
    scored = byUid.map((st) => ({ st, score: 100, matched: ['schoology_uid'] }));
  } else if (/^\d+$/.test(q)) {
    scored = all.flatMap((st) => {
      const matched = [];
      if (String(st.id) === q) matched.push('id');
      if (String(st.schoology_uid) === q) matched.push('schoology_uid');
      if (norm(String(st.email ?? '').split('@')[0]) === q) matched.push('email');
      return matched.length ? [{ st, score: 100, matched }] : [];
    });
  } else if (q.includes('@')) {
    scored = all.filter((st) => norm(st.email) === q).map((st) => ({ st, score: 100, matched: ['email'] }));
  } else {
    const tokens = q.split(/[\s,]+/).filter(Boolean);
    scored = all.flatMap((st) => {
      const hits = tokens.map((t) => tokenHit(st, t));
      if (hits.some((h) => !h)) return [];
      return [{ st, score: hits.reduce((s, h) => s + h.rank, 0), matched: [...new Set(hits.map((h) => h.field))] }];
    });
  }

  const candidates = scored.map(({ st, score, matched }) => {
    let courses = enrolmentsFor(db, st.id).map(courseSummary);
    if (!include_archived) courses = courses.filter((c) => !c.archived);
    return { score, ...identity(st), matched_on: matched, courses: courses.sort(byYear) };
  }).filter((c) => include_archived || c.courses.length > 0);

  candidates.sort((a, b) => b.score - a.score || a.legal_last_name.localeCompare(b.legal_last_name) || a.legal_first_name.localeCompare(b.legal_first_name));
  const capped = candidates.slice(0, Math.max(1, Number(limit) || 20));
  return {
    query: String(query),
    total: candidates.length,
    candidates: capped.map(({ score: _s, ...c }) => c),
    note: 'grad_year comes from the Schoology/PowerSchool profile. email_cohort_hint is read from the email prefix and is usually, not always, the class year: prefer grad_year.',
  };
}

// A student reference for get_student_history: local id, schoology_uid or exact
// email resolve directly; a name must match exactly one student.
export function resolveStudent(db, ref) {
  if (ref == null || String(ref).trim() === '') throw new StudentHistoryError('BAD_VALUE', 'student is required');
  const s = String(ref).trim();
  const direct = db.prepare('SELECT * FROM students WHERE CAST(id AS TEXT) = ? OR schoology_uid = ? OR lower(email) = lower(?)').all(s, s, s);
  if (direct.length === 1) return direct[0];
  const { candidates } = findStudents(db, { query: s, limit: 10 });
  if (candidates.length === 1) return db.prepare('SELECT * FROM students WHERE id = ?').get(candidates[0].id);
  if (candidates.length === 0) throw new StudentHistoryError('NOT_FOUND', `No student matches "${s}". Try find_student with part of the name or the email.`);
  const list = candidates.map((c) => `${c.id} ${c.display_name} (legal ${c.legal_first_name} ${c.legal_last_name}, ${c.email ?? 'no email'}${c.grad_year ? `, class of ${c.grad_year}` : ''})`);
  throw new StudentHistoryError('AMBIGUOUS', `"${s}" matches ${candidates.length} students: ${list.join('; ')}. Pass one id.`);
}

// ── Assessments ──────────────────────────────────────────────────────────────

const parseLevels = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// "See Mastery Gradebook (ED)" → ED; "Exhibiting Depth" → ED; "Completed" stays.
function levelName(name) {
  const inner = String(name).match(/\(([A-Z]{1,2})\)\s*$/);
  if (inner) return normalizeLevel(inner[1]) ?? inner[1];
  return normalizeLevel(name) ?? String(name);
}

function overallLevel(scale, score, maxScore) {
  if (score == null || !scale || scale.levels.length === 0) return null;
  const pct = maxScore > 0 ? (score / maxScore) * 100 : score;
  const hit = [...scale.levels].sort((a, b) => b.cutoff - a.cutoff).find((l) => pct >= Number(l.cutoff));
  return hit ? levelName(hit.name) : null;
}

const isCompletionScale = (scale) => !!scale && scale.levels.length > 0
  && scale.levels.every((l) => /^(in)?complete(d)?$/i.test(String(l.name).trim()));

// Summative / formative from the Schoology grading category, then the "(S)" /
// "(F)" title convention; completion-scale work is its own kind.
function kindOf(a, scale) {
  if (isCompletionScale(scale)) return 'completion';
  const cat = String(a.category_title ?? '');
  if (/summative/i.test(cat)) return 'summative';
  if (/formative/i.test(cat)) return 'formative';
  if (/\(S\)/.test(a.title)) return 'summative';
  if (/\(F\)/.test(a.title)) return 'formative';
  return 'unclassified';
}

function courseAssessments(db, student, courseId, { includeTeacherDrafts }) {
  const scales = Object.fromEntries(db.prepare('SELECT schoology_scale_id, title, levels_json FROM grading_scales').all()
    .map((s) => [String(s.schoology_scale_id), { title: s.title, levels: parseLevels(s.levels_json) }]));
  const rows = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.published, a.grading_scale_id,
           gc.title AS category_title,
           g.score, g.max_score, g.grade_comment, g.comment_status, g.exception, g.late,
           sl.line AS status_line
    FROM assignments a
    LEFT JOIN grading_categories gc ON gc.course_id = a.course_id AND gc.schoology_category_id = a.grading_category_id
    LEFT JOIN grades g ON g.assignment_id = a.id AND g.student_id = ?
    LEFT JOIN status_lines sl ON sl.assignment_id = a.id AND sl.student_id = ?
    WHERE a.course_id = ? AND a.removed_at IS NULL
  `).all(student.id, student.id, courseId);
  const topicRows = db.prepare(`
    SELECT ms.assignment_schoology_id, ms.grade, ms.points, mt.external_id, mt.title
    FROM mastery_scores ms JOIN measurement_topics mt ON mt.id = ms.topic_id
    WHERE ms.student_uid = ?
    ORDER BY mt.external_id
  `).all(String(student.schoology_uid));
  const topicsBy = {};
  for (const t of topicRows) (topicsBy[t.assignment_schoology_id] ||= []).push(t);
  const drafts = includeTeacherDrafts ? Object.fromEntries(db.prepare(`
    SELECT d.assignment_id, d.draft_json, d.updated_at FROM assessment_drafts d
    JOIN assignments a ON a.id = d.assignment_id WHERE d.student_id = ? AND a.course_id = ?
  `).all(student.id, courseId).map((d) => [d.assignment_id, d])) : {};

  const out = [];
  for (const a of rows) {
    const raw = a.grade_comment ?? '';
    // Verbatim unless Prism's own status line sits in it; then only that is removed.
    const stripped = a.status_line ? teacherText(raw, a.status_line) : null;
    const lineRemoved = stripped != null && stripped !== raw.trim();
    const comment = lineRemoved ? stripped : raw;
    const topics = (topicsBy[a.schoology_assignment_id] || []).map((t) => ({
      external_id: t.external_id, title: t.title, level: normalizeLevel(t.grade) ?? pointsToLevel(t.points),
    }));
    const draft = drafts[a.id];
    const assessed = a.score != null || comment.trim() !== '' || topics.length > 0 || (a.exception ?? 0) !== 0;
    if (!assessed && !draft) continue;

    const scale = scales[String(a.grading_scale_id)] ?? null;
    const labels = [];
    if (a.published === 0) labels.push('assignment is unpublished in Schoology');
    if (comment.trim() && a.comment_status === 0) labels.push('comment is hidden from the student');
    if ((a.exception ?? 0) !== 0) labels.push(`Schoology exception code ${a.exception} (excused / incomplete / missing)`);
    if (lineRemoved) labels.push('a Prism status line was removed from the comment; the rest is verbatim');

    const item = {
      assignment_id: a.id,
      title: a.title,
      due_date: a.due_date ? String(a.due_date).slice(0, 10) : null,
      kind: kindOf(a, scale),
      status: assessed ? 'final' : 'not_assessed',
      overall: assessed ? {
        level: overallLevel(scale, a.score, a.max_score),
        score: a.score ?? null,
        max_score: a.max_score ?? null,
        scale: scale?.title ?? null,
      } : null,
      topics,
      comment: comment || null,
      submitted_late: a.late == null ? null : a.late === 1,
      labels,
    };
    if (draft) {
      let parsed = {};
      try { parsed = JSON.parse(draft.draft_json || '{}'); } catch { /* keep {} */ }
      item.teacher_draft = {
        status: 'teacher_draft_unpublished',
        updated_at: draft.updated_at,
        comment: parsed.comment ?? null,
        topic_levels: Object.fromEntries(Object.entries(parsed.pending || {}).filter(([, v]) => v !== '__remove__')),
      };
    }
    out.push(item);
  }
  out.sort((x, y) => String(x.due_date ?? '9999').localeCompare(String(y.due_date ?? '9999')) || x.title.localeCompare(y.title));
  return out;
}

function courseProficiency(db, student, courseId) {
  return db.prepare(`
    SELECT mt.external_id, mt.title, r.grade_scaled_rounded, r.override_value
    FROM mastery_rollups r JOIN measurement_topics mt ON mt.id = r.objective_id
    WHERE r.student_uid = ? AND r.course_id = ? AND r.is_category = 0
    ORDER BY mt.external_id
  `).all(String(student.schoology_uid), courseId).map((r) => ({
    external_id: r.external_id,
    title: r.title,
    level: pointsToLevel(r.override_value ?? r.grade_scaled_rounded),
  }));
}

function courseTimeliness(db, student, courseId, assessments) {
  const summatives = assessments.filter((a) => a.kind === 'summative' && a.status === 'final');
  const count = (sql) => db.prepare(sql).get(student.id, courseId).n;
  return {
    summatives_assessed: summatives.length,
    summatives_submitted_late: summatives.filter((a) => a.submitted_late === true).length,
    resubmission_requests: count(`SELECT COUNT(*) AS n FROM resubmissions WHERE student_id = ? AND course_id = ? AND kind = 'request'`),
    referrals: count(`SELECT COUNT(*) AS n FROM referrals WHERE student_id = ? AND course_id = ? AND action = 'referred'`),
    note: 'summatives_submitted_late is Schoology\'s own flag against the original due date: it ignores Prism extensions, and a resubmission re-stamps the work as late, so it overstates lateness. Resubmission and referral counts only cover what Prism recorded (from 2026-10).',
  };
}

const matchesCourse = (c, ref) => {
  if (ref == null || ref === '') return true;
  const s = String(ref).toLowerCase();
  return String(c.course_id) === s || c.course_name.toLowerCase().includes(s);
};
const matchesYear = (c, y) => !y || (c.school_year ?? '') === String(y).trim() || (c.school_year ?? '').startsWith(String(y).trim());

/**
 * Every course the student has taken with the teacher (archived included) and,
 * per course, every assessed assignment: title, date, overall level, levels per
 * measurement topic, and the teacher's grade comment verbatim.
 */
export function getStudentHistory(db, {
  student, course, school_year, include_formative = false, include_completion = false,
  include_teacher_drafts = false, include_timeliness = false, detail = 'full', limit = 50, offset = 0,
} = {}) {
  const st = resolveStudent(db, student);
  const compact = detail === 'compact';
  const courses = enrolmentsFor(db, st.id).map(courseSummary)
    .filter((c) => matchesCourse(c, course) && matchesYear(c, school_year))
    .sort(byYear);

  const omitted = { formative: 0, completion: 0, unassessed_teacher_drafts: 0, omitted_with_comments: 0 };
  const flat = [];
  const perCourse = courses.map((c) => {
    const all = courseAssessments(db, st, c.course_id, { includeTeacherDrafts: include_teacher_drafts });
    const kept = all.filter((a) => {
      const drop = (a.kind === 'formative' && !include_formative) || (a.kind === 'completion' && !include_completion);
      if (drop) {
        omitted[a.kind] += 1;
        if (a.comment) omitted.omitted_with_comments += 1;
      }
      return !drop;
    });
    kept.forEach((a) => flat.push({ course_id: c.course_id, a }));
    return { c, all, kept };
  });

  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const page = new Set(flat.slice(off, off + lim).map((x) => x.a));

  // submitted_late is only meaningful next to the timeliness caveat, so it stays
  // out unless asked for.
  const shape = ({ submitted_late, ...a }) => (compact
    ? { title: a.title, due_date: a.due_date, kind: a.kind, level: a.overall?.level ?? null, comment: a.comment, ...(a.labels.length ? { labels: a.labels } : {}) }
    : { ...a, ...(include_timeliness ? { submitted_late } : {}) });

  return {
    student: identity(st),
    filters: { course: course ?? null, school_year: school_year ?? null, include_formative, include_completion, include_teacher_drafts, detail: compact ? 'compact' : 'full' },
    courses: perCourse.map(({ c, all, kept }) => ({
      ...c,
      assessments_total: kept.length,
      proficiency: courseProficiency(db, st, c.course_id),
      ...(include_timeliness ? { timeliness: courseTimeliness(db, st, c.course_id, all) } : {}),
      assessments: kept.filter((a) => page.has(a)).map(shape),
    })),
    omitted,
    page: { offset: off, limit: lim, returned: page.size, total: flat.length, next_offset: off + lim < flat.length ? off + lim : null },
    provenance: 'Published finals synced from the Schoology gradebook. Comments are verbatim. AI suggestions are never included.'
      + (include_teacher_drafts ? ' teacher_draft entries are the teacher\'s own unpublished work in progress.' : ''),
  };
}
