// The student page's per-assignment links (#135), loaded after the page renders and
// never blocking it. Both are scoped to the one student: the page is projected in
// parent-teacher interviews, so nothing about another student is fetched.
import { useState, useEffect, useRef, useCallback } from 'react';
import { getStudentWorkLinks, getStudentCommentSummaries } from '../services/api.js';

export const WORK_LINK_CHUNK = 3;
// Statuses that mean no OneDrive lookup can work right now: stop asking.
const GIVE_UP = new Set(['no_session', 'sso_failed']);

// The student's own OneDrive copy per lti assignment: { [aid]: link }. Asked for a
// few assignments at a time (each request shares one browser session on the
// server), filled in as each answer arrives.
export function useStudentWorkLinks(studentId, assignmentIds = [], reloadKey = 0) {
  const ids = [...new Set(assignmentIds.filter(Boolean).map(String))].join(',');
  const [links, setLinks] = useState({});
  useEffect(() => {
    setLinks({});
    if (!studentId || !ids) return undefined;
    let active = true;
    (async () => {
      const all = ids.split(',');
      for (let i = 0; i < all.length && active; i += WORK_LINK_CHUNK) {
        let r;
        try { r = await getStudentWorkLinks(studentId, all.slice(i, i + WORK_LINK_CHUNK)); } catch { return; }
        if (!active) return;
        const found = Object.fromEntries(Object.entries(r?.links || {}).filter(([, l]) => l));
        if (Object.keys(found).length) setLinks((prev) => ({ ...prev, ...found }));
        if (Object.values(r?.status || {}).some((s) => GIVE_UP.has(s))) return;
      }
    })();
    return () => { active = false; };
  }, [studentId, ids, reloadKey]);
  return links;
}

// The student's submission comment summaries: { [aid]: summary }, or null while
// loading or when the feature is off (no chips). The first call queues a
// background read of their submitted threads; one later re-read picks it up.
export function useStudentCommentSummaries(studentId, reloadKey = 0) {
  const [summaries, setSummaries] = useState(null);
  const poll = useRef(null);
  useEffect(() => {
    setSummaries(null);
    if (!studentId) return undefined;
    let active = true;
    const load = (refresh) => Promise.resolve()
      .then(() => getStudentCommentSummaries(studentId, { refresh }))
      .then((r) => {
        if (!active) return;
        setSummaries(r?.assignments || {});
        if (refresh && r?.refresh?.queued > 0) {
          clearTimeout(poll.current);
          poll.current = setTimeout(() => load(false), Math.min(60000, r.refresh.queued * 700 + 2000));
        }
      })
      .catch(() => {});
    load(true);
    return () => { active = false; clearTimeout(poll.current); };
  }, [studentId, reloadKey]);
  const update = useCallback((aid, summary) => {
    setSummaries((prev) => ({ ...(prev || {}), [aid]: summary }));
  }, []);
  return [summaries, update];
}
