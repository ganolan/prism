// One-off probe (#49 Part B). Usage: node scripts/probe-revision-timestamps.js <sectionId>
// Prints, for each graded dropbox assignment+student in the section: the stored
// grades.submitted_at, and the live Schoology revision[] created timestamps.
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { apiGet } from '../server/services/schoology.js';

const sectionId = process.argv[2];
if (!sectionId) { console.error('Usage: node scripts/probe-revision-timestamps.js <sectionId>'); process.exit(1); }

const db = getDb();
const course = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
if (!course) { console.error('No course for section', sectionId); process.exit(1); }

const rows = db.prepare(`
  SELECT s.schoology_uid, a.schoology_assignment_id, g.submitted_at, g.score
  FROM grades g
  JOIN students s ON s.id = g.student_id
  JOIN assignments a ON a.id = g.assignment_id
  WHERE a.course_id = ? AND g.score IS NOT NULL
  LIMIT 10
`).all(course.id);

for (const r of rows) {
  try {
    const data = await apiGet(`/sections/${sectionId}/submissions/${r.schoology_assignment_id}/${r.schoology_uid}`);
    const revs = (data?.revision || []).map(x => ({ id: x.revision_id, created: x.created, draft: x.draft }));
    console.log(JSON.stringify({ uid: r.schoology_uid, aid: r.schoology_assignment_id, submitted_at: r.submitted_at, revisions: revs }));
  } catch (e) {
    console.log(JSON.stringify({ uid: r.schoology_uid, aid: r.schoology_assignment_id, error: e.message }));
  }
}
