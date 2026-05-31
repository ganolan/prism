import { useState } from 'react';
import { getPastSections, importCourse } from '../services/api.js';
import { parseGradingPeriod, groupByAcademicYear, formatLastSynced } from '../lib/courseDisplay.js';

// Import-once panel for past/archived courses, embedded in the Sync dialog.
// Imported archived courses (already in the DB) render grouped by year; an
// explicit "Check Schoology for past courses" scrape surfaces not-yet-imported
// sections to import per-course or in bulk. Issue #5.
export default function PastCoursesPanel({ courses, loggedIn, onLogin, busy }) {
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
      const res = await getPastSections();
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
      markImported(sectionId);
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingId(null);
    }
  }

  async function handleImportAll() {
    const targets = (discovered || []).filter((s) => !isImported(s) && !s.noCourseCode);
    setBulk({ done: 0, total: targets.length }); setError(null);
    for (let i = 0; i < targets.length; i++) {
      try {
        await importCourse(targets[i].sectionId);
        markImported(targets[i].sectionId);
      } catch (e) {
        setError(e.message);
      }
      // `done` counts sections processed (attempts), so the progress bar always
      // advances even if one fails; importedIds reflects the actual successes.
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
  }

  const remaining = (discovered || []).filter((s) => !isImported(s));
  const importAllCount = remaining.filter((s) => !s.noCourseCode).length;

  return (
    <div className="sync-step">
      <div className="sync-step-title">
        <button
          type="button"
          className="sync-caret"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand past courses' : 'Collapse past courses'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span>Past courses</span>
        <span className="sync-badge">Import once</span>
      </div>

      {!collapsed && (
        <>
          {yearGroups.length === 0 ? (
            <p className="sync-step-desc">No past courses imported yet.</p>
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
              {checking ? 'Checking…' : 'Check Schoology for past courses'}
            </button>
          </div>

          {needLogin && (
            <div className="alert alert-warning sync-login-prompt">
              <p>Finding past courses needs a Schoology browser session. Log in once to enable it.</p>
              <button type="button" className="secondary" onClick={onLogin} disabled={busy}>Log in to Schoology</button>
            </div>
          )}

          {error && <div className="alert alert-warning">{error}</div>}

          {discovered && discovered.length > 0 && (
            <div className="sync-group">
              <div className="sync-group-name">
                Found on Schoology ({discovered.length}) — {remaining.length} not yet imported
              </div>
              {importAllCount > 0 && (
                <button
                  type="button"
                  className="primary"
                  onClick={handleImportAll}
                  disabled={!!bulk || importingId !== null}
                  style={{ marginBottom: '0.6rem' }}
                >
                  {bulk
                    ? `Importing ${bulk.done}/${bulk.total}…`
                    : `Import all (${importAllCount}, excl. no-code)`}
                </button>
              )}
              <div className="sync-course-list">
                {discovered.map((s) => (
                  <div className="sync-course past-discovery-row" key={s.sectionId}>
                    <span>
                      {s.courseTitle}
                      {s.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                    </span>
                    {isImported(s) ? (
                      <button type="button" className="secondary" disabled>Imported ✓</button>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleImport(s.sectionId)}
                        disabled={importingId === s.sectionId || !!bulk}
                      >
                        {importingId === s.sectionId ? 'Importing…' : 'Import'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {discovered && discovered.length === 0 && (
            <p className="sync-step-desc">No past courses found on Schoology.</p>
          )}
        </>
      )}
    </div>
  );
}
