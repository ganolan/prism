const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // code / published / comment ride along (e.g. triage RECORD_FAILED_AFTER_PUBLISH:
    // the Schoology comment WAS changed even though the action failed).
    throw Object.assign(new Error(err.error || `Request failed: ${res.status}`), {
      status: res.status, code: err.code, published: err.published, comment: err.comment, differences: err.differences,
    });
  }
  return res.json();
}

// Courses (archived=true to include archived)
export const getCourses = (includeArchived, includeHidden) => {
  const params = [];
  if (includeArchived) params.push('archived=true');
  if (includeHidden) params.push('hidden=true');
  return request(`/courses${params.length ? '?' + params.join('&') : ''}`);
};
export const getCoursesByView = (view) => request(`/courses?view=${view}`);
export const importCourse = (sectionId) => request('/courses/import', {
  method: 'POST',
  body: JSON.stringify({ sectionId }),
});
export const toggleArchiveCourse = (id) => request(`/courses/${id}/archive`, { method: 'PUT' });
export const toggleCourseVisibility = (id) => request(`/courses/${id}/visibility`, { method: 'PUT' });
export const getCourse = (id) => request(`/courses/${id}`);
// includeDropped pulls students who have left the course too (#128), each
// tagged with `dropped_at`, so the roster can offer its show-dropped toggle.
export const getCourseStudents = (id, { includeDropped = false } = {}) =>
  request(`/courses/${id}/students${includeDropped ? '?includeDropped=true' : ''}`);
export const getCourseAssignments = (id) => request(`/courses/${id}/assignments`);
export const getGradebook = (id) => request(`/courses/${id}/gradebook`);
export const discoverArchivedCourses = () => request('/courses/archived/discover');

// Students
export const searchStudents = (q) => request(`/students${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const getStudent = (id) => request(`/students/${id}`);
// The PowerSchool Student Support Summary, read on demand (#163): { rows: [{ category, description, url? }], readAt }.
export const getSupportSummary = (id) => request(`/students/${id}/support-summary`);
export const updateStudent = (id, preferred_name_teacher) => request(`/students/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ preferred_name_teacher }),
});
// The teacher's additions to a parent (#173): { phone?, extra_email? }; only the keys
// sent are updated, '' or null clears one. A bad extra email is a 400 with the reason.
export const updateParent = (studentId, parentId, fields) => request(`/students/${studentId}/parents/${parentId}`, {
  method: 'PUT',
  body: JSON.stringify(fields),
});

