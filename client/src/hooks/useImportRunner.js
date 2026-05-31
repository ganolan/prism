import { useState, useRef, useCallback } from 'react';
import { importCourse } from '../services/api.js';

// Drives a SEQUENTIAL archived-course import (mastery uses a single browser
// session — one course at a time) and exposes a render model for the progress
// modal. `importer` is injectable for tests. onComplete(summary) fires once when
// a run finishes — summary = { total, succeeded, succeededIds, failures }. (#71)
const EMPTY = { status: 'idle', total: 0, done: 0, progress: 0, rows: [], log: [], failures: [] };

export function useImportRunner({ onComplete, importer = importCourse } = {}) {
  const [model, setModel] = useState(EMPTY);
  const ref = useRef(EMPTY);
  const publish = (m) => { ref.current = m; setModel(m); };

  const runTargets = useCallback(async (targets, priorLog) => {
    const rows = targets.map((t) => ({ ...t, status: 'pending' }));
    const log = [...priorLog];
    const failures = [];
    publish({
      status: 'running', total: targets.length, done: 0,
      progress: targets.length ? 0 : 1, rows: [...rows], log: [...log], failures: [],
    });

    for (let i = 0; i < targets.length; i++) {
      rows[i] = { ...rows[i], status: 'running' };
      publish({ ...ref.current, rows: [...rows] });
      try {
        const res = await importer(targets[i].sectionId);
        const counts = {
          students: res?.studentsCount ?? 0,
          assignments: res?.assignmentsCount ?? 0,
          grades: res?.gradesCount ?? 0,
        };
        rows[i] = { ...rows[i], status: 'done', counts };
        log.push(`Imported ${targets[i].title} (${counts.students} students, ${counts.grades} grades)`);
      } catch (e) {
        const error = e?.message || 'import failed';
        rows[i] = { ...rows[i], status: 'error', error };
        failures.push({ sectionId: targets[i].sectionId, title: targets[i].title, error });
        log.push(`${targets[i].title} failed: ${error}`);
      }
      const done = i + 1;
      publish({ ...ref.current, rows: [...rows], log: [...log], failures: [...failures], done, progress: done / targets.length });
    }

    publish({ ...ref.current, status: 'done' });
    const succeededIds = rows.filter((r) => r.status === 'done').map((r) => r.sectionId);
    onComplete?.({ total: ref.current.total, succeeded: succeededIds.length, succeededIds, failures });
  }, [importer, onComplete]);

  const run = useCallback((targets) => runTargets(targets, []), [runTargets]);
  const retryFailed = useCallback(() => {
    const targets = ref.current.failures.map((f) => ({ sectionId: f.sectionId, title: f.title }));
    if (targets.length) runTargets(targets, ref.current.log);
  }, [runTargets]);
  const reset = useCallback(() => publish(EMPTY), []);

  return { model, run, retryFailed, reset };
}
