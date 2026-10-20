// The queue's runner for one past course's import (#171): what syncQueue runs for
// { kind: 'import', sectionId }. Apart from pastImport.js (which enqueues these and listens for
// their end) so the queue imports this and not the module that imports the queue.
//
// A log line names the course and its counts (and a warning line follows when its mastery could not
// be read), and the summary event is { type: 'summary', import: { sectionId, courseId, courseName,
// studentsCount, assignmentsCount, gradesCount, masteryError }, elapsedMs }. An error is left for
// the queue to log: the run finishes failed with no summary, whether or not the course row was
// written (pastImport.js retries once any run that did not finish 'completed').
import { getDb } from '../db/index.js';
import { importArchivedCourse } from './archivedImport.js';

export async function runPastImport(request, emit, { db = getDb(), deps = {} } = {}) {
  const d = { importArchivedCourse, ...deps };
  const started = Date.now();
  const sectionId = String(request.sectionId);
  const { course, studentsCount, assignmentsCount, gradesCount, masteryError = null } = await d.importArchivedCourse(db, sectionId);
  const name = course?.course_name || `section ${sectionId}`;
  emit({ type: 'log', message: `Imported ${name}: ${studentsCount} students, ${assignmentsCount} assignments, ${gradesCount} grades` });
  // "could not" makes it a warning line in the run's log (syncRuns.js classifyEvent).
  if (masteryError) emit({ type: 'log', message: `Imported "${name}"; mastery could not be read: ${masteryError}` });
  emit({
    type: 'summary',
    import: { sectionId, courseId: course?.id ?? null, courseName: course?.course_name ?? null, studentsCount, assignmentsCount, gradesCount, masteryError },
    elapsedMs: Date.now() - started,
  });
}
