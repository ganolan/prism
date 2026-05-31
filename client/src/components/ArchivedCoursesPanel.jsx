import { useState } from 'react';
import { discoverArchivedCourses, triggerMasteryLogin } from '../services/api.js';
import ArchivedImportList from './ArchivedImportList.jsx';
import ImportProgress from './ImportProgress.jsx';
import { useImportRunner } from '../hooks/useImportRunner.js';

// Discovery-only surface for importing archived (past) courses, mounted on the
// Dashboard Archived tab (issue #69, grouped + bulk in #71). It scrapes
// Schoology's /mycourses/past source page via the saved browser session to list
// archived sections NOT yet imported, grouped by year→semester, and imports a
// selection (or a whole year) through a progress modal. Already-imported archived
// courses are shown as cards by the Dashboard itself — this component never
// renders them. "Archived" is the app's canonical term; "past" only names
// Schoology's source page (see CONTEXT.md).
export default function ArchivedCoursesPanel({ onImported }) {
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [error, setError] = useState(null);

  const { model, run, retryFailed, reset } = useImportRunner({
    onComplete: ({ succeededIds }) => {
      if (succeededIds.length) {
        setImportedIds((prev) => {
          const next = new Set(prev);
          succeededIds.forEach((id) => next.add(id));
          return next;
        });
        onImported?.(); // refresh the Dashboard cards
      }
    },
  });

  const isImported = (s) => s.imported || importedIds.has(s.sectionId);
  const remaining = (discovered || []).filter((s) => !isImported(s));

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
      await handleCheck(); // auto re-run discovery once logged in
    } catch (e) {
      setError(e.message);
    } finally {
      setLoggingIn(false);
    }
  }

  function handleImport(sectionIds) {
    const targets = sectionIds
      .map((id) => remaining.find((s) => s.sectionId === id))
      .filter(Boolean)
      .map((s) => ({ sectionId: s.sectionId, title: s.courseTitle }));
    if (targets.length) run(targets);
  }

  return (
    <div className="archived-import">
      <h3 className="archived-import-title">Import archived courses from Schoology</h3>

      {discovered === null && (
        <div className="archived-import-action">
          <button type="button" className="secondary" onClick={handleCheck} disabled={checking || loggingIn}>
            {checking ? 'Checking…' : 'Check Schoology for archived courses'}
          </button>
        </div>
      )}

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
          <ArchivedImportList
            sections={remaining}
            busy={model.status === 'running'}
            onImport={handleImport}
          />
        </>
      )}

      {discovered && remaining.length === 0 && (
        <p className="archived-import-empty">
          {discovered.length === 0
            ? 'No archived courses found on Schoology.'
            : 'All archived courses found on Schoology are imported.'}
        </p>
      )}

      {model.status !== 'idle' && (
        <ImportProgress model={model} onRetry={retryFailed} onDone={reset} />
      )}
    </div>
  );
}
