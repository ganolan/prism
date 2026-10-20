// The queue's runner for a quiz load (#131): what syncQueue runs for { kind: 'quiz' }. Apart from
// quizRun.js (which enqueues and waits) so the queue imports this and not the module that imports
// the queue.
//
// The run's summary event is { type: 'summary', quiz: <loadGroup summary> }, or for a QuizError
// { type: 'summary', fatal: true, quizError: { code, message } } (BUSY keeps its meaning). Any
// other error is left for the queue to log: the run finishes failed with no summary.
import { getDb } from '../db/index.js';
import { QuizError } from './quizError.js';
import { loadGroup } from './quizLoader.js';

export async function runQuizLoad(request, emit, { db = getDb(), deps = {} } = {}) {
  const d = { loadGroup, ...deps };
  try {
    emit({ type: 'summary', quiz: await d.loadGroup(db, { groupId: request.groupId }) });
  } catch (err) {
    if (!(err instanceof QuizError)) throw err;
    emit({ type: 'summary', fatal: true, quizError: { code: err.code, message: err.message } });
  }
}
