import { useState } from 'react';
import { discoverArchivedCourses, importCourse } from '../services/api.js';
import { parseGradingPeriod, groupByAcademicYear, formatLastSynced } from '../lib/courseDisplay.js';

// Import-once panel for archived (past) courses, embedded in the Sync dialog.
// Imported archived courses are shown ONCE — grouped by year at the top (the
// richer view: year, semester, last-synced). An explicit "Check Schoology for
// archived courses" scrape of Schoology's /mycourses/past source page lists the
// sections NOT yet imported as a to-import queue; importing one (per-course or
// bulk) calls onImported() so the dialog refetches and the course moves up into
// the grouped section. "Archived" is the app's canonical term; "past" only names
// Schoology's source page (see CONTEXT.md). Issue #5.
export default function ArchivedCoursesPanel({ courses, loggedIn, onLogin, busy, onImported }) {
  const [collapsed, setCollapsed] = useState(true);
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [importingId, setImportingId] = useState(null);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [bulk, setBulk] = useState(null); // { done, total } while bulk-importing
  const [error, setError] = useState(null);

  const yearGroups = groupByAcademicYear(courses.filter((c) => c.archived));

  const isImported = (s) => s.imported || importedIds.has(s.sectionId);
  const markImported = (sectionId) =>
    setImportedIds((prev) => new Set(prev).add(sectionId));

  async function handleCheck() {
    setChecking(true); setError(null); setNeedLogin(false);
    try {
      const res = await discoverArchivedCourses();
      if (!res.available) { setNeedLogin(true); setDiscovered(null); }
      else setDiscovered(res.sections);
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function handleImport(sectionId) {
    setImportingId(sectionId); setError(null);
    try {
      await importCourse(sectionId);
      markImported(sectionId); // drops it from the to-import queue below
      onImported?.();           // refetch so it appears in the grouped section above
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingId(null);
    }
  }

  async function handleImportAll() {
    const targets = (discovered || []).filter((s) => !isImported(s) && !s.noCourseCode);
    setBulk({ done: 0, total: targets.length }); setError(null);
    let anySucceeded = false;
    for (let i = 0; i < targets.length; i++) {
      try {
        await importCourse(targets[i].sectionId);
        markImported(targets[i].sectionId);
        anySucceeded = true;
      } catch (e) {
        setError(e.message);
      }
      // `done` counts sections processed (attempts), so the progress bar always
      // advances even if one fails; importedIds reflects the actual successes.
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
    if (anySucceeded) onImported?.(); // refresh the grouped section once
  }

  // The found-list is the to-import queue — only sections not already imported.
  // Imported ones live in the grouped-by-year section above (no duplication).
  const remaining = (discovered || []).filter((s) => !isImported(s));
  const importAllCount = remaining.filter((s) => !s.noCourseCode).length;

  return (
    <div className="sync-step">
      <div className="sync-step-title">
        <button
          type="button"
          className="sync-caret"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand import archived courses' : 'Collapse import archived courses'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span>Import archived courses</span>
        <span className="sync-badge">Import once</span>
      </div>

      {!collapsed && (
        <>
          {yearGroups.length === 0 ? (
            <p className="sync-step-desc">No archived courses imported yet.</p>
          ) : (
            yearGroups.map(({ year, courses: yc }) => (
              <div className="sync-group" key={year}>
                <div className="sync-group-name">{year}</div>
                <div className="sync-course-list">
                  {yc.map((c) => {
                    const { semester } = parseGradingPeriod(c.grading_period);
                    return (
                      <div className="sync-course" key={c.id}>
                        <span>{c.course_name}</span>
                        <span className="text-muted text-sm">
                          {' '}— {semester} · Imported ✓ · {formatLastSynced(c.synced_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <div className="sync-step-toggles" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="secondary" onClick={handleCheck} disabled={checking || busy}>
              {checking ? 'Checking…' : 'Check Schoology for archived courses'}
            </button>
          </div>

          {needLogin && (
            <div className="alert alert-warning sync-login-prompt">
              <p>Finding archived courses needs a Schoology browser session. Log in once to enable it.</p>
              <button type="button" className="secondary" onClick={onLogin} disabled={busy}>Log in to Schoology</button>
            </div>
          )}

          {error && <div className="alert alert-warning">{error}</div>}

          {discovered && remaining.length > 0 && (
            <div className="sync-group">
              <div className="sync-group-name">
                Found on Schoology ({discovered.length}) — {remaining.length} not yet imported
              </div>
              {importAllCount > 0 && (
                <div className="sync-step-toggles">
                  <button
                    type="button"
                    className="primary"
                    onClick={handleImportAll}
                    disabled={!!bulk || importingId !== null}
                  >
                    {bulk
                      ? `Importing ${bulk.done}/${bulk.total}…`
                      : `Import all (${importAllCount}, excl. no-code)`}
                  </button>
                </div>
              )}
              <div className="sync-course-list">
                {remaining.map((s) => (
                  <div className="sync-course archived-discovery-row" key={s.sectionId}>
                    <span>
                      {s.courseTitle}
                      {s.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleImport(s.sectionId)}
                      disabled={importingId === s.sectionId || !!bulk}
                    >
                      {importingId === s.sectionId ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {discovered && remaining.length === 0 && (
            <p className="sync-step-desc">
              {discovered.length === 0
                ? 'No archived courses found on Schoology.'
                : 'All archived courses found on Schoology are imported.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
