// How long a caller waits for a queue run before answering with the run id (50 s). A leaf module
// with no imports, so the queue and the callers that wait on it (gradingSync, quizRun) all take it
// from here and none has to import another for it.
export const TOOL_WAIT_MS = 50_000;
