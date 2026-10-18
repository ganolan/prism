// Publish or unpublish an assessment on Schoology (#138). PUT
// /v1/sections/{id}/assignments/{aid} with {published} is a partial update:
// 204 with no body, and the next GET reads the new value (probed both ways on
// 18/10/2026, schoology-api-reference.md "Writing assignments").
// Safety pattern (quizWriteback.js): re-read, write only when Schoology differs,
// read back, and store what Schoology shows. Live courses only: students see
// the change at once.
import { apiGet as realGet, apiPut as realPut } from './schoology.js';

export class PublishError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const asFlag = (v) => (Number(v) ? 1 : 0);

export async function setPublished(db, { courseId, assignmentId, published }, { apiGet = realGet, apiPut = realPut } = {}) {
  if (published !== 0 && published !== 1) throw new PublishError('BAD_VALUE', 'published must be 0 or 1');
  const row = db.prepare(`
    SELECT a.id, a.schoology_assignment_id AS aid, c.schoology_section_id AS sid, c.archived
    FROM assignments a JOIN courses c ON c.id = a.course_id
    WHERE a.id = ? AND a.course_id = ? AND a.removed_at IS NULL
  `).get(assignmentId, courseId);
  if (!row) throw new PublishError('NOT_FOUND', 'Assessment not found in this course');
  if (row.archived) throw new PublishError('NOT_LIVE', 'Publishing is for current courses only');

  const path = `/sections/${row.sid}/assignments/${row.aid}`;
  const store = (value) => db.prepare('UPDATE assignments SET published = ? WHERE id = ?').run(value, row.id);

  const before = asFlag((await apiGet(path)).published);
  if (before === published) {
    store(before);
    return { assignmentId: row.id, published, changed: false };
  }
  const put = await apiPut(path, { published });
  if (put.status !== 204 && put.status !== 200) {
    throw new PublishError('WRITE_FAILED', `Schoology refused the change (HTTP ${put.status})`);
  }
  const after = asFlag((await apiGet(path)).published);
  store(after);
  if (after !== published) {
    throw new PublishError('READBACK_MISMATCH', `Schoology still shows it as ${after ? 'published' : 'unpublished'}`);
  }
  return { assignmentId: row.id, published: after, changed: true };
}
