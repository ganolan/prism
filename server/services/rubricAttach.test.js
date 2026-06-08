import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric } from './rubricStore.js';
import { attachRubric, getAttachmentForAssignment, setMapping, reorderCriteria } from './rubricAttach.js';

let db, rubricId;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (4, '99', 'AIML')`).run();
  // reporting_categories is required: measurement_topics.category_id FK + JOIN in getAlignedTopics
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('rc1', 4, 'ART.5', 'Presenting')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'rc1', 4, 'ART.5.1', 'Select, analyze, and interpret artistic work for presentation')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t2', 'rc1', 4, 'ART.5.2', 'Develop and refine artistic techniques and work for presentation')`).run();
  // mastery_alignments has a course_id column — include it so getAlignedTopics WHERE clause matches
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('800', 't1', 4)`).run();
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('800', 't2', 4)`).run();
  rubricId = saveRubric(db, {
    name: 'R', source: 'csv',
    criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Select, analyze, and interpret artistic work for presentation', descriptors: { ED:'a',EX:'b',D:'c',EM:'d' } },
      { position: 2, criterion_name: 'Func', standard_title: 'Develop and refine artistic techniques and work for presentation', descriptors: { ED:'e',EX:'f',D:'g',EM:'h' } },
    ],
  });
});

describe('rubricAttach', () => {
  test('attachRubric auto-maps criteria to aligned topics', () => {
    const res = attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    expect(res.unmatched).toEqual([]);
    const att = getAttachmentForAssignment(db, '800');
    expect(att.rubric.name).toBe('R');
    const map = Object.fromEntries(att.topicByCriterion.map(m => [m.criterion_name, m.topic_id]));
    expect(map).toEqual({ 'UI/UX': 't1', Func: 't2' });
    expect(att.rubric.criteria.map(c => c.criterion_name)).toEqual(['UI/UX', 'Func']);
  });

  test('re-attaching a different rubric replaces the attachment (one per assignment)', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const other = saveRubric(db, { name: 'Other', source: 'csv', criteria: [] });
    attachRubric(db, { rubricId: other, courseId: 4, assignmentId: '800' });
    expect(getAttachmentForAssignment(db, '800').rubric.name).toBe('Other');
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_attachments`).get().c).toBe(1);
  });

  test('setMapping upserts one criterion→topic; reorderCriteria rewrites positions', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1, c2] = att.rubric.criteria;
    setMapping(db, att.id, c1.id, 't2');
    const after = getAttachmentForAssignment(db, '800');
    expect(after.topicByCriterion.find(m => m.criterion_id === c1.id).topic_id).toBe('t2');
    reorderCriteria(db, rubricId, [c2.id, c1.id]);
    expect(getAttachmentForAssignment(db, '800').rubric.criteria.map(c => c.id)).toEqual([c2.id, c1.id]);
  });

  test('setMapping moves a topic off the criterion that previously held it (1:1)', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1, c2] = att.rubric.criteria;            // c1→t1, c2→t2 from auto-match
    setMapping(db, att.id, c2.id, 't1');             // give t1 (held by c1) to c2
    const map = getAttachmentForAssignment(db, '800').topicByCriterion;
    expect(map.find(m => m.criterion_id === c2.id).topic_id).toBe('t1');
    expect(map.find(m => m.criterion_id === c1.id)).toBeUndefined(); // c1 freed
  });

  test('setMapping with a null topic unmaps the criterion', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1] = att.rubric.criteria;
    setMapping(db, att.id, c1.id, null);
    expect(getAttachmentForAssignment(db, '800').topicByCriterion
      .find(m => m.criterion_id === c1.id)).toBeUndefined();
  });

  test('setMapping with an empty-string topic also unmaps the criterion', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [, c2] = att.rubric.criteria;
    setMapping(db, att.id, c2.id, '');
    expect(getAttachmentForAssignment(db, '800').topicByCriterion
      .find(m => m.criterion_id === c2.id)).toBeUndefined();
  });
});
