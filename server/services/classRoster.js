// Class Tools' combined roster (#73): the students of the selected courses, once each, with the
// three facts its filters narrow on. Every tool (Class List, Email List, Random Picker, Group
// Generator) reads the same filtered roster, so a filter narrows them all.
//
// - gender: PowerSchool's, from the section student list (students.gender, one letter); null for a
//   student PowerSchool has not listed this year (a past course's former student).
// - grade: today's grade from students.grad_year (1 to 12); null when unknown or graduated.
// - level: overall proficiency, the level of the unweighted average of the student's
//   reporting-category rollups across the selected courses (the figure Balance groups by), banded by
//   the proficiency scale (server/lib/proficiencyScale.js); null with no rollup.
//
// Filters: values of one type combine with OR, types combine with AND; 'none' picks the students
// with no value of that type.

import { currentSchoolYearEndYear } from '../lib/psGradeLevel.js';
import { pointsToLevel, LEVELS } from '../lib/proficiencyScale.js';

export const FILTER_TYPES = ['gender', 'grade', 'level'];
const NONE = 'none';

export function gradeFromGradYear(gradYear, now = new Date()) {
  if (!Number.isInteger(gradYear)) return null;
  const grade = 12 - (gradYear - currentSchoolYearEndYear(now));
  return grade >= 1 && grade <= 12 ? grade : null;
}

// Every enrolled (not dropped) student of the courses, ordered by surname, with gender, grade,
// avg_pct and level.
export function loadClassRoster(db, courseIds, now = new Date()) {
  const ids = courseIds.map(String).filter(Boolean);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           s.email, s.parent_email, s.gender, s.grad_year,
           (SELECT ROUND(AVG(mr.grade_percentage), 1)
            FROM mastery_rollups mr
            WHERE mr.student_uid = s.schoology_uid
              AND mr.course_id IN (${ph})
              AND mr.is_category = 1
              AND mr.grade_percentage IS NOT NULL) AS avg_pct
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id IN (${ph}) AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(...ids, ...ids);
  return rows.map((s) => ({
    ...s,
    gender: s.gender || null,
    grade: gradeFromGradYear(s.grad_year, now),
    level: s.avg_pct == null ? null : pointsToLevel(s.avg_pct),
  }));
}

// Query (gender=F,M&grade=9,none&level=ED) → { gender: Set, grade: Set, level: Set } of the types
// given. Values are strings; 'none' stands for no value.
export function parseRosterFilters(query = {}) {
  const filters = {};
  for (const type of FILTER_TYPES) {
    const raw = query[type];
    if (raw == null || raw === '') continue;
    const values = String(raw).split(',').map((v) => v.trim()).filter(Boolean);
    if (values.length) filters[type] = new Set(values);
  }
  return filters;
}

const keyOf = (value) => (value == null ? NONE : String(value));

export function applyRosterFilters(students, filters) {
  const types = Object.keys(filters);
  if (!types.length) return students;
  return students.filter((s) => types.every((t) => filters[t].has(keyOf(s[t]))));
}

// The values each filter can take for this roster, with how many students hold each: gender and
// grade in sorted order, level best first, then 'none'. Only values some student holds.
export function rosterFacets(students) {
  const facets = {};
  for (const type of FILTER_TYPES) {
    const counts = new Map();
    for (const s of students) counts.set(keyOf(s[type]), (counts.get(keyOf(s[type])) ?? 0) + 1);
    const order = type === 'level'
      ? LEVELS
      : [...counts.keys()].filter((k) => k !== NONE).sort((a, b) => (type === 'grade' ? Number(a) - Number(b) : a.localeCompare(b)));
    facets[type] = [...order, NONE].filter((k) => counts.has(k)).map((value) => ({ value, count: counts.get(value) }));
  }
  return facets;
}
