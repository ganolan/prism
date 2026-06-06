import { useState, useMemo } from 'react';
import { formatLastSynced } from '../lib/courseDisplay.js';
import TriCheckbox from './TriCheckbox.jsx';
import { getSyncPrefs, setSyncPrefs } from '../lib/syncPrefs.js';
import NumberStepper from './NumberStepper.jsx';

const GROUPS = [
  { key: 'visible',  label: 'Visible courses',  match: (c) => !c.hidden && !c.archived && !c.excluded },
  { key: 'hidden',   label: 'Hidden courses',   match: (c) => c.hidden && !c.archived && !c.excluded },
];

const RECENT_HELP =
  'Skips submission checks for assignments with no due date and those due more than the chosen number of days ago. Courses, students, assignments, grades and mastery still sync fully.';

export default function SyncConfig({ courses, loggedIn, busy, onStart, onCancel, onLogin }) {
  const groups = useMemo(
    () => GROUPS.map((g) => ({ ...g, courses: courses.filter(g.match) })).filter((g) => g.courses.length),
    [courses]
  );
  const visibleIds = useMemo(
    () => courses.filter(GROUPS[0].match).map((c) => c.id),
    [courses]
  );

  // Selection is seeded once at mount. The parent (SyncDialog) only renders
  // SyncConfig after courses have loaded, so `courses` is stable on mount.
  const [selected, setSelected] = useState(() => new Set(visibleIds));
  const [collapsed, setCollapsed] = useState({ visible: false, hidden: true });

  const [includeHidden, setIncludeHidden] = useState(false);
  const initialPrefs = useState(getSyncPrefs)[0];
  const [recentOnly, setRecentOnly] = useState(initialPrefs.recentOnly);
  const [recentDays, setRecentDays] = useState(initialPrefs.recentDays);
  // Instant help popover for the recent-only "?" (mirrors the gradebook
  // HelpDot/popover). Positioned fixed from the dot's rect so the modal's
  // overflow can't clip it.
  const [helpPos, setHelpPos] = useState(null);
  const showHelp = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHelpPos({ left: r.left + r.width / 2, top: r.bottom + 8 });
  };
  const hideHelp = () => setHelpPos(null);

  const hiddenCount = useMemo(
    () => courses.filter((c) => c.hidden && !c.archived && !c.excluded).length,
    [courses]
  );

  const toggleCourse = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleGroup = (group) => setSelected((prev) => {
    const next = new Set(prev);
    const ids = group.courses.map((c) => c.id);
    const allOn = ids.every((id) => next.has(id));
    ids.forEach((id) => (allOn ? next.delete(id) : next.add(id)));
    return next;
  });
  const toggleCollapse = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const count = selected.size;

  return (
    <div className="sync-config">
      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 1 · Schoology data</span>
          <span className="sync-badge sync-badge-run">Always runs</span>
        </div>
        <p className="sync-step-desc">
          Courses, students, assignments, grades &amp; submission status — all sections in one pass.
        </p>
        <div className="sync-step-toggles">
          <label>
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
            />
            <span>Include hidden courses{hiddenCount > 0 ? ` (${hiddenCount})` : ''}</span>
          </label>
          <div className="sync-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={recentOnly}
                onChange={(e) => setRecentOnly(e.target.checked)}
              />
              <span>Include only recent submissions</span>
            </label>
            <span
              className="help-dot"
              role="img"
              tabIndex={0}
              aria-label={RECENT_HELP}
              onMouseEnter={showHelp}
              onMouseLeave={hideHelp}
              onFocus={showHelp}
              onBlur={hideHelp}
            >?</span>
          </div>
          {recentOnly && (
            <div className="sync-recent-days">
              <span>Due within</span>
              <NumberStepper
                value={recentDays}
                onChange={setRecentDays}
                min={1}
                max={365}
                aria-label="Day window"
              />
              <span>days</span>
            </div>
          )}
        </div>
      </div>

      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 2 · Mastery (SBG) data</span>
          <span className="sync-badge">Optional</span>
        </div>

        {!loggedIn ? (
          <div className="alert alert-warning sync-login-prompt">
            <p>Mastery sync needs a Schoology browser session. Log in once to enable it.</p>
            <button className="secondary" onClick={onLogin} disabled={busy}>
              Log in to Schoology
            </button>
          </div>
        ) : (
          <>
            <div className="alert alert-warning sync-disclaimer">
              Mastery sync opens a browser session and runs one course at a time —
              roughly 20–40s per course. Pick only what you need.
            </div>
            {groups.map((group) => {
              const ids = group.courses.map((c) => c.id);
              const onCount = ids.filter((id) => selected.has(id)).length;
              return (
                <div className="sync-group" key={group.key}>
                  <div className="sync-group-head">
                    <button
                      type="button"
                      className="sync-caret"
                      onClick={() => toggleCollapse(group.key)}
                      aria-label={`${collapsed[group.key] ? 'Expand' : 'Collapse'} ${group.label.toLowerCase()}`}
                    >
                      {collapsed[group.key] ? '▸' : '▾'}
                    </button>
                    <label className="sync-group-label">
                      <TriCheckbox
                        aria-label={`Select all ${group.label.toLowerCase()}`}
                        checked={onCount === ids.length}
                        indeterminate={onCount > 0 && onCount < ids.length}
                        onChange={() => toggleGroup(group)}
                      />
                    </label>
                    <button
                      type="button"
                      className="sync-group-name"
                      onClick={() => toggleCollapse(group.key)}
                    >
                      {group.label} <span className="text-muted">({onCount} of {ids.length})</span>
                    </button>
                  </div>
                  {!collapsed[group.key] && (
                    <div className="sync-course-list">
                      {group.courses.map((c) => (
                        <div className="sync-course-row" key={c.id}>
                          <label className="sync-course">
                            <input
                              type="checkbox"
                              checked={selected.has(c.id)}
                              onChange={() => toggleCourse(c.id)}
                            />
                            <span>{c.course_name}</span>
                          </label>
                          {group.key === 'visible' && (
                            <span className="sync-course-synced text-muted text-sm">{formatLastSynced(c.synced_at)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="sync-foot">
        <span className="text-muted text-sm">
          Schoology + {count} mastery course{count === 1 ? '' : 's'}
        </span>
        <div className="sync-foot-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setSyncPrefs({ recentOnly, recentDays });
              onStart([...selected], { includeHidden, recentOnly, recentDays });
            }}
            disabled={busy}
          >
            Start sync
          </button>
        </div>
      </div>

      {helpPos && (
        <div className="help-pop" role="tooltip" style={{ left: helpPos.left, top: helpPos.top }}>
          {RECENT_HELP}
        </div>
      )}
    </div>
  );
}
