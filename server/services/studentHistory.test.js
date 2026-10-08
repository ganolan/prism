import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { findStudents, getStudentHistory, resolveStudent, emailCohortHint } from './studentHistory.js';

// Fixture: "Molly" (legal Mei Lin Wong, class of 2027) across three courses in three
// school years — MAD 2023-24 S1, MGD 2024-25 S2 (both archived), AIML 2025-26 —
// plus a current course they dropped, a template course, and two students who
// share a name so find_student must tell them apart.
let ids;
function seed(db) {
  const course = (sid, name, section, period, extra = {}) => db.prepare(`
    INSERT INTO courses (schoology_section_id, course_name, section_name, grading_period, block_number, archived, excluded)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sid, name, section, period, extra.block ?? null, extra.archived ?? 1, extra.excluded ?? 0).lastInsertRowid;
  const student = (uid, first, last, extra = {}) => db.prepare(`
    INSERT INTO students (schoology_uid, first_name, last_name, preferred_name, preferred_name_teacher, email, grad_year)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uid, first, last, extra.preferred ?? null, extra.teacherPreferred ?? null, extra.email ?? null, extra.grad ?? null).lastInsertRowid;
  const enrol = (s, c, dropped = null) => db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)').run(s, c, dropped);
  const assignment = (c, sid, title, due, scale, cat = null, extra = {}) => db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, grading_scale_id, grading_category_id, published, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c, sid, title, due, scale, cat, extra.published ?? 1, extra.removed ?? null).lastInsertRowid;
  const grade = (s, a, score, max, comment, extra = {}) => db.prepare(`
    INSERT INTO grades (student_id, assignment_id, score, max_score, grade_comment, comment_status, exception, late)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s, a, score, max, comment, extra.commentStatus ?? 1, extra.exception ?? 0, extra.late ?? 0);

  db.prepare(`INSERT INTO grading_scales (schoology_scale_id, title, levels_json) VALUES ('GAS', 'General Academic Scale', ?)`).run(JSON.stringify([
    { name: 'Insufficient Evidence', cutoff: 0 }, { name: 'Emerging', cutoff: 12.5 }, { name: 'Developing', cutoff: 37.5 },
    { name: 'Exhibiting', cutoff: 62.5 }, { name: 'Exhibiting Depth', cutoff: 87.5 },
  ]));
  db.prepare(`INSERT INTO grading_scales (schoology_scale_id, title, levels_json) VALUES ('MASTERY', 'Mastery', ?)`).run(JSON.stringify([
    { name: 'See Mastery Gradebook (IE)', cutoff: 0 }, { name: 'See Mastery Gradebook (D)', cutoff: 37.5 },
    { name: 'See Mastery Gradebook (EX)', cutoff: 62.5 }, { name: 'See Mastery Gradebook (ED)', cutoff: 87.5 },
  ]));
  db.prepare(`INSERT INTO grading_scales (schoology_scale_id, title, levels_json) VALUES ('COMP', 'Completion Scale', ?)`).run(JSON.stringify([
    { name: 'Incomplete', cutoff: 0 }, { name: 'Completed', cutoff: 80 },
  ]));

  const molly = student('uid-molly', 'Mei Lin', 'Wong', { teacherPreferred: 'Molly', email: '270555@hkis.edu.hk', grad: 2027 });
  const natalie = student('uid-nat', 'Natalie', 'Wong', { email: '280100@hkis.edu.hk' });
  const ming1 = student('uid-ming1', 'Ming', 'Lee', { email: '270001@hkis.edu.hk', grad: 2027 });
  const ming2 = student('uid-ming2', 'Ming', 'Lee', { email: '290002@hkis.edu.hk', grad: 2029 });

  const mad = course('sec-mad', 'MOBILE APP DEVELOPMENT', '5(A-B)', 'Semester 1: 08/15/23 - 01/07/24');
  const mgd = course('sec-mgd', 'MOBILE GAMES DEVELOPMENT', '3(A-B)', 'Semester 2: 01/06/25 - 06/15/25');
  const aiml = course('sec-aiml', 'AI & MACHINE LEARNING', '8(A-B)', '2025-2026: 08/14/2025 - 06/17/2026', { block: '8' });
  const rob = course('sec-rob', 'ROBOTICS', '5(A-B)', 'HS 26-27 S1', { archived: 0 });
  const master = course('sec-master', 'MASTER Art, Design & Technology', '1', 'Master Course (non expiring)', { archived: 0, excluded: 1 });
  [mad, mgd, aiml].forEach((c) => enrol(molly, c));
  enrol(molly, rob, '2026-09-01T00:00:00Z');
  enrol(molly, master);
  enrol(natalie, aiml);
  enrol(ming1, mad);
  enrol(ming2, rob);

  db.prepare(`INSERT INTO grading_categories (course_id, schoology_category_id, title) VALUES (?, 'sum', 'Evidence of Learning - Summative')`).run(aiml);
  db.prepare(`INSERT INTO grading_categories (course_id, schoology_category_id, title) VALUES (?, 'form', 'Evidence of Learning - Formative')`).run(aiml);

  // MAD 2023-24: points-based summatives, a typo kept verbatim, a resubmission "Update:".
  const madLogin = assignment(mad, 'a-mad-1', 'MAD Unit 1 Project - Login App (S)', '2023-09-11 15:30:00', 'GAS');
  grade(molly, madLogin, 11, 12, "you've also spend real time  polishing the front end.\u200b");
  const madPitch = assignment(mad, 'a-mad-2', 'MAD Unit 4 Project - Project Pitch - Design (S)', '2023-12-08 15:30:00', 'GAS');
  grade(molly, madPitch, 10, 16, 'Update:\nwhich may have lead to more novel ideas.');
  const madQuiz = assignment(mad, 'a-mad-q', 'MAD Quiz 1 - RESPOND: Intro to UIKit (F)', null, 'COMP');
  grade(molly, madQuiz, 100, 100, null);
  // Assigned but never assessed: not part of the history.
  assignment(mad, 'a-mad-empty', 'MAD Unit 5 Project (S)', '2024-01-05 15:30:00', 'GAS');

  // MGD 2024-25: completion-scale task with a comment, and a deleted assignment.
  const mgdDesign = assignment(mgd, 'a-mgd-1', 'MGD: Final Project - Design (S)', '2025-04-11 15:30:00', 'COMP');
  grade(molly, mgdDesign, 100, 100, 'I commend you for trying to bringing new life into a classic.');
  const mgdPitch = assignment(mgd, 'a-mgd-2', 'MGD: Final Project - Final Pitch (S)', '2025-06-05 15:30:00', 'GAS');
  grade(molly, mgdPitch, 100, 100, "I'm amazed at how fast this came together, Molly.");
  const gone = assignment(mgd, 'a-mgd-gone', 'Deleted task (S)', '2025-05-01 15:30:00', 'GAS', null, { removed: '2025-05-02' });
  grade(molly, gone, 50, 100, 'should never show');

  // AIML 2025-26: SBG summatives with topic levels, a formative, an unpublished
  // assignment, a hidden comment, a status line, an AI suggestion and a teacher draft.
  db.prepare(`INSERT INTO reporting_categories (id, title, external_id) VALUES ('rc', 'Produce', 'ART.5')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, category_id, external_id, title) VALUES ('t51', 'rc', 'ART.5.1', 'Select, Analyze, and Interpret')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, category_id, external_id, title) VALUES ('t66', 'rc', 'ART.6.6', 'Apply Criteria to Evaluate')`).run();
  const aimlP2 = assignment(aiml, 'a-aiml-1', 'AIML Project - Autonomous Driving - Part 2 (S)', '2025-12-02 15:00:00', 'MASTERY', 'sum');
  grade(molly, aimlP2, 83.33, 100, 'Asked to resubmit by 05/12.\n\nUpdate: Your determination has paid off.\n----------\nYour final video is missing.', { late: 1 });
  db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Asked to resubmit by 05/12.', 'ask')`).run(molly, aimlP2);
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-molly', 'a-aiml-1', 't51', 100, 'ED')`).run();
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-molly', 'a-aiml-1', 't66', 50, 'D')`).run();
  const aimlLlm = assignment(aiml, 'a-aiml-2', 'AIML: Project Choice 3 - LLM App (S)', '2026-06-09 15:30:00', 'MASTERY', 'sum');
  grade(molly, aimlLlm, 100, 100, 'Phenomenal work, Molly.', { commentStatus: 0 });
  db.prepare(`INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, 'draft', ?)`)
    .run(molly, aimlLlm, JSON.stringify({ narrative_feedback: 'AI SUGGESTION TEXT' }));
  const aimlForm = assignment(aiml, 'a-aiml-f', 'AIML - Lesson 1 - AI Image Generators', '2025-08-21 15:00:00', 'MASTERY', 'form');
  grade(molly, aimlForm, 100, 100, 'Some thoughtful reflections, keep it up!');
  const aimlHidden = assignment(aiml, 'a-aiml-u', 'AIML U1 Project - Ethical Issue (S)', '2025-10-01 15:00:00', 'MASTERY', 'sum', { published: 0 });
  grade(molly, aimlHidden, 75, 100, null);
  const aimlDraftOnly = assignment(aiml, 'a-aiml-d', 'AIML: Portfolio Reflection (S)', '2026-06-12 15:00:00', 'MASTERY', 'sum');
  db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json) VALUES (?, ?, ?)`)
    .run(aimlDraftOnly, molly, JSON.stringify({ comment: 'Teacher draft words', pending: { t51: 'EX', t66: '__remove__' } }));
  db.prepare(`INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_scaled_rounded) VALUES ('uid-molly', 't51', ?, 0, 87.5)`).run(aiml);
  db.prepare(`INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_scaled_rounded, override_value) VALUES ('uid-molly', 't66', ?, 0, 37.5, 62.5)`).run(aiml);
  db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at) VALUES (?, ?, ?, 'request', 'open', '2025-12-03 01:00:00')`).run(molly, aimlP2, aiml);

  ids = { molly, natalie, ming1, ming2, mad, mgd, aiml, rob, master, aimlLlm, aimlDraftOnly };
}

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM resubmissions; DELETE FROM status_lines; DELETE FROM assessment_drafts; DELETE FROM feedback; ' +
    'DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM grading_categories; DELETE FROM grading_scales; DELETE FROM grades; DELETE FROM enrolments; ' +
    'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
  seed(db);
});

