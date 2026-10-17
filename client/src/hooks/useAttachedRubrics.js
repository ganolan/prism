// The rubrics attached to a set of assignments (Schoology assignment ids), for the
// read-only feedback view (#135): one batch request, then the reporting-category
// palette only when something is attached. → { attachments: { [aid]: attachment },
// palette }. Empty while loading, when the rubric feature is off, or on any error:
// callers then fall back to the compact grid.
import { useState, useEffect } from 'react';
import { getRubricsForAssignments, getRubricConfig } from '../services/api.js';

const NONE = Object.freeze({});
const EMPTY = Object.freeze({ attachments: NONE, palette: NONE });

export function useAttachedRubrics(assignmentIds = [], reloadKey = 0) {
  const key = [...new Set(assignmentIds.filter((id) => id != null && id !== '').map(String))].sort().join(',');
  const [loaded, setLoaded] = useState({ key: null, value: EMPTY });

  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => getRubricsForAssignments(key.split(',')))
      .then(async (r) => {
        const attachments = (r && r.attachments) || NONE;
        if (Object.keys(attachments).length === 0) return { attachments, palette: NONE };
        const palette = await Promise.resolve().then(() => getRubricConfig())
          .then((c) => c?.reportingCategoryColors || NONE).catch(() => NONE);
        return { attachments, palette };
      })
      .catch(() => EMPTY)
      .then((value) => { if (active) setLoaded({ key, value }); });
    return () => { active = false; };
  }, [key, reloadKey]);

  return loaded.key === key ? loaded.value : EMPTY;
}
