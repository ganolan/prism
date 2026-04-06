const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
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
export const toggleArchiveCourse = (id) => request(`/courses/${id}/archive`, { method: 'PUT' });
export const toggleCourseVisibility = (id) => request(`/courses/${id}/visibility`, { method: 'PUT' });
export const getCourse = (id) => request(`/courses/${id}`);
export const getCourseStudents = (id) => request(`/courses/${id}/students`);
export const getCourseAssignments = (id) => request(`/courses/${id}/assignments`);
export const getGradebook = (id) => request(`/courses/${id}/gradebook`);

// Students
export const searchStudents = (q) => request(`/students${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const getStudent = (id) => request(`/students/${id}`);
export const updateStudent = (id, preferred_name_teacher) => request(`/students/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ preferred_name_teacher }),
});
export const updateParentPhone = (studentId, parentId, phone) => request(`/students/${studentId}/parents/${parentId}`, {
  method: 'PUT',
  body: JSON.stringify({ phone }),
});

// Grades
export const getGrades = (params) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/grades${qs ? `?${qs}` : ''}`);
};

// Sync
export const triggerSync = () => request('/sync', { method: 'POST' });
export const getSyncStatus = () => request('/sync/status');

// Features
export const getFeatures = () => request('/features');

// Notes
export const createNote = (data) => request('/notes', { method: 'POST', body: JSON.stringify(data) });
export const updateNote = (id, data) => request(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteNote = (id) => request(`/notes/${id}`, { method: 'DELETE' });

// Flags
export const createFlag = (data) => request('/flags', { method: 'POST', body: JSON.stringify(data) });
export const resolveFlag = (id) => request(`/flags/${id}/resolve`, { method: 'PUT' });
export const reopenFlag = (id) => request(`/flags/${id}/reopen`, { method: 'PUT' });
export const deleteFlag = (id) => request(`/flags/${id}`, { method: 'DELETE' });

// Class tools
export const getEmails = (courseId, type) => request(`/tools/emails/${courseId}?type=${type || 'student'}`);
export const getRandomStudents = (courseId, count) => request(`/tools/random/${courseId}?count=${count || 1}`);
export const getGroups = (courseId, count, balanced) => request(`/tools/groups/${courseId}?count=${count || 4}&balanced=${balanced || false}`);

// Analytics
export const getCourseAnalytics = (id) => request(`/analytics/course/${id}`);
export const getStudentAnalytics = (id, threshold) => request(`/analytics/student/${id}?threshold=${threshold || 15}`);
export const updateAssignmentType = (id, type) => request(`/analytics/assignments/${id}/type`, { method: 'PUT', body: JSON.stringify({ assignment_type: type }) });
export const runAutoFlags = (courseId, opts) => request(`/analytics/auto-flags/${courseId}`, { method: 'POST', body: JSON.stringify(opts || {}) });

// Feedback
export const getFeedback = (params) => { const qs = new URLSearchParams(params).toString(); return request(`/feedback${qs ? `?${qs}` : ''}`); };
export const getFeedbackItem = (id) => request(`/feedback/${id}`);
export const updateFeedback = (id, data) => request(`/feedback/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const approveFeedback = (id) => request(`/feedback/${id}/approve`, { method: 'PUT' });
export const requestRevision = (id, notes) => request(`/feedback/${id}/request-revision`, { method: 'PUT', body: JSON.stringify({ teacher_notes: notes }) });
export const batchApproveFeedback = (ids) => request('/feedback/batch-approve', { method: 'POST', body: JSON.stringify({ ids }) });
export const processInbox = () => request('/feedback/process-inbox', { method: 'POST' });
export const deleteFeedback = (id) => request(`/feedback/${id}`, { method: 'DELETE' });
export const createManualFeedback = (data) => request('/feedback/manual', { method: 'POST', body: JSON.stringify(data) });
export const uploadFeedbackJson = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`${BASE}/feedback/upload`, { method: 'POST', body: formData }).then(r => r.json());
};

// Import
export const uploadPowerSchoolCSV = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`${BASE}/import/powerschool`, { method: 'POST', body: formData })
    .then(res => res.json());
};