const names = (r) => r.candidates.map((c) => c.display_name);

describe('emailCohortHint', () => {
  test('reads the two-digit class year from an HKIS student email, else null', () => {
    expect(emailCohortHint('270555@hkis.edu.hk')).toBe(2027);
    expect(emailCohortHint('halin+schoology@hkis.edu.hk')).toBeNull();
    expect(emailCohortHint(null)).toBeNull();
  });
});

describe('findStudents', () => {
  test('finds a student by teacher-preferred first name plus legal last name, with legal and preferred names kept apart', () => {
    const r = findStudents(getDb(), { query: 'Molly Wong' });
    expect(r.total).toBe(1);
    expect(r.candidates[0]).toMatchObject({
      id: ids.molly, legal_first_name: 'Mei Lin', legal_last_name: 'Wong', preferred_first_name: 'Molly',
      display_name: 'Molly Wong', preferred_differs_from_legal: true, grad_year: 2027, email_cohort_hint: 2027,
    });
    expect(r.candidates[0].matched_on).toEqual(expect.arrayContaining(['preferred_name_teacher', 'last_name']));
  });

  test('finds by legal name, email, email prefix and schoology_uid', () => {
    const db = getDb();
    expect(names(findStudents(db, { query: 'mei lin wong' }))).toEqual(['Molly Wong']);
    expect(names(findStudents(db, { query: '270555@hkis.edu.hk' }))).toEqual(['Molly Wong']);
    expect(names(findStudents(db, { query: '270555' }))).toEqual(['Molly Wong']);
    expect(findStudents(db, { query: 'uid-molly' }).candidates.map((c) => c.id)).toEqual([ids.molly]);
  });

  test('lists every course including archived ones, oldest first, with school year and term, and never a template course', () => {
    const [c] = findStudents(getDb(), { query: 'Molly' }).candidates;
    expect(c.courses.map((x) => [x.course_name, x.school_year, x.term, x.enrolment])).toEqual([
      ['MOBILE APP DEVELOPMENT', '2023-24', 'Semester 1', 'completed'],
      ['MOBILE GAMES DEVELOPMENT', '2024-25', 'Semester 2', 'completed'],
      ['AI & MACHINE LEARNING', '2025-26', 'Full year', 'completed'],
      ['ROBOTICS', '2026-27', 'Semester 1', 'dropped'],
    ]);
  });

  test('include_archived: false keeps only current courses', () => {
    const [c] = findStudents(getDb(), { query: 'Molly', include_archived: false }).candidates;
    expect(c.courses.map((x) => x.course_name)).toEqual(['ROBOTICS']);
    expect(names(findStudents(getDb(), { query: 'Natalie', include_archived: false }))).toEqual([]);
  });

  test('two students with the same name come back with enough to tell them apart', () => {
    const r = findStudents(getDb(), { query: 'Ming Lee' });
    expect(r.candidates.map((c) => [c.email, c.grad_year, c.courses.map((x) => x.school_year)])).toEqual([
      ['270001@hkis.edu.hk', 2027, ['2023-24']],
      ['290002@hkis.edu.hk', 2029, ['2026-27']],
    ]);
  });

  test('a last name alone returns everyone who has it', () => {
    expect(names(findStudents(getDb(), { query: 'wong' })).sort()).toEqual(['Molly Wong', 'Natalie Wong']);
  });
});

