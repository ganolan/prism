import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, toggleCourseVisibility } from '../services/api.js';
import { groupBySemester, groupByYearAndSemester } from '../lib/courseDisplay.js';
import ArchivedCoursesPanel from '../components/ArchivedCoursesPanel.jsx';
import { useDataVersion, useBumpDataVersion } from '../hooks/useDataVersion.jsx';
import { useBackgroundSync } from '../hooks/useBackgroundSync.js';
import SyncStatus from '../components/SyncStatus.jsx';
import SyncHelp from '../components/SyncHelp.jsx';
import { useSyncFacts } from '../hooks/useSyncFacts.js';
import SyncDialog from '../components/SyncDialog.jsx';
import { useStickyTab } from '../hooks/useStickyTab.js';
import TriageSection from '../components/triage/TriageSection.jsx';
import StatsStrip from '../components/triage/StatsStrip.jsx';
import { courseTriageSummary, courseRedLine } from '../lib/triage.js';

// The first run (#171): a course whose first read has not finished yet is 'pending', and stays off
// the dashboard while a run reads it (one whose read failed is shown, with a "Sync failed" badge).
// A pending row with no run going was left by a run that stopped: it shows as "Sync failed" too.
const isPending = (c) => c.first_sync === 'pending';
const COURSES_POLL_MS = 3000;
const PAST_IMPORT_POLL_MS = 5000;

// The oldest course_synced_at among the tab's visible courses; null when one never synced.
// `reading`: pending courses are being read (and are not shown), so they do not count.
function oldestSynced(courses, archived, reading) {
  const live = courses.filter((c) => Boolean(c.archived) === archived && !c.hidden && !(reading && isPending(c)));
  if (!live.length || live.some((c) => !c.course_synced_at)) return null;
  return live.map((c) => c.course_synced_at).sort()[0];
}

