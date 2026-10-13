// Per-student quiz results for a linked quiz group (spec §13), keyed by local student id.
// Keyed to the group it was fetched for; a failed call leaves {}.
import { useEffect, useState } from 'react';
import { getQuizResults } from '../services/api.js';

const NONE = {};

export function useQuizResults({ groupId = null, enabled = false, reloadKey = '' } = {}) {
  const [loaded, setLoaded] = useState({ groupId: null, byStudent: NONE });
  useEffect(() => {
    if (!enabled || groupId == null) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => getQuizResults(groupId))
      .then(r => Object.fromEntries((r?.students || []).map(s => [s.student_id, s])))
      .catch(() => NONE)
      .then(byStudent => { if (active) setLoaded({ groupId, byStudent }); });
    return () => { active = false; };
  }, [groupId, enabled, reloadKey]);
  return loaded.groupId === groupId && enabled ? loaded.byStudent : NONE;
}
