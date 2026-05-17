// Reduce a stream of sync progress events (see syncOrchestrator.js for shapes)
// into render-ready UI state for the progress overlay.
export function reduceSyncEvents(events) {
  const phases = [];
  const logLines = [];
  let summary = null;
  let fatal = false;
  const find = (key) => phases.find((p) => p.key === key);

  for (const evt of events) {
    if (evt.type === 'log') { logLines.push(evt.message); continue; }
    if (evt.type === 'summary') { summary = evt; fatal = fatal || !!evt.fatal; continue; }
    if (evt.type === 'error') { fatal = true; continue; }

    if (evt.phase === 'schoology') {
      let p = find('schoology');
      if (!p) { p = { key: 'schoology', kind: 'schoology', label: 'Schoology data' }; phases.push(p); }
      p.status = evt.status;
      if (evt.records != null) p.records = evt.records;
      if (evt.message) p.message = evt.message;
    } else if (evt.phase === 'mastery') {
      const key = `mastery:${evt.courseId}`;
      let p = find(key);
      if (!p) { p = { key, kind: 'mastery', courseId: evt.courseId }; phases.push(p); }
      p.status = evt.status;
      p.label = `Mastery · ${evt.courseName}`;
      if (evt.records != null) p.records = evt.records;
      if (evt.errorKind) p.errorKind = evt.errorKind;
      if (evt.message) p.message = evt.message;
    }
  }

  const failures = phases.filter((p) => p.status === 'error');
  const done = phases.filter((p) => p.status === 'done' || p.status === 'error').length;
  const progress = phases.length ? done / phases.length : 0;
  return { phases, logLines, summary, fatal, failures, progress };
}
