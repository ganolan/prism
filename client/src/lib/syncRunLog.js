// Render helpers for Settings → Recent syncs: a stored sync run (see
// server/services/syncRuns.js) and its event log as readable lines. Each
// event's `level` ('error' | 'warning' | null) comes from the server, which
// owns the classification rule.

const STATUS = {
  running: { label: 'Running…', badge: 'badge-blue' },
  completed: { label: 'Completed', badge: 'badge-green' },
  failed: { label: 'Failed', badge: 'badge-red' },
  interrupted: { label: 'Interrupted', badge: 'badge-gray' },
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function runStatus(run) {
  if (run?.status === 'completed_with_errors') {
    return { label: `Completed with ${plural(run.error_count || 0, 'error')}`, badge: 'badge-amber' };
  }
  return STATUS[run?.status] || { label: run?.status || 'Unknown', badge: 'badge-gray' };
}

function msToText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

// Wall time between two ISO timestamps; '' while still running.
export function formatDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '';
  const ms = new Date(finishedAt) - new Date(startedAt);
  return Number.isNaN(ms) ? '' : msToText(ms);
}

// What the run was asked to sync, e.g. "Schoology · blocks · 2 mastery courses".
export function describeOptions(options) {
  if (!options) return '';
  const parts = [];
  if (!options.skipSchoology) parts.push(options.recentOnly ? `Schoology (last ${options.recentDays} days)` : 'Schoology');
  if (options.syncBlocks) parts.push('blocks');
  const n = options.masteryCourseIds?.length || 0;
  if (n) parts.push(plural(n, 'mastery course'));
  return parts.join(' · ');
}

const ICON = { running: '●', done: '✓', error: '✕' };

function phaseLabel(evt) {
  if (evt.phase === 'schoology') return 'Schoology data';
  if (evt.phase === 'blocks') return 'PowerSchool blocks';
  if (evt.phase === 'mastery') return `Mastery · ${evt.courseName || `course ${evt.courseId}`}`;
  return evt.phase;
}

// One event → { icon, text, level }, or null for events not worth a line.
export function describeRunEvent(evt) {
  const level = evt.level ?? null;
  if (evt.type === 'run') return null;
  if (evt.type === 'log') return { icon: '', text: evt.message || '', level };
  if (evt.type === 'error') return { icon: '✕', text: evt.message || 'Sync failed', level: level || 'error' };
  if (evt.type === 'summary') {
    const t = msToText(evt.elapsedMs || 0);
    return { icon: '', text: evt.fatal ? `Stopped after ${t}` : `Finished in ${t}`, level };
  }
  if (evt.phase) {
    let outcome = '';
    if (evt.status === 'running') outcome = 'started';
    else if (evt.status === 'error') outcome = evt.message || 'not synced';
    else if (evt.status === 'done') {
      outcome = evt.records != null ? plural(evt.records, 'record') : 'done';
      if (evt.notReady > 0) outcome += `, ${evt.notReady} not yet published in PowerSchool`;
    }
    return { icon: ICON[evt.status] || '○', text: `${phaseLabel(evt)} — ${outcome}`, level };
  }
  return null;
}
