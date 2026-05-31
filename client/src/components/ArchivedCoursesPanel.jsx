import { useState } from 'react';
import { discoverArchivedCourses, importCourse, triggerMasteryLogin } from '../services/api.js';

// Discovery-only surface for importing archived (past) courses, mounted on the
// Dashboard Archived tab (issue #69). It scrapes Schoology's /mycourses/past source
// page via the saved browser session to list archived sections NOT yet imported, and
// imports them once (per-course or bulk). Already-imported archived courses are shown
// as cards by the Dashboard itself — this component never renders them (no
// duplication). Self-contained login: it owns the "Log in to Schoology" trigger and
// its busy state, and auto-re-runs discovery on success. "Archived" is the app's
// canonical term; "past" only names Schoology's source page (see CONTEXT.md).
export default function ArchivedCoursesPanel({ onImported }) {
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [importingId, setImportingId] = useState(null);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [bulk, setBulk] = useState(null); // { done, total } while bulk-importing
  const [error, setError] = useState(null);

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

  async function handleLogin() {
    setLoggingIn(true); setError(null);
    try {
      await triggerMasteryLogin();
      await handleCheck(); // auto re-run discovery once logged in (owns the needLogin transition)
    } catch (e) {
      setError(e.message);
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleImport(sectionId) {
    setImportingId(sectionId); setError(null);
    try {
      await importCourse(sectionId);
      markImported(sectionId); // drops it from the to-import queue below
      onImported?.();           // refetch so it appears as a card on the Dashboard
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
      // `done` counts attempts so the bar advances even on a failure; importedIds
      // reflects the actual successes.
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
    if (anySucceeded) onImported?.(); // refresh the cards once
  }

  // The found-list is the to-import queue — only sections not already imported.
  // Imported ones are the Dashboard's cards (no duplication here).
  const remaining = (discovered || []).filter((s) => !isImported(s));
  const importAllCount = remaining.filter((s) => !s.noCourseCode).length;

  return (
    <div className="archived-import">
      <h3 className="archived-import-title">Import archived courses from Schoology</h3>

      {/* One action slot: "Check Schoology" before a scan, then it transforms in
          place into "Import all" once the queue is known. */}
      <div className="archived-import-action">
        {discovered === null ? (
          <button type="button" className="secondary" onClick={handleCheck} disabled={checking || loggingIn}>
            {checking ? 'Checking…' : 'Check Schoology for archived courses'}
          </button>
        ) : importAllCount > 0 ? (
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
        ) : null}
      </div>

      {needLogin && (
        <div className="alert alert-warning sync-login-prompt">
          <p>Finding archived courses needs a Schoology browser session. Log in once to enable it.</p>
          <button type="button" className="secondary" onClick={handleLogin} disabled={loggingIn}>
            {loggingIn ? 'Logging in…' : 'Log in to Schoology'}
          </button>
        </div>
      )}

      {error && <div className="alert alert-warning">{error}</div>}

      {discovered && remaining.length > 0 && (
        <>
          <p className="archived-import-found">
            Found on Schoology ({discovered.length}) — {remaining.length} not yet imported
          </p>
          <div className="archived-import-list">
            {remaining.map((s) => (
              <div className="archived-import-row" key={s.sectionId}>
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
        </>
      )}

      {discovered && remaining.length === 0 && (
        <p className="archived-import-empty">
          {discovered.length === 0
            ? 'No archived courses found on Schoology.'
            : 'All archived courses found on Schoology are imported.'}
        </p>
      )}
    </div>
  );
}