// Grades
export const getGrades = (params) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/grades${qs ? `?${qs}` : ''}`);
};

// Sync
export const getSyncStatus = () => request('/sync/status');
export const getSyncMetrics = () => request('/sync/metrics');

// Sync runs (persisted history + event log; see server/routes/schoology.js).
// The default is twice the server's KEEP_RUNS (30 full runs and 30 task and quiz runs are kept).
export const getSyncRuns = (limit = 60) => request(`/sync/runs?limit=${limit}`);
export const getSyncRun = (id) => request(`/sync/runs/${id}`);
// A run's events after `afterSeq`: { status ('queued' | 'held' | 'running' | finished), finished, events: [{ seq, ... }] }.
export const getSyncRunEvents = (id, afterSeq = 0) => request(`/sync/runs/${id}/events?after=${afterSeq}`);
// The queue: { running: { runId, courseIds, kind } | null, runId, queued: [...], held: [...] }.
export const getCurrentSync = () => request('/sync/current');

// Background sync (20/10/2026): every sync is a run in the server's queue.
// startSync: a button's sync → { runId, state, joined } (follow it with getSyncRunEvents).
//   body: { courseIds?, masteryCourseIds?, skipSchoology?, includeHidden?, syncBlocks? }
export const startSync = (body = {}) => request('/sync', { method: 'POST', body: JSON.stringify(body) });
// ensureSync: a page asks for its scope after it loads → { state: 'fresh' | 'queued' | 'running', runId? }.
//   scope: { kind: 'all' } | { kind: 'courses', courseIds } | { kind: 'task', courseId, assignmentId }
export const ensureSync = (scope) => request('/sync/ensure', { method: 'POST', body: JSON.stringify({ scope }) });
// resumeSync: after a sign-in, the syncs held for it run → { resumed }.
export const resumeSync = () => request('/sync/resume', { method: 'POST', body: '{}' });

// People search (school-wide directory — users outside your sections)
export const searchPeople = (q, maxPages) =>
  request(`/people/search?q=${encodeURIComponent(q)}${maxPages ? `&maxPages=${maxPages}` : ''}`);
export const getPeopleSessionStatus = () => request('/people/session-status');

// Features
export const getFeatures = () => request('/features');
export const getVersion = () => request('/version');

// Notes
export const createNote = (data) => request('/notes', { method: 'POST', body: JSON.stringify(data) });
export const updateNote = (id, data) => request(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteNote = (id) => request(`/notes/${id}`, { method: 'DELETE' });

// Flags
export const createFlag = (data) => request('/flags', { method: 'POST', body: JSON.stringify(data) });
export const deleteFlag = (id) => request(`/flags/${id}`, { method: 'DELETE' });

// Class tools — courseIds may be a single id or an array of ids (sent comma-separated)
const courseList = (courseIds) => [].concat(courseIds).join(',');
export const getEmails = (courseIds, type) => request(`/tools/emails/${courseList(courseIds)}?type=${type || 'student'}`);
export const getRandomStudents = (courseIds, count) => request(`/tools/random/${courseList(courseIds)}?count=${count || 1}`);
export const getRoster = (courseIds) => request(`/tools/roster/${courseList(courseIds)}`);
export const getGroups = (courseIds, count, balanced) => request(`/tools/groups/${courseList(courseIds)}?count=${count || 4}&balanced=${balanced || false}`);

// Grading scales — global lookup map
export const getGradingScales = () => request('/grading-scales');

// Proficiency scale — config-derived 5-level mastery scale
export const getProficiencyScale = () => request('/proficiency-scale');

// Analytics
export const getCourseAnalytics = (id) => request(`/analytics/course/${id}`);

// Feedback (AI suggestions shown on /assessment)
export const getFeedbackForAssignment = (assignmentId) => request(`/feedback/for-assignment/${assignmentId}`);
// The teacher used / ignored a suggested-feedback narrative (or cleared that).
export const setSuggestionState = (id, state) => request(`/feedback/${id}/suggestion-state`, { method: 'PUT', body: JSON.stringify({ state }) });
export const getAssessmentAnalysis = (assignmentId) => request(`/feedback/analysis/${assignmentId}`);

// Assessment drafts (DB-backed unpublished grading work). DRAFTS_PATH is the
// absolute path used by navigator.sendBeacon on unload (request() prepends /api).
export const DRAFTS_PATH = '/api/assessment-drafts';
export const getDraftsForAssignment = (assignmentId) => request(`/assessment-drafts?assignment_id=${assignmentId}`);
export const saveAssessmentDraft = (data, opts = {}) =>
  request('/assessment-drafts', { method: 'POST', body: JSON.stringify(data), ...opts });
export const deleteAssessmentDraft = ({ assignmentId, studentId }) =>
  request(`/assessment-drafts?assignment_id=${assignmentId}&student_id=${studentId}`, { method: 'DELETE' });
export const draftBeaconBody = (data) => new Blob([JSON.stringify(data)], { type: 'application/json' });

// Remote sign-in to Schoology (#136): the server's own Microsoft sign-in, driven from
// this device. Each call answers the state { status, host, message }.
export const startRemoteLogin = () => request('/schoology-login/start', { method: 'POST' });
export const getRemoteLoginState = () => request('/schoology-login');
export const remoteLoginClick = (x, y) => request('/schoology-login/click', { method: 'POST', body: JSON.stringify({ x, y }) });
export const remoteLoginType = (text) => request('/schoology-login/type', { method: 'POST', body: JSON.stringify({ text }) });
export const remoteLoginKey = (key) => request('/schoology-login/key', { method: 'POST', body: JSON.stringify({ key }) });
export const stopRemoteLogin = () => request('/schoology-login/stop', { method: 'POST' });
// → { image: Blob } while the sign-in is open, else { state } (finished, stopped, timed out).
export async function getRemoteLoginScreen() {
  const res = await fetch(`${BASE}/schoology-login/screen`, { cache: 'no-store' });
  if (res.status === 409) return { state: await res.json() };
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed: ${res.status}`);
  return { image: await res.blob() };
}

