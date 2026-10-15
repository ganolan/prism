// The quiz group an assessment belongs to (as a member test or as the linked
// result task), or null. Off when the `quizzes` feature flag is off.
import { useCallback, useEffect, useState } from 'react';
import { getFeatures, getQuizGroupFor } from '../services/api.js';

export function useQuizGroup(assignmentId) {
  // The group belongs to the assignment it was fetched for: after in-route
  // navigation the previous assignment's group must never be returned.
  const [stored, setStored] = useState({ assignmentId: null, group: null });
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    setStored({ assignmentId: String(assignmentId), group: null });
    // Promise.resolve().then: a test's api mock without getFeatures must not crash the page.
    Promise.resolve().then(() => getFeatures())
      .then(f => {
        if (!active || !f?.quizzes) return;
        setEnabled(true);
        return getQuizGroupFor(assignmentId).then(r => { if (active) setStored({ assignmentId: String(assignmentId), group: r.group }); });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [assignmentId]);
  const group = stored.assignmentId === String(assignmentId) ? stored.group : null;
  const setGroup = useCallback((g) => setStored({ assignmentId: String(assignmentId), group: g }), [assignmentId]);
  return { group, setGroup, enabled };
}
