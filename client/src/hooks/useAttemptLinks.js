// A student's attempts on linked or combined Schoology tests (linked quizzes).
// With an assignmentId the links are keyed by local student id; with a studentId
// they are keyed by Schoology assignment id (see getAttemptLinks).
//
// The links belong to the ids they were fetched for: the result is `{}` the
// moment the ids change (never the previous assignment's or student's links),
// a superseded response is dropped, and a failed or malformed call leaves `{}`.
// `reloadKey` refetches for the same ids without blanking the current links.
import { useState, useEffect } from 'react';
import { getAttemptLinks } from '../services/api.js';

const NONE = {};

export function useAttemptLinks({ assignmentId = null, studentId = null, reloadKey = 0 } = {}) {
  const key = `${assignmentId ?? ''}|${studentId ?? ''}`;
  const [loaded, setLoaded] = useState({ key: null, links: NONE });

  useEffect(() => {
    if (assignmentId == null && studentId == null) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => getAttemptLinks(studentId != null ? { studentId } : { assignmentId }))
      .then(r => ({ key, links: (r && r.links) || NONE }))
      .catch(() => ({ key, links: NONE }))
      .then(next => { if (active) setLoaded(next); });
    return () => { active = false; };
  }, [key, assignmentId, studentId, reloadKey]);

  return loaded.key === key ? loaded.links : NONE;
}