// Mastery / SBG
// { loggedIn, live: 'connected' | 'expired' | 'none' | null, checkedAt, message? } — live is
// a cached server-side check of the saved session; refresh forces one; check: false never
// opens a browser on the server (live = the cached answer or null).
export const getMasteryLoginStatus = ({ refresh = false, check = true } = {}) => {
  const q = new URLSearchParams();
  if (refresh) q.set('refresh', '1');
  if (!check) q.set('check', '0');
  const qs = q.toString();
  return request(`/mastery/login-status${qs ? `?${qs}` : ''}`);
};
export const getMasteryForCourse = (courseId) => request(`/mastery/${courseId}`);
export const getMasteryForStudent = (courseId, studentUid) => request(`/mastery/${courseId}/student/${studentUid}`);
export const getMasteryForAssignment = (courseId, assignmentId) => request(`/mastery/${courseId}/assignment/${assignmentId}`);
// #52: after a page that shows mastery loads, read it from Schoology again unless it was read in
// the last 2 minutes (the server decides). → { refreshed, syncedAt, error?, signIn? }; reload the
// page's mastery when `refreshed`.
// Links to each student's own copy of an lti_submission assignment: OneDrive
// (#120) or Google Drive (#142), the provider named on each link. Slow-ish for
// OneDrive (a SharePoint sign-in, 2-4 s), so load it after the page, not with it.
export const getSubmissionLinks = (courseId, assignmentId, { refresh = false } = {}) =>
  request(`/mastery/${courseId}/assignment/${assignmentId}/submission-links${refresh ? '?refresh=1' : ''}`);
export const syncMasteryForAssignment =(courseId, assignmentId) => request(`/mastery/${courseId}/assignment/${assignmentId}/sync`, { method: 'POST' });
export const writeMasteryScores = (courseId, data) => request(`/mastery/${courseId}/write`, { method: 'POST', body: JSON.stringify(data) });
export const writeMasteryComment = (courseId, data) => request(`/mastery/${courseId}/write-comment`, { method: 'POST', body: JSON.stringify(data) });
export const writeMasteryOverride = (courseId, data) => request(`/mastery/${courseId}/override`, { method: 'POST', body: JSON.stringify(data) });
export const sendAllGrades = (courseId, entries) => request(`/mastery/${courseId}/send-all`, { method: 'POST', body: JSON.stringify({ entries }) });

// Import
export const uploadPowerSchoolCSV = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`${BASE}/import/powerschool`, { method: 'POST', body: formData })
    .then(res => res.json());
};

// ── Rubrics (descriptors) ──────────────────────────────────────────────
export const getRubricConfig = () => request('/rubrics/config');
export const listRubrics = () => request('/rubrics');
export const getRubricForAssignment = (assignmentId) => request(`/rubrics/assignment/${assignmentId}`);
// Every attached rubric for many assignments in one request → { attachments: { [aid]: attachment } }.
// With studentUid, feedback-row tasks carry that student's row levels (`rowLevels`).
export const getRubricsForAssignments = (assignmentIds, { studentUid = null } = {}) =>
  request(`/rubrics/assignments?ids=${assignmentIds.map(encodeURIComponent).join(',')}${studentUid ? `&student_uid=${encodeURIComponent(studentUid)}` : ''}`);