export default function Dashboard() {
  const dataVersion = useDataVersion();
  const [activeTab, setActiveTab] = useStickyTab('dashboard', 'current');
  const [showHidden, setShowHidden] = useState(false);
  const [courses, setCourses] = useState([]);
  // The sync status (the last run, and the nightly data's stamp), fetched again when a sync ends.
  const syncFacts = useSyncFacts(dataVersion);
  const syncStatus = syncFacts.status;
  const [loading, setLoading] = useState(true);
  // editingBlock: courseId currently being edited, blockDraft: current input value
  const [settingsCard, setSettingsCard] = useState(null);
  const [triage, setTriage] = useState(null);
  const bumpDataVersion = useBumpDataVersion();
  // Background sync: every current course, in full, when one was last synced over 10 minutes ago;
  // when that run ends every open page reloads. Sync Courses (Current tab) is one click: it asks for
  // the nightly run's scope with PowerSchool on and opens its progress (#171); the chip opens the
  // progress of the background run.
  const backgroundSync = useBackgroundSync({ kind: 'all' }, { onDone: () => bumpDataVersion() });
  const [syncOpen, setSyncOpen] = useState(false);
  const [followRun, setFollowRun] = useState(null);

  // The course list fetched while the background run was going holds pending rows that run is
  // still reading; one fetched after it may hold rows a stopped run left behind.
  const runActive = backgroundSync.state === 'queued' || backgroundSync.state === 'running';
  const runActiveRef = useRef(runActive);
  runActiveRef.current = runActive;
  const [listedDuringRun, setListedDuringRun] = useState(false);
  // Only the latest reload's answer is applied: a slow poll never lands on the other tab.
  const reloadToken = useRef(0);

  const reload = useCallback(async () => {
    const mine = (reloadToken.current += 1);
    const duringRun = runActiveRef.current;
    try {
      let coursesData;
      if (showHidden) {
        // Fetch all including hidden, filter by tab client-side
        const all = await getCourses(true, true);
        coursesData = activeTab === 'current'
          ? all.filter(c => !c.archived)
          : all.filter(c => c.archived);
      } else {
        coursesData = await getCoursesByView(activeTab);
      }
      if (mine !== reloadToken.current) return;
      setCourses(coursesData);
      setListedDuringRun(duringRun);
    } catch (err) {
      console.error(err);
    } finally {
      if (mine === reloadToken.current) setLoading(false);
    }
  }, [activeTab, showHidden]);

  useEffect(() => {
    reload();
  }, [reload, dataVersion]);

  // When the run stops going (done, failed, or held for a sign-in, which bumps no data version),
  // the list is read again, so a pending row it left shows as "Sync failed".
  const wasActive = useRef(runActive);
  useEffect(() => {
    if (wasActive.current && !runActive) reload();
    wasActive.current = runActive;
  }, [runActive, reload]);

  // The first run: "Getting your courses: X of Y" over the Current tab's courses (not the excluded
  // ones), X those whose first read finished, while the run goes. The list is fetched again every
  // 3 seconds while the run goes and a course is pending, or no course is listed yet.
  // Pending rows are being read. Before the page knows whether a run goes ('idle'), they are taken
  // as being read, so a course mid-read never flashes "Sync failed".
  const reading = runActive || listedDuringRun || backgroundSync.state === 'idle';
  const counted = activeTab === 'current' ? courses.filter((c) => !c.excluded) : [];
  const pendingCount = reading ? counted.filter(isPending).length : 0;
  const pollCourses = activeTab === 'current' && runActive && (pendingCount > 0 || courses.length === 0);
  useEffect(() => {
    if (!pollCourses) return undefined;
    const timer = setInterval(reload, COURSES_POLL_MS);
    return () => clearInterval(timer);
  }, [pollCourses, reload]);

  // The past-course import (Archived tab): its status every 5 seconds while it imports, or while
  // it waits to start during a run (the run's end reloads the status too), and the archived
  // courses again whenever its count moves.
  const pastImport = syncFacts.pastImport;
  const importing = activeTab === 'archived' && pastImport?.state === 'importing';
  const pollImport = importing || (activeTab === 'archived' && pastImport?.state === 'waiting' && runActive);
  useEffect(() => {
    if (!pollImport) return undefined;
    const timer = setInterval(syncFacts.reload, PAST_IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [pollImport, syncFacts.reload]);
  const importDone = pastImport?.done ?? null;
  const lastImportDone = useRef(importDone);
  useEffect(() => {
    const moved = lastImportDone.current != null && importDone !== lastImportDone.current;
    lastImportDone.current = importDone;
    if (moved && activeTab === 'archived') reload();
  }, [importDone, activeTab, reload]);

  async function handleToggleVisibility(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleCourseVisibility(courseId);
    reload();
  }

  if (loading) return <div className="loading">Loading...</div>;

  const shown = reading ? courses.filter((c) => !isPending(c)) : courses;
  const semesterGroups = groupBySemester(shown);
  const yearGroups = groupByYearAndSemester(shown);
  const firstRunLine = pendingCount > 0 ? `Getting your courses: ${counted.length - pendingCount} of ${counted.length}` : null;

  // Shared course card renderer
  function CourseCard({ c, showSemester = false }) {
    const isSettings = settingsCard === c.id;
    // Current tab only (#137): one worst-tone edge + one muted red-only line per
    // card, replacing the three chips that used to repeat the same red/amber
    // signal already shown on the strip and in the triage rail.
    const summary = !showSemester && triage ? courseTriageSummary(triage, c.id) : null;
    const toneClass = summary?.worstTone === 'red' ? ' card--tone-red' : summary?.worstTone === 'amber' ? ' card--tone-amber' : '';
    const redLine = summary ? courseRedLine(summary) : '';

    return (
      <Link
        to={`/course/${c.id}`}
        key={c.id}
        className={`card${toneClass}`}
        style={{ opacity: !!c.hidden ? 0.5 : (showSemester ? 0.75 : 1) }}
      >
        {/* Course info */}
        <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
          {c.block_number && (
            <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: '0.35rem' }}>[BK {c.block_number}]</span>
          )}
          {c.course_name}
        </h3>
        {c.grading_period && showSemester && (
          <p className="text-sm text-muted">{c.grading_period}</p>
        )}
        {redLine && <p className="text-sm text-muted course-card__triage">{redLine}</p>}

        {/* Bottom row: student count + cog / settings */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* student_count comes from the course list endpoint (active enrolments
                only — dropped students are excluded there, see #128). Empty shells
                like the master/template course report 0; they get no text rather
                than a noisy "0 students". Plain muted text, not a badge (#137) —
                it's a fact about the course, not a triage signal. */}
            {c.student_count > 0 && (
              <span className="text-sm text-muted">
                {c.student_count} student{c.student_count === 1 ? '' : 's'}
              </span>
            )}
            {!!c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
            {(c.first_sync === 'failed' || isPending(c)) && <span className="badge badge-red" title={c.first_sync_error || undefined}>Sync failed</span>}
          </div>

          {isSettings ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
              <button
                className="ghost tap-target"
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
                onClick={e => { e.preventDefault(); e.stopPropagation(); handleToggleVisibility(e, c.id); }}
              >
                {!!c.hidden ? 'Show' : 'Hide'}
              </button>
              <button
                className="ghost tap-target"
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
                onClick={e => { e.preventDefault(); e.stopPropagation(); setSettingsCard(null); }}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              className="ghost tap-target"
              style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1 }}
              onClick={e => { e.preventDefault(); e.stopPropagation(); setSettingsCard(c.id); }}
              title="Card settings"
            >
              ⚙
            </button>
          )}
        </div>
      </Link>
    );
  }

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        {/* The oldest full-sync time among the tab's courses: the tab is only as fresh as that. Only the
            Current tab has the Sync Courses button; archived data is frozen, so Archived shows the time alone. */}
        <SyncStatus
          label={activeTab === 'archived' ? null : 'Sync Courses'}
          syncedAt={oldestSynced(courses, activeTab === 'archived', reading)}
          archived={activeTab === 'archived'}
          sync={backgroundSync}
          onSync={() => setSyncOpen(true)}
          onOpen={(runId) => setFollowRun(runId)}
          help={syncFacts.nightlyData && <SyncHelp button="Sync Courses" nightly={syncFacts.nightlyData.nightly} onDashboard />}
          nightlyData={activeTab === 'archived' ? undefined : syncFacts.nightlyData}
        />
      </div>
      {syncOpen && (
        <SyncDialog
          request={{ everything: true }}
          onClose={() => setSyncOpen(false)}
          onSyncComplete={bumpDataVersion}
          onRun={backgroundSync.follow}
        />
      )}
      {followRun != null && !syncOpen && (
        <SyncDialog followRunId={followRun} onClose={() => setFollowRun(null)} onSyncComplete={bumpDataVersion} />
      )}

      {/* Controls: tab toggle + show hidden */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <button className={activeTab === 'current' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('current')}>Current</button>
        <button className={activeTab === 'archived' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('archived')}>Archived</button>
        <span style={{ color: 'var(--border)', userSelect: 'none' }}>|</span>
        {/* The whole label toggles (not just the track), so a fingertip on the
            words works too. */}
        <label
          className="show-hidden-toggle"
          onClick={() => setShowHidden(h => !h)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}
        >
          <div
            role="switch"
            aria-checked={showHidden}
            aria-label="Show hidden"
            style={{
              position: 'relative', width: '36px', height: '20px',
              background: showHidden ? 'var(--accent)' : 'var(--border)',
              borderRadius: '10px', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: '2px',
              left: showHidden ? '18px' : '2px',
              width: '16px', height: '16px',
              background: 'white', borderRadius: '50%',
              transition: 'left 0.2s',
            }} />
          </div>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Show hidden</span>
        </label>
      </div>

      {/* Current tab: course cards in the main column, the triage rail beside them
          (below them on a phone). */}
      {activeTab === 'current' && <StatsStrip triage={triage} syncStatus={syncStatus} />}
      {activeTab === 'current' && (
        <div className="triage-layout">
          <div className="triage-layout__main">
            {firstRunLine && <p className="text-sm text-muted dashboard-progress" role="status">{firstRunLine}</p>}
            {shown.length === 0 ? (
              !firstRunLine && (
                <div className="card empty-state">
                  {backgroundSync.state === 'held' ? (
                    <p>Your courses appear here once you log in to Schoology.</p>
                  ) : backgroundSync.state === 'running' || backgroundSync.state === 'queued' ? (
                    <p>Getting your courses…</p>
                  ) : (
                    <p>No courses yet. Press <strong>Sync Courses</strong> to get your courses.</p>
                  )}
                </div>
              )
            ) : (
              semesterGroups.map(({ semester, courses: semCourses }) => (
                <div key={semester} style={{ marginBottom: '1.5rem' }}>
                  <h4 className="semester-subhead">{semester}</h4>
                  <div className="grid-2">
                    {semCourses.map(c => <CourseCard key={c.id} c={c} />)}
                  </div>
                </div>
              ))
            )}
          </div>
          <TriageSection onLoaded={setTriage} />
        </div>
      )}

      {/* Archived tab */}
      {activeTab === 'archived' && (
        <div>
          {importing && (
            <p className="text-sm text-muted dashboard-progress" role="status">{`Importing past courses: ${pastImport.done} of ${pastImport.total}`}</p>
          )}
          <ArchivedCoursesPanel onImported={reload} />

          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses imported yet. Use the "Check Schoology for archived courses" action above to find and import them.</p>
            </div>
          ) : (
            yearGroups.map(({ year, semesters }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {year}
                </h3>
                {semesters.map(({ semester, courses: semCourses }) => (
                  <div key={semester} style={{ marginBottom: '1rem' }}>
                    <h4 className="semester-subhead">{semester}</h4>
                    <div className="grid-2">
                      {semCourses.map(c => <CourseCard key={c.id} c={c} showSemester />)}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
