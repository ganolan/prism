// GET /api/students/:id/grade-cards (#176): the assessment page's grade card for one student,
// one per task of a course, for the student page and the gradebook pop-up.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './students.js';
import { getDb } from '../db/index.js';
import { saveRubric } from '../services/rubricStore.js';
import { attachRubric } from '../services/rubricAttach.js';
import { draftBaseline } from '../../client/src/lib/assessmentDraft.js';

async function get(path) {
  const app = express();
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let db, courseId, ada, bob, cy, localId;
beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM assessment_drafts; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
    'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'ROB')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
  const student = (uid, first) => {
    const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'Student')`).run(uid, first).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
    return id;
  };
  ada = student('uid-1', 'Ada');
  bob = student('uid-2', 'Bob');
  cy = student('uid-3', 'Cy');
  const task = (sid, title) => db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, ?, ?, 1)`)
    .run(courseId, sid, title).lastInsertRowid;
  localId = task('sa-1', 'Project');
  task('sa-2', 'Quiz');
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-unpub', 'Draft task', 0)`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-other', 'Elsewhere', 1)`).run(other);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-1', 'sa-1', 'topic-1', 75, 'EX')`).run();
  for (const [s, c] of [[ada, 'Ada comment'], [bob, 'Bob comment'], [cy, 'Cy comment']]) {
    db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment, comment_status) VALUES (?, ?, ?, 1)`).run(s, localId, c);
  }
});

describe('GET /api/students/:id/grade-cards', () => {
  test('returns a card per task in the course', async () => {
    const { status, body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}`);
    expect(status).toBe(200);
    expect(body.course).toEqual({ id: courseId, archived: 0, excluded: 0, writable: true });
    expect(Object.keys(body.cards).sort()).toEqual(['sa-1', 'sa-2']);
    const card = body.cards['sa-1'];
    expect(card.assignment).toMatchObject({ schoology_assignment_id: 'sa-1', title: 'Project' });
    expect(card.topics.map((t) => t.id)).toEqual(['topic-1']);
    expect(card.scoreScale).toBeNull();
    expect(card.student).toMatchObject({ id: ada, grade_comment: 'Ada comment', scores: { 'topic-1': { grade: 'EX', points: 75 } } });
    expect(card.rubric).toBeNull();
    expect(card.draft).toBeNull();
    expect(card.hasDraft).toBe(false);
    // A task with no grade row still gets a card (an untouched task).
    expect(body.cards['sa-2'].student).toMatchObject({ id: ada, has_grade_row: false });
  });

  test('assignmentId narrows to one card', async () => {
    const { body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-2`);
    expect(Object.keys(body.cards)).toEqual(['sa-2']);
  });

  test('ships the attached rubric', async () => {
    const rubricId = saveRubric(db, {
      name: 'R', criteria: [{ criterion_name: 'Media', descriptors: { EX: 'Great' } }],
    });
    attachRubric(db, { rubricId, courseId, assignmentId: 'sa-1' });
    const { body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`);
    expect(body.cards['sa-1'].rubric).toMatchObject({ id: expect.any(Number), rubric: { name: 'R' }, topicByCriterion: expect.any(Array) });
    expect(body.cards['sa-1'].rubric.rubric.criteria[0].criterion_name).toBe('Media');
  });

  describe('drafts', () => {
    const saveDraft = (base) => db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json) VALUES (?, ?, ?)`)
      .run(localId, ada, JSON.stringify({ pending: { 'topic-1': 'D' }, comment: 'draft', base }));

    test('hasDraft is true only for a current draft', async () => {
      const first = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`);
      const { student, topics } = first.body.cards['sa-1'];
      saveDraft('not the card baseline');
      let { body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`);
      expect(body.cards['sa-1'].hasDraft).toBe(false);
      expect(body.cards['sa-1'].draft).toMatchObject({ comment: 'draft', base: 'not the card baseline' });

      db.prepare('DELETE FROM assessment_drafts').run();
      saveDraft(draftBaseline(student, topics));
      ({ body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`));
      expect(body.cards['sa-1'].hasDraft).toBe(true);
      expect(body.cards['sa-1'].draft.comment).toBe('draft');
    });

    test('another student\'s draft is not this student\'s', async () => {
      const { student, topics } = (await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`)).body.cards['sa-1'];
      db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json) VALUES (?, ?, ?)`)
        .run(localId, bob, JSON.stringify({ pending: {}, comment: 'bob draft', base: draftBaseline(student, topics) }));
      const { body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}&assignmentId=sa-1`);
      expect(body.cards['sa-1'].draft).toBeNull();
      expect(body.cards['sa-1'].hasDraft).toBe(false);
    });
  });

  test('cards never hold another student', async () => {
    const { body } = await get(`/api/students/${bob}/grade-cards?courseId=${courseId}`);
    for (const card of Object.values(body.cards)) expect(card.student.id).toBe(bob);
    expect(JSON.stringify(body)).not.toMatch(/Ada comment|Cy comment|uid-1|uid-3/);
  });

  test('an individually assigned task the student is not assigned to has no card', async () => {
    db.prepare('UPDATE assignments SET num_assignees = 1 WHERE schoology_assignment_id = ?').run('sa-2');
    db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES ((SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-2'), 'uid-2')`).run();
    expect(Object.keys((await get(`/api/students/${ada}/grade-cards?courseId=${courseId}`)).body.cards)).toEqual(['sa-1']);
    expect(Object.keys((await get(`/api/students/${bob}/grade-cards?courseId=${courseId}`)).body.cards)).toEqual(['sa-1', 'sa-2']);
  });

  test('course.writable is false for an archived course', async () => {
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    const { body } = await get(`/api/students/${ada}/grade-cards?courseId=${courseId}`);
    expect(body.course).toEqual({ id: courseId, archived: 1, excluded: 0, writable: false });
    expect(Object.keys(body.cards).sort()).toEqual(['sa-1', 'sa-2']);
  });

  test('a course the student is not in has no cards', async () => {
    const other = db.prepare(`SELECT id FROM courses WHERE schoology_section_id = 'sec-2'`).get().id;
    const { status, body } = await get(`/api/students/${ada}/grade-cards?courseId=${other}`);
    expect(status).toBe(200);
    expect(body.cards).toEqual({});
  });

  test('404 for an unknown student or course, 400 without courseId', async () => {
    expect((await get(`/api/students/999999/grade-cards?courseId=${courseId}`)).status).toBe(404);
    expect((await get(`/api/students/${ada}/grade-cards?courseId=999999`)).status).toBe(404);
    expect((await get(`/api/students/${ada}/grade-cards`)).status).toBe(400);
  });
});
