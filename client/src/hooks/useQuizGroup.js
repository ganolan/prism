// The quiz group an assessment belongs to (as a member test or as the linked
// result task), or null. Off when the `quizzes` feature flag is off.
import { useEffect, useState } from 'react';
import { getFeatures, getQuizGroupFor } from '../services/api.js';

export function useQuizGroup(assignmentId) {
  const [group, setGroup] = useState(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    setGroup(null);
    // Promise.resolve().then: a test's api mock without getFeatures must not crash the page.
    Promise.resolve().then(() => getFeatures())
      .then(f => {
        if (!active || !f?.quizzes) return;
        setEnabled(true);
        return getQuizGroupFor(assignmentId).then(r => { if (active) setGroup(r.group); });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [assignmentId]);
  return { group, setGroup, enabled };
}