export const saveRowLevels = (assignmentId, studentUid, rowLevels) =>
  request(`/rubrics/row-levels/${assignmentId}/${studentUid}`, { method: 'PUT', body: JSON.stringify({ rowLevels }) });
export const attachRubric = (body) => request('/rubrics/attach', { method: 'POST', body: JSON.stringify(body) });
export const setRubricMapping = (attachmentId, criterionId, topicId) =>
  request(`/rubrics/attachment/${attachmentId}/mapping`, { method: 'PUT', body: JSON.stringify({ criterionId, topicId }) });
export const reorderRubricCriteria = (rubricId, orderedCriterionIds) =>
  request(`/rubrics/${rubricId}/reorder`, { method: 'PUT', body: JSON.stringify({ orderedCriterionIds }) });
export const rubricTemplateUrl = () => '/api/rubrics/template';
export const rubricExportUrl = (id) => `/api/rubrics/${id}/export`;
export const deleteRubric = (id) => request(`/rubrics/${id}`, { method: 'DELETE' });
export const renameRubric = (id, name) => request(`/rubrics/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });

// Multipart upload — must NOT set a JSON Content-Type (let the browser set the boundary).
export const uploadRubricCsv = (name, file) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('file', file);
  return fetch('/api/rubrics/upload', { method: 'POST', body: fd }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    return res.json();
  });
};

// Triage — late-work referral watch + feedback owed (counts in school days).
export const getTriage = ({ courseId, includeFormative } = {}) => {
  const p = new URLSearchParams();
  if (courseId != null) p.set('courseId', courseId);
  if (includeFormative != null) p.set('includeFormative', String(includeFormative));
  const qs = p.toString();
  return request(`/triage${qs ? `?${qs}` : ''}`);
};
export const getReferrals = ({ courseId } = {}) =>
  request(`/triage/referrals${courseId != null ? `?courseId=${courseId}` : ''}`);
export const recordReferral = (body) => request('/triage/referrals', { method: 'POST', body: JSON.stringify(body) });
export const undoReferral = (id) => request(`/triage/referrals/${id}`, { method: 'DELETE' });
// One student's card state after a triage action: { timeline, late_work }.
export const getTriagePair = (studentId, assignmentId) => request(`/triage/pair?${new URLSearchParams({ studentId, assignmentId })}`);
// Per-student deadline extensions: { studentId, assignmentId, lessons (school days), note? }.
export const getExtensions = ({ courseId } = {}) =>
  request(`/triage/extensions${courseId != null ? `?courseId=${courseId}` : ''}`);
export const recordExtension = (body) => request('/triage/extensions', { method: 'POST', body: JSON.stringify(body) });
// removeLine also removes the status line this extension published from the student's comment.
export const undoExtension = (id, { removeLine = false } = {}) =>
  request(`/triage/extensions/${id}${removeLine ? '?removeLine=1' : ''}`, { method: 'DELETE' });
// Publish (1) or unpublish (0) one assessment on Schoology (#138). Current courses only.
export const setAssessmentPublished = (courseId, assignmentId, published) =>
  request(`/courses/${courseId}/assessments/${assignmentId}/published`, { method: 'PUT', body: JSON.stringify({ published }) });
// Make-up tests: ignore (or track again) one Schoology test/quiz for every student.
export const setMakeUpIgnored = (assignmentId, ignored) =>
  request(`/triage/makeup-ignore/${assignmentId}`, { method: 'PUT', body: JSON.stringify({ ignored }) });

// Resubmissions (asks; extend / grade stands via update). Writes take an optional
// `commentLine` — the status line published to the student's Schoology comment first.
export const getResubmissions = ({ courseId } = {}) =>
  request(`/triage/resubmissions${courseId != null ? `?courseId=${courseId}` : ''}`);
export const requestResubmission = (body) => request('/triage/resubmissions', { method: 'POST', body: JSON.stringify(body) });
export const updateResubmission = (id, body) => request(`/triage/resubmissions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const undoResubmission = (id, { removeLine = false } = {}) =>
  request(`/triage/resubmissions/${id}${removeLine ? '?removeLine=1' : ''}`, { method: 'DELETE' });
// Status lines (spec Amendment B). The confirm modal's fresh read of the student's
// comment: { currentComment, visible, storedLine, resultingComment, hiddenWarning }.
export const previewStatusLine = ({ studentId, assignmentId, line = '' }) =>
  request(`/triage/status-line/preview?${new URLSearchParams({ studentId, assignmentId, line })}`);
// The due date a default line embeds (school calendar): { until, lessons }.
// kind: 'ask' | 'extend_resubmission' | 'grade_stands' | 'extension' | 'make_up'.
export const getStatusLineUntil = ({ kind, studentId, assignmentId, lessons, resubmissionId }) => {
  const q = Object.entries({ kind, studentId, assignmentId, lessons, resubmissionId })
    .filter(([, v]) => v != null && v !== '');
  return request(`/triage/status-line/until?${new URLSearchParams(q)}`);
};
// Lesson hints for a school-day deadline: school days after `from` + the class's lessons.
export const getLessonPlan = (courseId, from) => request(`/triage/lesson-plan?courseId=${courseId}${from ? `&from=${from}` : ''}`);

// Settings (server-side, shared by every device and PrisMCP).
export const getSettings = () => request('/settings');
export const updateSettings = (body) => request('/settings', { method: 'PUT', body: JSON.stringify(body) });

// Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
export const getQuizGroups = (courseId) => request(`/quizzes?course_id=${courseId}`);
export const getQuizCandidates = (courseId) => request(`/quizzes/candidates?course_id=${courseId}`);
export const getQuizGroupFor = (assignmentRef) => request(`/quizzes/for-assignment/${assignmentRef}`);
export const checkQuizParity = (assignmentIds) => request('/quizzes/check-parity', { method: 'POST', body: JSON.stringify({ assignment_ids: assignmentIds }) });
export const createQuizGroup = ({ courseId, assignmentIds, title }) =>
  request('/quizzes', { method: 'POST', body: JSON.stringify({ course_id: courseId, assignment_ids: assignmentIds, title }) });
export const linkQuizResult = (groupId, resultAssignmentId) =>
  request(`/quizzes/${groupId}/link`, { method: 'PUT', body: JSON.stringify({ result_assignment_id: resultAssignmentId }) });
export const deleteQuizGroup = (groupId) => request(`/quizzes/${groupId}`, { method: 'DELETE' });
export const loadQuizResults = (groupId) => request(`/quizzes/${groupId}/load`, { method: 'POST' });
export const getQuizStats = (groupId) => request(`/quizzes/${groupId}/stats`);
export const getTagResults = (courseId, tag) => request(`/quizzes/tag-results?course_id=${courseId}&tag=${encodeURIComponent(tag)}`);
export const setQuizTags = (groupId, tags, texts) => request(`/quizzes/${groupId}/tags`, { method: 'PUT', body: JSON.stringify({ tags, texts }) });
export const setQuizTemplate = (groupId, template) => request(`/quizzes/${groupId}/template`, { method: 'PUT', body: JSON.stringify({ template }) });
export const getQuizResults = (groupId) => request(`/quizzes/${groupId}/results`);
export const rebuildQuizOverall = (groupId, studentId) => request(`/quizzes/${groupId}/overall/${studentId}/rebuild`, { method: 'POST' });
export const postFrqWritebacks = (groupId, limit = null) => request(`/quizzes/${groupId}/writeback`, { method: 'POST', body: JSON.stringify({ limit }) });
export const getFrqResponses = (groupId) => request(`/quizzes/${groupId}/frq`);
export const saveFrqMark = (groupId, attemptId, position, body) =>
  request(`/quizzes/${groupId}/frq/${attemptId}/${position}`, { method: 'PUT', body: JSON.stringify(body) });
export const getAttemptLinks = ({ assignmentId, studentId }) =>
  request(`/quizzes/attempt-links?${studentId ? `student_id=${studentId}` : `assignment_id=${assignmentId}`}`);

// Submission comment threads (spec 2026-10-17-submission-comments-design.md).
// assignmentId is the Schoology (or local) assignment id; studentId the local id.
export const getSubmissionCommentThread = (assignmentId, studentId, { refresh = false } = {}) =>
  request(`/submission-comments/${assignmentId}/${studentId}${refresh ? '?refresh=1' : ''}`);
// The teacher saw the thread: clears its unread marker. → the thread.
export const markSubmissionCommentsSeen = (assignmentId, studentId) =>
  request(`/submission-comments/${assignmentId}/${studentId}/seen`, { method: 'POST' });
export const postSubmissionComment = (assignmentId, studentId, text) =>
  request(`/submission-comments/${assignmentId}/${studentId}`, { method: 'POST', body: JSON.stringify({ text }) });
// A comment with a file goes through Schoology's web form (the API drops files),
// so it takes a few seconds; the file travels as base64.
export async function postSubmissionCommentFile(assignmentId, studentId, text, file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return request(`/submission-comments/${assignmentId}/${studentId}/file`, {
    method: 'POST', body: JSON.stringify({ text, fileName: file.name, data }),
  });
}
export const deleteSubmissionComment = (assignmentId, studentId, commentId) =>
  request(`/submission-comments/${assignmentId}/${studentId}/${commentId}`, { method: 'DELETE' });
// Badges for one assignment, keyed by student id; also queues a background read
// of its submitted cells unless refresh is false.
export const getAssignmentCommentSummaries = (assignmentId, { refresh = true } = {}) =>
  request(`/submission-comments/assignment/${assignmentId}${refresh ? '' : '?refresh=0'}`);
// One student's badges (the student page): { assignments: { [schoology aid]: summary }, refresh };
// also queues a background read of their submitted threads unless refresh is false.
export const getStudentCommentSummaries = (studentId, { refresh = true } = {}) =>
  request(`/submission-comments/student/${studentId}${refresh ? '' : '?refresh=0'}`);
// One student's own OneDrive copies of a few lti assignments: { links: { [aid]: link | null }, status }.
export const getStudentWorkLinks = (studentId, assignmentIds) =>
  request(`/students/${studentId}/work-links?assignments=${assignmentIds.map(encodeURIComponent).join(',')}`);
// Cached badges for a course: { assignments: { [schoology aid]: { [student id]: summary } } }.
export const getCourseCommentSummaries = (courseId) => request(`/submission-comments/course/${courseId}`);

// Native dropbox submission files (#107): every revision with its files for one
// student, read from Schoology on demand (cached 5 minutes) unless refresh.
export const getSubmissionFiles = (assignmentId, studentId, { refresh = false } = {}) =>
  request(`/submission-files/${assignmentId}/${studentId}${refresh ? '?refresh=1' : ''}`);
// Cached chip counts for one assignment: { students: { [student id]: { revisions, files, read_at } } }.
export const getAssignmentFileSummaries = (assignmentId) => request(`/submission-files/assignment/${assignmentId}`);
// One student's chips (the student page, #162): { assignments: { [schoology aid]: { revisions, files, read_at } }, refresh };
// also queues a background read of their uploads in current courses unless refresh is false.
export const getStudentFileSummaries = (studentId, { refresh = true } = {}) =>
  request(`/submission-files/student/${studentId}${refresh ? '' : '?refresh=0'}`);
