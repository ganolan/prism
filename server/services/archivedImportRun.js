// The queue's runner for one past course's import (#171): what syncQueue runs for
// { kind: 'import', sectionId }. Apart from pastImport.js (which enqueues these and listens for
// their end) so the queue imports this and not the module that imports the queue.
//
// A log line names the course and its counts, and the summary event is
// { type: 'summary', import: { sectionId, courseId, courseName, studentsCount, assignmentsCount,
// gradesCount }, elapsedMs }. An error is left for the queue to log: the run finishes failed with
// no summary, and the section is still missing from courses (pastImport.js retries it once).
import { getDb } from '../db/index.js';
import { importArchivedCourse } from './archivedImport.js';

export async function runPastImport(request, emit, { db = getDb(), deps = {} } = {}) {
  const d = { importArchivedCourse, ...deps };
  const started = Date.now();
  const sectionId = String(request.sectionId);
  const { course, studentsCount, assignmentsCount, gradesCount } = await d.importArchivedCourse(db, sectionId);
  const name = course?.course_name || `section ${sectionId}`;
  emit({ type: 'log', message: `Imported ${name}: ${studentsCount} students, ${assignmentsCount} assignments, ${gradesCount} grades` });
  emit({
    type: 'summary',
    import: { sectionId, courseId: course?.id ?? null, courseName: course?.course_name ?? null, studentsCount, assignmentsCount, gradesCount },
    elapsedMs: Date.now() - started,
  });
}
