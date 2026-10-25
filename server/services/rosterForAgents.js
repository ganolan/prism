// What the Roster tab (#160) shows, for PrisMCP (#195): read only, from Prism's database, with no
// Schoology or PowerSchool call. The comparisons reuse the roster's own pure modules in client/src/lib
// (masteryCompare, masteryLevels, categoryAbbr, testDay, genderTag), so an agent sees exactly what the
// roster draws; a release holds client/src, and none of these modules touches the DOM.
import { getMasteryForCourse } from './masterySync.js';
import { getRoster } from './assessmentContext.js';
import { psAlertFieldsForAgents } from './psAlertStore.js';
import { studentFullName } from './studentNames.js';
import { getScaleTable } from '../lib/proficiencyScale.js';
import { todayLocal } from '../lib/schoolDays.js';
import { categoryTracks, studentMastery } from '../../client/src/lib/masteryCompare.js';
import { makeScaleHelpers } from '../../client/src/lib/masteryLevels.js';
import { upcomingTests, extraMinutes, TEST_WINDOW_DAYS } from '../../client/src/lib/testDay.js';
import { genderTag } from '../../client/src/lib/genderTag.js';

// GET /api/mastery/:courseId's answer: the course's topics, categories and scores, every category
// rollup, and the published alignments with their topic and category names.
export function courseMasteryPayload(db, courseId) {
  const data = getMasteryForCourse(courseId);
  const rollups = db.prepare(`
    SELECT student_uid, objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value
    FROM mastery_rollups
    WHERE course_id = ?
  `).all(courseId);
  // Authoritative assignment↔topic alignments, with topic/category metadata so the gradebook can
  // render a mini rubric per cell (#32). Published assignments only, as every other mastery query.
  const alignments = db.prepare(`
    SELECT ma.assignment_schoology_id, ma.topic_id,
           mt.title              AS topic_title,
           mt.external_id        AS topic_external_id,
           mt.category_id        AS category_id,
           rc.title              AS category_title,
           rc.external_id        AS category_external_id
    FROM mastery_alignments ma
    JOIN measurement_topics  mt ON mt.id = ma.topic_id
    JOIN reporting_categories rc ON rc.id = mt.category_id
    JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
    WHERE ma.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
  `).all(courseId);
  return { ...data, rollups, alignments };
}

// The confirmed extra time (student_extra_time, the figure the teacher confirmed on Test day) for the
// given students → Map(studentId → percent). A student with no confirmed figure is absent.
export function confirmedExtraTime(db, studentIds) {
  const ids = [...new Set((studentIds || []).map(Number))];
  if (!ids.length) return new Map();
  return new Map(db.prepare(`SELECT student_id, percent FROM student_extra_time WHERE student_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map((r) => [r.student_id, r.percent]));
}

// A stored gender value as the roster shows it: { code: 'F' | 'M' | 'NB' | '?', value } where value is
// PowerSchool's own, verbatim (null when blank).
export function genderForAgents(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return { code: genderTag(raw).code, value };
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// The roster's Mastery mode as a check: for each current student, Prism's level per reporting
// category (the flat mean of every score in its topics) beside Schoology's (its rollup: the override
// when set), and the HKIS letter grade from each. Lists only the students where any category or the
// grade differs: Prism has a level and Schoology's is another one, or none.
export function categoryCheck(db, courseId) {
  const mastery = courseMasteryPayload(db, courseId);
  const tracks = categoryTracks(mastery);
  const scale = makeScaleHelpers(getScaleTable());
  const students = getRoster(db, courseId);
  const differences = [];
  for (const s of students) {
    const m = studentMastery(mastery, s.schoology_uid, scale);
    const categories = tracks.map((tr) => {
      const c = m.categories[tr.id];
      return {
        category: tr.abbr,
        name: tr.name,
        prism_level: c.prism.level,
        prism_percent: round1(c.prism.pct),
        schoology_level: c.schoology?.level ?? null,
        schoology_override: c.schoology?.isOverride ?? false,
        differs: c.differs,
      };
    });
    if (!m.grade.differs && !categories.some((c) => c.differs)) continue;
    differences.push({
      student_id: s.id,
      name: studentFullName(s),
      categories,
      prism_grade: m.grade.prism,
      schoology_grade: m.grade.schoology,
      grade_differs: m.grade.differs,
    });
  }
  return {
    course_id: Number(courseId),
    categories: tracks.map((tr) => ({ category: tr.abbr, name: tr.name })),
    students_checked: students.length,
    differences,
  };
}

const LEARNING = 'learning';

// The roster's Test day: the course's Schoology tests due from today to 14 days ahead (nearest first),
// the chosen one (`test`: a Schoology assignment id or part of a title; default the nearest), and each
// current student with a learning plan (PowerSchool alerts, never health ones) with the extra time the
// teacher confirmed and the minutes it gives a test of `lengthMinutes`. A student with no confirmed
// figure has nulls: Prism does not read plan text here.
export function testDayForCourse(db, courseId, { test = null, lengthMinutes = 50, today = todayLocal() } = {}) {
  const assignments = db.prepare(`
    SELECT schoology_assignment_id, title, due_date, is_test, published, removed_at
    FROM assignments WHERE course_id = ?
  `).all(courseId);
  const tests = upcomingTests(assignments, today);
  let chosen = tests[0] ?? null;
  if (test != null && String(test).trim() !== '') {
    const q = String(test).trim().toLowerCase();
    const hits = tests.filter((t) => String(t.schoologyAssignmentId) === q || t.title.toLowerCase().includes(q));
    if (hits.length !== 1) {
      const list = tests.map((t) => `${t.schoologyAssignmentId} ${t.title}`).join('; ') || 'none';
      throw new Error(`${hits.length ? `"${test}" matches several` : `No test in the next ${TEST_WINDOW_DAYS} days matches "${test}"`}: tests are ${list}`);
    }
    chosen = hits[0];
  }
  const roster = getRoster(db, courseId);
  const alerts = psAlertFieldsForAgents(db, roster.map((s) => s.id));
  const extra = confirmedExtraTime(db, roster.map((s) => s.id));
  const students = roster.map((s) => {
    const plans = (alerts.get(s.id)?.powerschool_alerts || []).filter((a) => a.category === LEARNING);
    if (!plans.length) return null;
    const percent = extra.get(s.id) ?? null;
    const more = percent == null ? null : extraMinutes(lengthMinutes, percent);
    return {
      student_id: s.id,
      name: studentFullName(s),
      plans: plans.map((a) => a.label),
      extra_time_percent: percent,
      extra_minutes: more,
      total_minutes: more == null ? null : lengthMinutes + more,
    };
  }).filter(Boolean);
  const shape = (t) => ({ schoology_assignment_id: t.schoologyAssignmentId, title: t.title, due_date: t.dueDate });
  return {
    course_id: Number(courseId),
    tests: tests.map(shape),
    test: chosen ? shape(chosen) : null,
    length_minutes: lengthMinutes,
    students,
  };
}