describe('resolveStudent', () => {
  test('a shared name is refused with the candidates listed', () => {
    expect(() => resolveStudent(getDb(), 'Ming Lee')).toThrow(/matches 2 students.*270001@hkis\.edu\.hk.*290002@hkis\.edu\.hk/);
  });
  test('an unknown name says so', () => {
    expect(() => resolveStudent(getDb(), 'Nobody Here')).toThrow(/No student matches/);
  });
});

describe('getStudentHistory', () => {
  const titles = (h) => h.courses.flatMap((c) => c.assessments.map((a) => a.title));

  test('returns every course, oldest first, with only assessed summative finals by default', () => {
    const h = getStudentHistory(getDb(), { student: 'Molly Wong' });
    expect(h.student).toMatchObject({ legal_first_name: 'Mei Lin', preferred_first_name: 'Molly' });
    expect(h.courses.map((c) => `${c.course_name} ${c.school_year}`)).toEqual([
      'MOBILE APP DEVELOPMENT 2023-24', 'MOBILE GAMES DEVELOPMENT 2024-25', 'AI & MACHINE LEARNING 2025-26', 'ROBOTICS 2026-27',
    ]);
    expect(titles(h)).toEqual([
      'MAD Unit 1 Project - Login App (S)',
      'MAD Unit 4 Project - Project Pitch - Design (S)',
      'MGD: Final Project - Final Pitch (S)',
      'AIML U1 Project - Ethical Issue (S)',
      'AIML Project - Autonomous Driving - Part 2 (S)',
      'AIML: Project Choice 3 - LLM App (S)',
    ]);
    // Formative + completion work is counted, not silently lost.
    expect(h.omitted).toMatchObject({ formative: 1, completion: 2, omitted_with_comments: 2 });
  });

  test('returns comments exactly as stored: typos, spacing and invisible characters untouched', () => {
    const h = getStudentHistory(getDb(), { student: ids.molly, course: 'mobile app' });
    const [login, pitch] = h.courses[0].assessments;
    expect(login.comment).toBe("you've also spend real time  polishing the front end.\u200b");
    expect(pitch.comment).toBe('Update:\nwhich may have lead to more novel ideas.');
  });

  test('levels: overall from the scale cutoffs (points or percent), per topic from mastery, course proficiency from the rollup', () => {
    const h = getStudentHistory(getDb(), { student: ids.molly });
    const all = h.courses.flatMap((c) => c.assessments);
    expect(all.find((a) => a.title.startsWith('MAD Unit 1')).overall).toMatchObject({ level: 'ED', score: 11, max_score: 12, scale: 'General Academic Scale' });
    expect(all.find((a) => a.title.startsWith('MAD Unit 4')).overall.level).toBe('EX'); // 10/16 = 62.5%
    const p2 = all.find((a) => a.title.includes('Part 2'));
    expect(p2.overall.level).toBe('EX'); // "See Mastery Gradebook (EX)"
    expect(p2.topics).toEqual([
      { external_id: 'ART.5.1', title: 'Select, Analyze, and Interpret', level: 'ED' },
      { external_id: 'ART.6.6', title: 'Apply Criteria to Evaluate', level: 'D' },
    ]);
    const aiml = h.courses.find((c) => c.course_id === ids.aiml);
    expect(aiml.proficiency.map((p) => [p.external_id, p.level])).toEqual([['ART.5.1', 'ED'], ['ART.6.6', 'EX']]); // override wins
  });

  test('never includes AI suggestions; teacher drafts only when asked, and labelled', () => {
    const plain = getStudentHistory(getDb(), { student: ids.molly });
    expect(JSON.stringify(plain)).not.toContain('AI SUGGESTION TEXT');
    expect(JSON.stringify(plain)).not.toContain('Teacher draft words');

    const withDrafts = getStudentHistory(getDb(), { student: ids.molly, include_teacher_drafts: true });
    expect(JSON.stringify(withDrafts)).not.toContain('AI SUGGESTION TEXT');
    const d = withDrafts.courses.flatMap((c) => c.assessments).find((a) => a.assignment_id === ids.aimlDraftOnly);
    expect(d).toMatchObject({ status: 'not_assessed', overall: null, comment: null });
    expect(d.teacher_draft).toMatchObject({ status: 'teacher_draft_unpublished', comment: 'Teacher draft words', topic_levels: { t51: 'EX' } });
  });

  test('labels anything that is not a plain published final', () => {
    const all = getStudentHistory(getDb(), { student: ids.molly, course: ids.aiml }).courses[0].assessments;
    expect(all.find((a) => a.title.includes('Ethical')).labels).toContain('assignment is unpublished in Schoology');
    expect(all.find((a) => a.title.includes('LLM App')).labels).toContain('comment is hidden from the student');
    const p2 = all.find((a) => a.title.includes('Part 2'));
    expect(p2.comment).toBe('Update: Your determination has paid off.\n----------\nYour final video is missing.');
    expect(p2.labels).toContain('a Prism status line was removed from the comment; the rest is verbatim');
  });

  test('include_formative / include_completion bring that work back, with its kind', () => {
    const h = getStudentHistory(getDb(), { student: ids.molly, include_formative: true, include_completion: true });
    const kinds = Object.fromEntries(h.courses.flatMap((c) => c.assessments).map((a) => [a.title, a.kind]));
    expect(kinds['AIML - Lesson 1 - AI Image Generators']).toBe('formative');
    expect(kinds['MGD: Final Project - Design (S)']).toBe('completion');
    expect(kinds['MAD Quiz 1 - RESPOND: Intro to UIKit (F)']).toBe('completion');
    expect(h.omitted).toMatchObject({ formative: 0, completion: 0 });
  });

  test('deleted assignments never appear', () => {
    const h = getStudentHistory(getDb(), { student: ids.molly, include_formative: true, include_completion: true });
    expect(JSON.stringify(h)).not.toContain('should never show');
  });

  test('filters by school year and course name', () => {
    const db = getDb();
    expect(getStudentHistory(db, { student: ids.molly, school_year: '2024-25' }).courses.map((c) => c.course_name)).toEqual(['MOBILE GAMES DEVELOPMENT']);
    expect(getStudentHistory(db, { student: ids.molly, course: 'machine' }).courses.map((c) => c.course_id)).toEqual([ids.aiml]);
  });

  test('compact mode keeps title, date, kind, level and comment only', () => {
    const h = getStudentHistory(getDb(), { student: ids.molly, detail: 'compact', course: 'mobile games' });
    expect(h.courses[0].assessments).toEqual([{
      title: 'MGD: Final Project - Final Pitch (S)', due_date: '2025-06-05', kind: 'summative', level: 'ED',
      comment: "I'm amazed at how fast this came together, Molly.",
    }]);
  });

  test('pages through assessments in date order', () => {
    const db = getDb();
    const p1 = getStudentHistory(db, { student: ids.molly, limit: 4 });
    expect(p1.page).toEqual({ offset: 0, limit: 4, returned: 4, total: 6, next_offset: 4 });
    const p2 = getStudentHistory(db, { student: ids.molly, limit: 4, offset: 4 });
    expect(p2.page.next_offset).toBeNull();
    expect([...titles(p1), ...titles(p2)]).toEqual(titles(getStudentHistory(db, { student: ids.molly })));
    // Every course is still listed on every page, with its full total.
    expect(p2.courses.map((c) => c.assessments_total)).toEqual([2, 1, 3, 0]);
  });

  test('timeliness is off by default and carries its caveat when asked for', () => {
    const db = getDb();
    const plain = getStudentHistory(db, { student: ids.molly });
    expect(plain.courses[0].timeliness).toBeUndefined();
    expect(plain.courses.flatMap((c) => c.assessments).some((a) => 'submitted_late' in a)).toBe(false);
    const t = getStudentHistory(db, { student: ids.molly, include_timeliness: true }).courses.find((c) => c.course_id === ids.aiml).timeliness;
    expect(t).toMatchObject({ summatives_submitted_late: 1, resubmission_requests: 1, referrals: 0 });
    expect(t.note).toMatch(/overstates lateness/);
  });
});
