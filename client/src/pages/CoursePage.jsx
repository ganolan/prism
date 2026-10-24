import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse, getCourseStudents, getGradebook, getMasteryForCourse, getSubmissionLinks, getTriage, setMakeUpIgnored, setAssessmentPublished, getQuizGroups, getCourseCommentSummaries, getSubmissionFiles, getRubricConfig } from '../services/api.js';
import { PublishConfirm, PublishDone } from '../components/PublishTask.jsx';
import AnalyticsView from '../components/AnalyticsView.jsx';
import OverridePopup from '../components/OverridePopup.jsx';
import TriageSection from '../components/triage/TriageSection.jsx';
import UrgencyRing from '../components/triage/UrgencyRing.jsx';
import { waitsByAssignment, redCount } from '../lib/triage.js';
import { LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';
import { LetterGradePopup, LETTER_GRADE_COLORS } from '../components/MasteryPerformanceSummary.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import SyncHelp from '../components/SyncHelp.jsx';
import { useSyncFacts } from '../hooks/useSyncFacts.js';
import SyncDialog from '../components/SyncDialog.jsx';
import { useBackgroundSync } from '../hooks/useBackgroundSync.js';
import { gradeLabel, submissionStatus, ltiStatusUnavailable } from '../lib/gradeLabel.js';
import { masteryCodeForLevel, computeLetterGrade } from '../lib/masteryLevels.js';
import { useProficiencyScale } from '../hooks/useProficiencyScale.js';
import { groupAssignmentsByFolder } from '../lib/assessmentGroups.js';
import PersonSub, { gradeText } from '../components/PersonSub.jsx';
import LargerScreenNote from '../components/LargerScreenNote.jsx';
import { preferredFirstName } from '../lib/studentNames.js';
import { indexMastery, buildAssignmentRubric } from '../lib/gradebookMastery.js';
import { useDataVersion, useBumpDataVersion } from '../hooks/useDataVersion.jsx';
import { useStickyTab } from '../hooks/useStickyTab.js';
import StudentRubricCard from '../components/gradeCard/StudentRubricCard.jsx';
import { cardInputs, cardReasons } from '../lib/cardInputs.js';
import { useGradeCards } from '../hooks/useGradeCards.js';
import { useCardEditing } from '../hooks/useCardEditing.js';
import { buildDescriptorRows } from '../lib/rubricDescriptorRows.js';
import PsAlertBadges from '../components/PsAlertBadges.jsx';
import { forRoster, getRosterAlertsShown, setRosterAlertsShown } from '../lib/psAlerts.js';
import { useStickyTypeFilter } from '../hooks/useStickyTypeFilter.js';
import SchoologyLink from '../components/SchoologyLink.jsx';
import QuizChip from '../components/quiz/QuizChip.jsx';
import { useAttemptLinks } from '../hooks/useAttemptLinks.js';
import SubmissionComments from '../components/SubmissionComments.jsx';
import { hasNativeSubmission } from '../components/SubmissionFiles.jsx';
import { timelineSummary, lateText } from '../lib/submissionTimeline.js';
import LateClock from '../components/LateClock.jsx';
import FlagSymbol from '../components/FlagSymbol.jsx';
import { isFlag, isFinalFlag } from '../lib/flags.js';
import { DEFAULT_TYPE_FILTER, isUnpublished, passesTypeFilter, typeFilterCounts } from '../lib/assessmentTypeFilter.js';

const SHORT_BADGE = { late: 'L', draft: 'D', overdue: 'O', 'not-started': 'NS', submitted: 'S', 'in-progress': 'IP' };
const BADGE_TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-amber', green: 'badge-green', yellow: 'badge-amber', neutral: 'badge-gray' };

export default function CoursePage() {
  const { id } = useParams();
  const dataVersion = useDataVersion();
  const [course, setCourse] = useState(null);
  const [students, setStudents] = useState([]);
  const [gradebook, setGradebook] = useState(null);
  const [mastery, setMastery] = useState(null);
  const [view, setView] = useStickyTab('course', 'roster');
  const [loading, setLoading] = useState(true);
  // #58: Sync Course opens the sync dialog preset to this course; the chip opens it on the
  // background sync's run (followRun).
  const [syncOpen, setSyncOpen] = useState(false);
  const [followRun, setFollowRun] = useState(null);
  const bumpDataVersion = useBumpDataVersion();
  const [overrideTarget, setOverrideTarget] = useState(null); // { studentUid, category, currentLevel, hasOverride }
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [triageWaits, setTriageWaits] = useState({ waits: {}, feedbackLimit: 10 });
  const [triageVersion, setTriageVersion] = useState(0); // bump → the triage panels re-fetch
  // The triage rail is hidden on the Gradebook tab (it needs the width); "Triage ▸" toggles it back in.
  const [railOnGradebook, setRailOnGradebook] = useState(false);
  const [triageRed, setTriageRed] = useState(0);
  // Gradebook tab's compact Summative / Formative / Unpublished filter (lives in the tab row).
  // Remembered across visits, one setting for all courses (#144).
  const [gradebookFilter, setGradebookFilter] = useStickyTypeFilter('gradebook');

  useEffect(() => {
    // includeDropped so RosterView can show the "N dropped" toggle without a
    // second request; it splits the list on `dropped_at` (#128).
    Promise.all([getCourse(id), getCourseStudents(id, { includeDropped: true }), getGradebook(id), getMasteryForCourse(id).catch(() => null)])
      .then(([c, s, g, m]) => { setCourse(c); setStudents(s); setGradebook(g); setMastery(m); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id, dataVersion]);

  // Triage is for current courses only — none on an archived course's page.
  // null until the course has loaded.
  const courseLive = course ? !course.archived : null;

  // Assessments-tab wait column: every assignment still owed feedback (incl.
  // formative). Async + try so an automocked/absent API is a silent no-op.
  useEffect(() => {
    if (!courseLive) return;
    (async () => {
      try {
        const t = await getTriage({ courseId: id, includeFormative: true });
        if (t) setTriageWaits({ waits: waitsByAssignment(t), feedbackLimit: t.settings.feedbackLimitDays });
      } catch (err) { console.error(err); /* triage is optional on this page */ }
    })();
  }, [id, dataVersion, courseLive]);

  // Make-up tracking for one Schoology test/quiz (all students), from either the
  // make-up panel's "Ignore this test" or the Assessments-tab chip.
  function patchMakeUpIgnored(assignmentId, ignored) {
    setGradebook((g) => g && {
      ...g,
      assignments: g.assignments.map((a) => (a.id === assignmentId ? { ...a, makeup_ignored: ignored ? 1 : 0 } : a)),
    });
  }
  async function toggleMakeUp(a) {
    const r = await setMakeUpIgnored(a.id, !a.makeup_ignored);
    patchMakeUpIgnored(a.id, r.ignored);
    setTriageVersion((v) => v + 1);
  }

  // Publish or unpublish on Schoology (#138); the row shows what Schoology read back.
  async function setPublished(a, published) {
    const r = await setAssessmentPublished(id, a.id, published);
    setGradebook((g) => g && {
      ...g,
      assignments: g.assignments.map((x) => (x.id === a.id ? { ...x, published: r.published } : x)),
    });
    return r;
  }

  async function refreshMastery() {
    const m = await getMasteryForCourse(id).catch(() => null);
    setMastery(m);
  }

  // After a flag write from the gradebook pop-up (#40): the cells, topic levels and triage panels
  // read the pair's new state (the flag, the removed or restored grade, withdrawn records).
  // A failed gradebook read throws, so the Flags pill says the page could not refresh.
  async function refreshAfterFlag() {
    const g = await getGradebook(id);
    setGradebook(g);
    await refreshMastery();
    setTriageVersion((v) => v + 1);
  }

  const syncFacts = useSyncFacts(); // whether the night's refresh is on, for the Synced time's help
  // Background sync: after the page loads, the server syncs this course in full when it was last
  // synced (or tried) over 10 minutes ago; when that run ends, every part of the page reloads. An
  // archived course's data is frozen: only Sync Course re-reads it.
  const backgroundSync = useBackgroundSync(courseLive ? { kind: 'courses', courseIds: [Number(id)] } : null, {
    onDone: async () => {
      const [c, g] = await Promise.all([getCourse(id).catch(() => null), getGradebook(id).catch(() => null)]);
      if (c) setCourse(c);
      if (g) setGradebook(g);
      await refreshMastery();
      setTriageVersion((v) => v + 1);
    },
  });

  if (loading) return <div className="loading">Loading...</div>;
  if (!course) return <div className="error-msg">Course not found</div>;

  const displayName = (s) => preferredFirstName(s);

  // Course meta collapses to a single dot-separated muted line (section ·
  // students · school code) so the header is two tight rows, not four stacked
  // blocks — the gradebook's diagonal column headers need the vertical room.
  const metaItems = [
    // Block first: the Schoology section ("4(A-B)") reads like a block number but isn't one.
    course.block_number ? `Block ${course.block_number}` : null,
    course.section_name,
    `${course.studentCount} students`,
    course.section_school_code,
  ].filter(Boolean);

  return (
    <div className="fade-in">
      <header className="course-header">
        <h2 className="course-header__title">{course.course_name}</h2>

        <div className="course-header__meta-row">
          <p className="course-header__meta">
            {metaItems.map((item, i) => (
              <span key={i} className="course-header__meta-item">{item}</span>
            ))}
          </p>

          <div className="course-header__actions">
            {/* When this course last synced in full, the background sync's chip, and Sync Course. */}
            <SyncStatus
              label="Sync Course"
              syncedAt={course.course_synced_at}
              archived={!courseLive}
              sync={backgroundSync}
              onSync={() => setSyncOpen(true)}
              onOpen={(runId) => setFollowRun(runId)}
              help={<SyncHelp button="Sync Course" nightly={syncFacts.nightlyData?.nightly ?? false} archived={!courseLive} />}
            />
          </div>
        </div>
        {syncOpen && (
          <SyncDialog
            presetCourse={{ id: Number(id), name: course.course_name }}
            onClose={() => setSyncOpen(false)}
            onSyncComplete={bumpDataVersion}
            onRun={backgroundSync.follow}
          />
        )}
        {followRun != null && !syncOpen && (
          <SyncDialog followRunId={followRun} onClose={() => setFollowRun(null)} onSyncComplete={bumpDataVersion} />
        )}

        <div className="course-header__tabs">
          <button className={`tab-btn ${view === 'roster' ? 'active' : ''}`} onClick={() => setView('roster')}>
            Roster
          </button>
          <button className={`tab-btn ${view === 'gradebook' ? 'active' : ''}`} onClick={() => setView('gradebook')}>
            Gradebook
          </button>
          <button className={`tab-btn ${view === 'assessments' ? 'active' : ''}`} onClick={() => setView('assessments')}>
            Assessments
          </button>
          <button className={`tab-btn ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>
            Analytics
          </button>
          {view === 'gradebook' && gradebook?.assignments?.length > 0 && (
            <TypeFilterBar
              compact assignments={gradebook.assignments} filter={gradebookFilter}
              onChange={setGradebookFilter}
            />
          )}
          {courseLive && view === 'gradebook' && (
            <button
              className="secondary btn-sm triage-rail-toggle" aria-expanded={railOnGradebook} aria-controls="course-triage"
              onClick={() => setRailOnGradebook((v) => !v)}
            >
              {railOnGradebook ? 'Hide triage' : (
                <>Triage {triageRed > 0 && <span className="badge badge-red">{triageRed}</span>} <span aria-hidden="true">▸</span></>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Tab content in the main column, the triage rail beside it (below it on a phone). */}
      <div className="triage-layout">
        <div className="triage-layout__main">
          {(view === 'gradebook' || view === 'analytics') && <LargerScreenNote />}
          {view === 'roster' && (
            <RosterView
              students={students}
              mastery={mastery}
              courseId={id}
              displayName={displayName}
              onOverrideClick={(studentUid, category, currentLevel, hasOverride) =>
                setOverrideTarget({ studentUid, category, currentLevel, hasOverride })}
            />
          )}

          {overrideTarget && (
            <OverridePopup
              courseId={Number(id)}
              studentUid={overrideTarget.studentUid}
              objectiveId={overrideTarget.category.id}
              objectiveTitle={overrideTarget.category.title}
              currentLevel={overrideTarget.currentLevel}
              hasOverride={overrideTarget.hasOverride}
              saving={overrideSaving}
              setSaving={setOverrideSaving}
              onClose={() => setOverrideTarget(null)}
              onSaved={refreshMastery}
            />
          )}
          {view === 'gradebook' && (
            <GradebookView data={gradebook} courseId={id} mastery={mastery} filter={gradebookFilter}
              onFlagChange={!course.archived && !course.excluded ? refreshAfterFlag : null} />
          )}
          {view === 'assessments' && (
            <AssessmentsView
              data={gradebook} courseId={id} waits={triageWaits.waits} feedbackLimit={triageWaits.feedbackLimit}
              onToggleMakeUp={courseLive ? toggleMakeUp : undefined}
              onSetPublished={courseLive ? setPublished : undefined}
            />
          )}
          {view === 'analytics' && <AnalyticsView id={id} />}
        </div>
        {courseLive && (
          <TriageSection
            id="course-triage" version={triageVersion} courseId={Number(id)}
            hidden={view === 'gradebook' && !railOnGradebook}
            onLoaded={(t) => setTriageRed(redCount(t))}
            onMakeUpIgnored={(aid) => patchMakeUpIgnored(aid, true)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Roster view ────────────────────────────────────────────────────────────

function levelCellStyle(level, extra = {}) {
  const c = level ? LEVEL_COLORS[level] : null;
  return {
    background: c ? c.headerFill : 'var(--bg-subtle)',
    color: c ? CELL_TEXT : 'var(--text-muted)',
    textAlign: 'center',
    fontWeight: 700,
    fontSize: '0.82rem',
    padding: '0.5rem 0.4rem',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    ...extra,
  };
}

export function RosterView({ students, mastery, courseId, displayName, onOverrideClick }) {
  const scale = useProficiencyScale();
  const [showGradeScale, setShowGradeScale] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  // #117: PowerSchool alerts, off until turned on (a roster may be projected to a
  // class); the choice is remembered per browser. Present only with the feature on.
  const [showAlerts, setShowAlerts] = useState(getRosterAlertsShown);
  const alertsAvailable = students.some(s => Array.isArray(s.ps_alerts));
  const toggleAlerts = () => { const next = !showAlerts; setShowAlerts(next); setRosterAlertsShown(next); };
  const categories = mastery?.categories || [];
  const topics = mastery?.topics || [];
  const scores = mastery?.scores || [];
  const rollups = mastery?.rollups || [];

  // topic_id → category_id
  const topicToCategory = {};
  for (const t of topics) topicToCategory[t.id] = t.category_id;

  // uid → category_id → [points...]
  const pointsByStudentCategory = {};
  for (const s of scores) {
    const uid = String(s.student_uid);
    const catId = topicToCategory[s.topic_id];
    if (!catId || s.points == null) continue;
    (pointsByStudentCategory[uid] ??= {});
    (pointsByStudentCategory[uid][catId] ??= []).push(s.points);
  }

  // uid → objective_id → rollup row (reporting-category rollups only for the roster)
  const rollupByStudentObj = {};
  for (const r of rollups) {
    if (!r.is_category) continue;
    (rollupByStudentObj[String(r.student_uid)] ??= {})[r.objective_id] = r;
  }

  const categoryAvg = (uid, catId) => {
    const arr = pointsByStudentCategory[uid]?.[catId];
    if (!arr?.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };
  const schoologyRollup = (uid, catId) => rollupByStudentObj[String(uid)]?.[catId] || null;

  // Mismatch marker — a thick amber top+bottom border around the cell pair
  const MISMATCH_BORDER = '2px solid rgba(234, 179, 8, 0.85)';

  // #128: students who dropped keep their row (and their grades/notes) but sit
  // behind a toggle, sorted to the bottom, so the default roster is the live
  // class while a departure is still visible rather than silently vanishing.
  const activeStudents = students.filter(s => !s.dropped_at);
  const droppedStudents = students.filter(s => s.dropped_at);
  const visibleStudents = showDropped ? [...activeStudents, ...droppedStudents] : activeStudents;

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      {(droppedStudents.length > 0 || alertsAvailable) && (
        <div className="roster-toolbar">
          {droppedStudents.length > 0 && (
            <button
              className="ghost"
              onClick={() => setShowDropped(v => !v)}
              aria-expanded={showDropped}
            >
              {droppedStudents.length} dropped {showDropped ? '(hide)' : '(show)'}
            </button>
          )}
          {alertsAvailable && (
            <button
              type="button"
              className={`filter-btn ${showAlerts ? 'active' : ''}`}
              aria-pressed={showAlerts}
              onClick={toggleAlerts}
              title="Learning, health and access alerts from PowerSchool. Off by default; remembered in this browser."
            >
              PowerSchool alerts
            </button>
          )}
        </div>
      )}
      <table style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          {/* Row 1: category group headers — use full title to match mastery summary */}
          <tr>
            <th rowSpan={2}></th>
            <th rowSpan={2}>Name</th>
            <th rowSpan={2} className="col-desktop">Email</th>
            <th rowSpan={2} className="col-desktop">Grade</th>
            {categories.map((cat, i) => (
              <th
                key={cat.id}
                colSpan={2}
                title={cat.title}
                style={{
                  textAlign: 'center',
                  borderBottom: '2px solid var(--accent)',
                  borderLeft: i === 0 ? undefined : '1px solid var(--border)',
                  background: 'var(--accent-subtle)',
                  color: 'var(--accent)',
                  fontWeight: 700,
                  padding: '0.4rem 0.6rem',
                }}
              >
                {cat.title}
              </th>
            ))}
            {categories.length > 0 && (
              <th
                rowSpan={2}
                style={{
                  textAlign: 'center',
                  borderLeft: '2px solid var(--accent)',
                  background: 'var(--bg-subtle)',
                  fontWeight: 700,
                  padding: '0.4rem 0.6rem',
                  minWidth: 90,
                }}
              >
                <div>Computed Letter Grade</div>
                <button
                  className="ghost"
                  onClick={() => setShowGradeScale(true)}
                  style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem', marginTop: 2, fontWeight: 400 }}
                  title="Show HKIS letter grade scale"
                >
                  Scale ↗
                </button>
              </th>
            )}
            {categories.length > 0 && (
              <th
                rowSpan={2}
                style={{
                  textAlign: 'center',
                  borderLeft: '2px solid var(--accent)',
                  background: 'var(--accent-subtle)',
                  color: 'var(--accent)',
                  fontWeight: 700,
                  padding: '0.4rem 0.6rem',
                  minWidth: 90,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontSize: '0.75rem',
                }}
                title="Letter grade derived from Schoology's reported reporting-category levels (including overrides)"
              >
                Schoology Letter Grade
              </th>
            )}
          </tr>
          {/* Row 2: computed / schoology sub-headers */}
          <tr>
            {categories.flatMap((cat, i) => [
              <th
                key={`${cat.id}-c`}
                style={{
                  fontSize: '0.65rem', fontWeight: 500, color: 'var(--text-muted)',
                  textAlign: 'center', padding: '0.25rem 0.4rem',
                  borderLeft: i === 0 ? undefined : '1px solid var(--border)',
                }}
              >
                Computed
              </th>,
              <th
                key={`${cat.id}-s`}
                style={{
                  fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent)',
                  textAlign: 'center', padding: '0.25rem 0.4rem',
                  background: 'var(--accent-subtle)',
                  borderLeft: '2px solid var(--accent)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Schoology
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {visibleStudents.map(s => {
            const uid = s.schoology_uid || s.uid;
            // Per-student approximate letter grade using the same formula as
            // MasteryPerformanceSummary: scale.pointsToLevel(flat category average)
            // for each reporting category → computeLetterGrade().
            const categoryLevels = categories.map(cat => {
              const avg = categoryAvg(uid, cat.id);
              return avg != null ? scale.pointsToLevel(avg) : null;
            });
            const letterGrade = computeLetterGrade(categoryLevels);
            // Same formula applied to Schoology's per-category reported levels
            // (honoring overrides) — directly comparable to letterGrade.
            const schoologyCategoryLevels = categories.map(cat => {
              const r = schoologyRollup(uid, cat.id);
              const rVal = r ? (r.override_value != null ? r.override_value : r.grade_scaled_rounded) : null;
              return rVal != null ? scale.pointsToLevel(rVal) : null;
            });
            const schoologyLetterGrade = computeLetterGrade(schoologyCategoryLevels);
            return (
              <tr key={s.id} style={s.dropped_at ? { opacity: 0.55 } : undefined}>
                <td style={{ width: '40px', padding: '0.25rem 0.5rem' }}>
                  {s.picture_url ? (
                    <img
                      src={s.picture_url}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: 'var(--bg-subtle)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.75rem', color: 'var(--text-muted)',
                      fontWeight: 600,
                    }}>
                      {displayName(s)?.[0]}{s.last_name?.[0]}
                    </div>
                  )}
                </td>
                <td>
                  <Link to={`/student/${s.id}`} className="link">
                    {displayName(s)} {s.last_name}
                  </Link>
                  {displayName(s) !== s.first_name && (
                    <span className="text-sm text-muted" style={{ marginLeft: '0.5rem' }}>
                      ({s.first_name})
                    </span>
                  )}
                  {s.dropped_at && (
                    <span className="text-sm text-muted" style={{ marginLeft: '0.5rem' }}>
                      dropped {new Date(s.dropped_at).toLocaleDateString('en-GB')}
                    </span>
                  )}
                  <PersonSub parts={[s.email, gradeText(s.grad_year)]} />
                  {showAlerts && <PsAlertBadges alerts={forRoster(s.ps_alerts)} compact />}
                </td>
                <td className="text-sm col-desktop">{s.email || '-'}</td>
                <td className="text-sm col-desktop">{gradeText(s.grad_year) || '-'}</td>
                {categories.flatMap((cat, catIdx) => {
                  const avg = categoryAvg(uid, cat.id);
                  const avgLevel = avg != null ? scale.pointsToLevel(avg) : null;
                  const r = schoologyRollup(uid, cat.id);
                  const rVal = r ? (r.override_value != null ? r.override_value : r.grade_scaled_rounded) : null;
                  const rLevel = rVal != null ? scale.pointsToLevel(rVal) : null;
                  const hasOverride = r?.override_value != null;

                  // Mismatch only when BOTH sides have a value and they differ.
                  const mismatch = avgLevel && rLevel && avgLevel !== rLevel;
                  const mismatchTitle = mismatch
                    ? `Mismatch: Prism computed ${avgLevel}, Schoology reports ${rLevel}`
                    : null;
                  const mismatchBorders = mismatch
                    ? { borderTop: MISMATCH_BORDER, borderBottom: MISMATCH_BORDER }
                    : {};

                  return [
                    <td
                      key={`${cat.id}-c`}
                      title={mismatchTitle || (avg != null ? `Prism computed: ${avgLevel} (${avg.toFixed(1)})` : 'No data')}
                      style={levelCellStyle(avgLevel, {
                        borderLeft: catIdx === 0 ? undefined : '1px solid var(--border)',
                        ...mismatchBorders,
                      })}
                    >
                      {avgLevel || '-'}{avg != null ? ` (${Math.round(avg)})` : ''}
                    </td>,
                    <td
                      key={`${cat.id}-s`}
                      className="schoology-cell"
                      onClick={() => onOverrideClick(uid, cat, rLevel, hasOverride)}
                      title={mismatchTitle || (hasOverride
                        ? `Schoology reported: ${rLevel}, override set (click to change or clear)`
                        : `Schoology reported${rLevel ? `: ${rLevel}` : ': no data'} (click to set override)`)}
                      style={levelCellStyle(rLevel, {
                        cursor: 'pointer',
                        borderLeft: '2px solid var(--accent)',
                        ...mismatchBorders,
                      })}
                    >
                      {rLevel || '-'}{r?.grade_percentage != null ? ` (${Math.round(r.grade_percentage)})` : ''}{hasOverride ? '*' : ''}
                    </td>,
                  ];
                })}
                {categories.length > 0 && (
                  <td style={{
                    borderLeft: '2px solid var(--accent)',
                    background: 'var(--bg-subtle)',
                    textAlign: 'center',
                    padding: '0.4rem 0.6rem',
                    fontWeight: 800,
                    fontSize: '1.05rem',
                    color: letterGrade ? (LETTER_GRADE_COLORS[letterGrade] || 'var(--text)') : 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}
                  title={letterGrade
                    ? `Approximate letter grade from ${categoryLevels.filter(Boolean).join(' + ')}`
                    : 'Not enough data: at least one reporting category is missing a computed level'}>
                    {letterGrade || '-'}
                  </td>
                )}
                {categories.length > 0 && (
                  <td style={{
                    borderLeft: '2px solid var(--accent)',
                    background: 'var(--accent-subtle)',
                    textAlign: 'center',
                    padding: '0.4rem 0.6rem',
                    fontWeight: 800,
                    fontSize: '1.05rem',
                    color: schoologyLetterGrade ? (LETTER_GRADE_COLORS[schoologyLetterGrade] || 'var(--text)') : 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}
                  title={schoologyLetterGrade
                    ? `Letter grade from Schoology levels: ${schoologyCategoryLevels.filter(Boolean).join(' + ')}`
                    : 'Not enough data: at least one reporting category is missing a Schoology level'}>
                    {schoologyLetterGrade || '-'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {categories.length === 0 && (
        <p className="text-sm text-muted" style={{ padding: '0.75rem' }}>
          No mastery data yet. Click <strong>Sync Course</strong> above to pull reporting categories from Schoology.
        </p>
      )}
      {categories.length > 0 && (
        <p className="text-sm text-muted" style={{ padding: '0.5rem 0.75rem', marginTop: '0.25rem', borderTop: '1px solid var(--border)', fontSize: '0.72rem' }}>
          Cells with an <span style={{ padding: '0 0.3rem', borderTop: '2px solid rgba(234, 179, 8, 0.85)', borderBottom: '2px solid rgba(234, 179, 8, 0.85)' }}>amber border</span> show a mismatch between Prism's computed average and Schoology's reported level. The <strong style={{ color: 'var(--accent)' }}>Schoology</strong> column (accent-bordered) is the authoritative data: click any cell to set an override.
        </p>
      )}
      {showGradeScale && (
        <LetterGradePopup onClose={() => setShowGradeScale(false)} numCategories={categories.length} />
      )}
    </div>
  );
}

// ─── Gradebook mini rubric (#32) ─────────────────────────────────────────────

// A segmented strip — one segment per aligned measurement topic, colored by
// the student's earned level. Grey segment = topic not yet scored. Clickable.
function MiniRubricStrip({ topics, onClick }) {
  const summary = topics
    .map(t => `${t.external_id || t.title}: ${t.grade || 'not graded'}`)
    .join('\n');
  return (
    <button
      type="button"
      onClick={onClick}
      title={summary}
      aria-label="Show rubric detail"
      style={{
        display: 'flex', width: 64, height: 16, padding: 0, margin: '0 auto',
        border: '1px solid var(--border)', borderRadius: 3,
        overflow: 'hidden', cursor: 'pointer', background: 'none',
      }}
    >
      {topics.map(t => {
        const c = t.grade ? LEVEL_COLORS[t.grade] : null;
        return (
          <span
            key={t.topic_id}
            style={{ flex: 1, background: c ? c.headerFill : 'var(--bg-subtle)' }}
          />
        );
      })}
    </button>
  );
}

// Modal opened from a gradebook cell (a MiniRubricStrip, or a points-only score): the shared grade
// card (#176), the same component as the assessment page and the student page, read-only, with Edit
// and Done in place on a course Prism can write (`course.writable` from the grade-cards route: not
// archived, excluded or a linked set). Its one card comes from GET /api/students/:id/grade-cards with
// the task's id; `reloadKey` (any value that changes when the gradebook data is replaced) reads it again. The card is
// in meeting mode (no portrait, no AI suggestion), as on the student page. `grade` is the
// gradebook's own grade row, `scales` its grading_scales. `onFlagChange` refreshes the gradebook
// after a flag write, after Done and when the pop-up closes in edit mode. The pop-up widens while a
// descriptor grid shows, and in edit mode.
export function RubricModal({
  student, assignment, courseId, grade = null, scales = null, reloadKey = 0,
  commentSummary = null, onCommentSummary = null, onClose,
  onFlagChange = null,
}) {
  const name = preferredFirstName(student);
  const fullName = `${name} ${student.last_name}`;
  const aid = assignment.schoology_assignment_id;
  const { cards, course, loading, error, refetchOne } = useGradeCards({
    studentId: student.id, courseId, assignmentId: aid, reloadKey,
  });
  // Without a gradebook to refresh, the card's own read stands in.
  const edit = useCardEditing({ cards, refetchOne, onChange: onFlagChange || (() => refetchOne(aid)) });
  const card = edit.card(aid);
  const writable = course?.writable === true;
  const editing = writable && edit.isEditing(aid);
  // The student's own OneDrive (#120) or Google Drive (#142) copy, looked up when the modal opens —
  // the whole assignment's links come back (cached server-side), keep ours.
  const [workLink, setWorkLink] = useState(null);
  useEffect(() => {
    if (!assignment.is_lti_submission) return;
    let active = true;
    getSubmissionLinks(courseId, aid)
      .then(r => { if (active) setWorkLink(r.links?.[student.schoology_uid] || null); })
      .catch(() => {});
    return () => { active = false; };
  }, [courseId, aid, assignment.is_lti_submission, student.schoology_uid]);
  // The student's attempt on a linked or combined Schoology test (linked quizzes).
  const attemptLink = useAttemptLinks({ assignmentId: aid })[student.id] || null;
  // The student's own Schoology uploads, every revision (#107), read when the pop-up opens: opening
  // the pop-up is opening the student's work. A 403 means the feature is off: no chip.
  const nativeWork = hasNativeSubmission(assignment, grade);
  const [files, setFiles] = useState({ summary: null, off: false });
  useEffect(() => {
    if (!nativeWork) return undefined;
    let active = true;
    Promise.resolve().then(() => getSubmissionFiles(aid, student.id))
      .then((r) => { if (active) setFiles({ summary: { ...r.summary, read_at: r.read_at }, off: false }); })
      .catch((e) => { if (active && e?.status === 403) setFiles({ summary: null, off: true }); });
    return () => { active = false; };
  }, [nativeWork, aid, student.id]);
  // The reporting-category colours for a descriptor grid, read once a rubric is attached.
  const hasRubric = Boolean(card?.rubric);
  const [palette, setPalette] = useState({});
  useEffect(() => {
    if (!hasRubric) return undefined;
    let active = true;
    Promise.resolve().then(() => getRubricConfig())
      .then((c) => { if (active) setPalette(c?.reportingCategoryColors || {}); })
      .catch(() => {});
    return () => { active = false; };
  }, [hasRubric]);

  const inputs = card ? cardInputs({
    topics: card.topics, scoreScale: card.scoreScale, rubricData: card.rubric, student: card.student,
  }) : null;
  const wide = editing || Boolean(inputs?.rubric && buildDescriptorRows(inputs.topics, inputs.rubric).length > 0);
  const summative = !!assignment.aligned || (card?.topics?.length ?? 0) > 0;
  // Closing in edit mode is a Done without the button: the gradebook shows what was published.
  function close() {
    if (editing && onFlagChange) Promise.resolve().then(() => onFlagChange()).catch(() => {});
    onClose();
  }

  let body;
  if (card) {
    body = (
      <>
        <StudentRubricCard
          mode={editing ? 'edit' : 'view'}
          meeting
          heading={false}
          showDue
          hasDraft={card.hasDraft}
          draftRow={card.draft}
          feedbackRow={null}
          reasons={cardReasons(card, commentSummary)}
          student={inputs.student}
          topics={inputs.topics}
          rubric={inputs.rubric}
          rubricPalette={palette}
          scoreScale={card.scoreScale}
          scales={scales}
          courseId={courseId}
          assignmentId={aid}
          assignmentRow={card.assignment}
          submissionLink={workLink}
          attemptLink={attemptLink}
          commentsEnabled={!!onCommentSummary}
          commentSummary={commentSummary}
          onCommentSummary={onCommentSummary ? (_, s) => onCommentSummary(s) : null}
          filesEnabled={nativeWork && !files.off}
          fileSummary={files.summary}
          onFileSummary={(_, s) => setFiles({ summary: s, off: false })}
          resubmitEnabled={writable}
          resubmitLessonsDefault={edit.resubmitLessons}
          onEdit={writable ? () => edit.startEdit(aid) : null}
          onDone={() => edit.finishEdit(aid)}
          onSaved={(_, patch) => edit.saved(aid, patch)}
          onRefreshPair={() => edit.refreshTask(aid)}
        />
        {edit.editError(aid) && <div className="alert alert-warning" role="alert">{edit.editError(aid)}</div>}
      </>
    );
  } else if (error) {
    body = <div className="alert alert-warning" role="alert">Could not load this grade. Reload the page.</div>;
  } else {
    body = <p className="text-sm text-muted">{loading ? 'Loading…' : 'No grade for this student on this task.'}</p>;
  }

  return (
    <div className="feedback-modal-overlay" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${fullName}: ${assignment.title}`}
        className={`feedback-modal${wide ? ' feedback-modal--wide' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '0.85rem 1.1rem', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>{fullName}</div>
            <div className="text-sm text-muted" style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {assignment.title}
              <span className={`badge ${summative ? 'badge-summative' : 'badge-formative'}`} style={{ fontSize: '0.6rem' }}>{summative ? 'S' : 'F'}</span>
            </div>
          </div>
          <button className="ghost" onClick={close} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '1rem 1.1rem' }}>
          {body}
        </div>
        <div style={{ padding: '0 1.1rem 1rem' }}>
          <Link
            to={`/course/${courseId}/assessment/${aid}`}
            className="link"
            style={{ fontSize: '0.8rem' }}
          >
            Open full grading page →
          </Link>
        </div>
      </div>
    </div>
  );
}

// Schoology due dates arrive as 'YYYY-MM-DD HH:MM:SS' or ISO. Safari refuses
// the space-separated form, so swap the space for a 'T' before parsing.
function parseDue(due) {
  if (!due) return null;
  const d = new Date(due.includes('T') ? due : due.replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

// Compact gradebook column date, e.g. '05 Apr' (#37).
function formatDueShort(due) {
  const d = parseDue(due);
  return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : null;
}

// Full due date for the hover popover, e.g. '12 Apr 2024 (Fri) at 11:59 PM'.
function formatDueFull(due) {
  const d = parseDue(due);
  if (!d) return null;
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  if (!/\d{1,2}:\d{2}/.test(due)) return `${date} (${weekday})`;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} (${weekday}) at ${time}`;
}

// Compact segmented formative/summative indicator for the Assessment Type row
// (#37) — a small rounded chip, not a circular badge, so columns scan quickly.
function TypeChip({ summative }) {
  return (
    <span
      style={{
        display: 'inline-block', minWidth: 20, padding: '0.05rem 0.3rem',
        borderRadius: 4, fontSize: '0.62rem', fontWeight: 700,
        lineHeight: 1.5, textAlign: 'center', textTransform: 'none',
        background: summative ? 'var(--summative-bg)' : 'var(--formative-bg)',
        color: summative ? 'var(--summative-text)' : 'var(--formative-text)',
        boxShadow: `inset 0 0 0 1px ${summative ? 'var(--summative-border)' : 'var(--formative-border)'}`,
      }}
    >
      {summative ? 'S' : 'F'}
    </span>
  );
}

// Small circular '?' that reveals the formative/summative legend on hover.
function HelpDot({ onShow, onHide }) {
  return (
    <span
      onMouseEnter={onShow}
      onMouseLeave={onHide}
      aria-label="Assessment type legend"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 15, height: 15, borderRadius: '50%',
        background: 'var(--accent-subtle)', color: 'var(--accent)',
        fontSize: '0.62rem', fontWeight: 700, cursor: 'help',
        textTransform: 'none',
      }}
    >
      ?
    </span>
  );
}

// Diagonal column-boundary marker: a short vertical stem rising from the row
// edge, then a hairline angled up at -45° to frame each column's lane (#37).
const DIAG_STEM = 12;
function DiagSeparator({ atRightEdge }) {
  const x = atRightEdge ? '100%' : 0;
  return (
    <>
      <span aria-hidden="true" style={{
        position: 'absolute', left: x, bottom: 0,
        width: 1, height: DIAG_STEM, background: 'var(--border)',
      }} />
      <span aria-hidden="true" style={{
        position: 'absolute', left: x, bottom: DIAG_STEM,
        width: 300, height: 1, background: 'var(--border)',
        transformOrigin: 'left bottom', transform: 'rotate(-45deg)',
      }} />
    </>
  );
}

// Formative/summative legend shown by the Assessment Type row's '?' (#37).
const TYPE_LEGEND = (
  <div style={{ display: 'grid', gap: '0.5rem' }}>
    {[
      [false, 'Formative', 'Supports ongoing learning and feedback.'],
      [true, 'Summative', 'Assesses learning at key milestones.'],
    ].map(([summative, label, desc]) => (
      <div key={label} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <span style={{ marginTop: 1 }}><TypeChip summative={summative} /></span>
        <div>
          <div style={{ fontWeight: 700 }}>{label}</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{desc}</div>
        </div>
      </div>
    ))}
  </div>
);

export function GradebookView({ data, courseId, mastery, filter = DEFAULT_TYPE_FILTER, onFlagChange = null }) {
  const indexed = useMemo(() => indexMastery(mastery), [mastery]);
  const [rubricModal, setRubricModal] = useState(null);
  // The pop-up for one cell, built from the current data: the student, the task and the
  // gradebook's grade row. The grade card inside reads its own data.
  const modalFor = (studentId, assignmentId) => {
    const s = data?.students.find((x) => x.id === studentId);
    const a = data?.assignments.find((x) => x.id === assignmentId);
    const g = data?.grades?.[studentId]?.[assignmentId];
    if (!s || !a || !g) return null;
    return { student: s, assignment: a, grade: g };
  };
  useEffect(() => {
    setRubricModal((m) => (m ? (modalFor(m.student.id, m.assignment.id) || m) : m));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Comment shown instantly on cell hover (#36): { text, top, left }.
  const [commentOverlay, setCommentOverlay] = useState(null);
  // Floating header popover (#37): full assessment title, the formative/
  // summative legend, or the full due date. { left, top, width, content }.
  const [popover, setPopover] = useState(null);
  // Cached submission comment badges ({ [schoology aid]: { [student id]: summary } });
  // the gradebook starts no reads of its own. null = feature off or unreachable.
  const [commentSums, setCommentSums] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => getCourseCommentSummaries(courseId))
      .then((r) => { if (live) setCommentSums(r?.assignments || {}); })
      .catch(() => {});
    return () => { live = false; };
  }, [courseId]);
  // Layout A (18/10/2026): the cell's bottom-right corner holds one comment marker: the
  // submission-thread bubble (purple; amber when the student wrote; a red dot when
  // unread), else an outline bubble for the overall comment. The late clock is top right.
  const commentBubble = (a, s, overall = null) => commentSums && (
    <SubmissionComments variant="cell" assignmentId={a.schoology_assignment_id} studentId={s.id}
      studentName={preferredFirstName(s)} title={a.title} overall={overall}
      summary={commentSums[a.schoology_assignment_id]?.[s.id] || null}
      onSummary={(sum) => setCommentSums((prev) => ({
        ...prev, [a.schoology_assignment_id]: { ...(prev?.[a.schoology_assignment_id] || {}), [s.id]: sum },
      }))} />
  );

  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { students, grades, grading_scales, timelines = {} } = data;
  const assignments = data.assignments.filter(a => passesTypeFilter(a, filter));
  const displayName = (s) => preferredFirstName(s);

  if (!assignments.length) {
    return <div className="card"><p className="text-sm text-muted">No assessments match the current filters.</p></div>;
  }

  // #76: cell marker for an lti_submission assignment whose document fetch
  // failed at the last sync (assignment.lti_fetch_status === 'failed'). Replaces
  // the old misleading "Ungraded" dot — Prism has no submission status here, so
  // the teacher should re-sync. Hover explains via the shared header popover.
  const unavailableMark = () => (
    <span
      className="lti-unavailable"
      role="img"
      aria-label="Submission status unavailable"
      title="Submission status unavailable: re-sync to refresh"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPopover({
          left: Math.max(8, Math.min(r.left - 110, window.innerWidth - 270)),
          top: r.bottom + 8, width: 250,
          content: (
            <span>
              <strong style={{ color: 'var(--warning)' }}>Submission status unavailable.</strong>{' '}
              Prism couldn't read OneDrive submissions for this assignment at the last sync
              (it retried once). Re-sync to refresh; if your Schoology session has expired,
              run <code>mastery:login</code> first.
            </span>
          ),
        });
      }}
      onMouseLeave={() => setPopover(null)}
    >⚠</span>
  );

  // Fixed table layout keeps every assessment column an identical width so the
  // diagonal headers stay uniform (#37); NAME_W must clear the longest name.
  const COL_W = 78;
  const NAME_W = 220;
  // The last diagonal title has no neighbour column to overflow onto, so it
  // spills past the table's right edge onto the white card bg. A trailing spacer
  // column (wider than the rotated title's ~250px box) extends the header
  // background across that overflow. Body rows leave it empty (matches the body).
  const TRAIL_W = 250;

  return (
    <>
    <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: '84vh' }}>
      <table
        className="gradebook-grid"
        style={{ fontSize: '0.8rem', tableLayout: 'fixed', width: NAME_W + COL_W * assignments.length }}
      >
        <colgroup>
          <col style={{ width: NAME_W }} />
          {assignments.map(a => <col key={a.id} style={{ width: COL_W }} />)}
          <col style={{ width: TRAIL_W }} />
        </colgroup>
        {/* The whole <thead> is sticky so the diagonal header keeps one
            continuous backdrop — its cells stay transparent so a title
            overflowing rightward isn't clipped by its neighbour (#37). */}
        <thead style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--table-header-bg)' }}>
          {/* Region 1 — diagonal assessment titles. */}
          <tr>
            <th style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--table-header-bg)', verticalAlign: 'bottom' }}>Student</th>
            {assignments.map((a, i) => {
              const cleanTitle = a.title.replace(/\s*\((?:F|S)\)\s*$/i, '');
              const isLast = i === assignments.length - 1;
              const unpublished = isUnpublished(a);
              return (
                <th
                  key={a.id}
                  style={{
                    position: 'relative',
                    height: 240, padding: 0,
                    verticalAlign: 'bottom', background: 'transparent',
                  }}
                >
                  {/* Diagonal boundary markers at the column edges — the last
                      column also draws its right edge to close the lane. */}
                  <DiagSeparator />
                  {isLast && <DiagSeparator atRightEdge />}
                  {/* Diagonal title — emerges from the column centre, clips with
                      an ellipsis; the full title shows in a hover popover. The
                      redundant trailing (F)/(S) is dropped — the type now lives
                      in its own utility row below. */}
                  <Link
                    to={`/course/${courseId}/assessment/${a.schoology_assignment_id}`}
                    className="link"
                    style={{
                      // Nudged a few px right of centre so the rotated text
                      // clears its column's boundary line (#37).
                      position: 'absolute', bottom: 13, left: 'calc(50% + 6px)',
                      transformOrigin: 'left bottom', transform: 'rotate(-45deg)',
                      whiteSpace: 'nowrap', width: 250,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      fontWeight: 500,
                      // Unpublished on Schoology: muted italic title.
                      ...(unpublished ? { color: 'var(--text-muted)', fontStyle: 'italic' } : {}),
                    }}
                    onMouseEnter={(e) => setPopover({
                      left: Math.max(8, Math.min(e.clientX - 20, window.innerWidth - 290)),
                      top: e.clientY + 18, width: 272,
                      content: (
                        <>
                          <div style={{ fontWeight: 700, color: 'var(--accent)' }}>{cleanTitle}</div>
                          {unpublished && (
                            <div style={{ marginTop: 3, fontSize: '0.72rem', color: 'var(--text-muted)' }}>Unpublished on Schoology</div>
                          )}
                          {a.due_date && (
                            <div style={{ marginTop: 3, fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              Due {formatDueFull(a.due_date)}
                            </div>
                          )}
                        </>
                      ),
                    })}
                    onMouseLeave={() => setPopover(null)}
                  >
                    {cleanTitle}
                  </Link>
                  {/* Outbound Schoology link (#76). Pinned non-rotated at the
                      column's bottom-centre so it escapes the diagonal title's
                      rotation + ellipsis clipping; only shown when a web_url
                      exists. Renders nothing otherwise (SchoologyLink guards).
                      No z-index: it must clip behind the sticky Student column
                      (z-index 1) when scrolled, exactly like the title text. */}
                  <SchoologyLink
                    url={a.web_url}
                    ariaLabel={`View "${cleanTitle}" in Schoology`}
                    size={13}
                    style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)' }}
                  />
                </th>
              );
            })}
            {/* Trailing spacer — extends the header backdrop across the last
                title's rightward overflow (#76). Transparent so the thead tint
                shows through, like the other title cells. */}
            <th data-testid="grid-header-spacer" aria-hidden="true" style={{ background: 'transparent', padding: 0 }} />
          </tr>
          {/* Region 2 — Assessment Type utility row. */}
          <tr>
            <th style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-subtle)', whiteSpace: 'nowrap', padding: '0.3rem 0.85rem' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                Assessment Type
                <HelpDot
                  onShow={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPopover({
                      left: Math.max(8, r.left - 8), top: r.bottom + 8,
                      width: 232, content: TYPE_LEGEND,
                    });
                  }}
                  onHide={() => setPopover(null)}
                />
              </span>
            </th>
            {assignments.map(a => (
              <th key={a.id} style={{ background: 'var(--bg-subtle)', textAlign: 'center', padding: '0.3rem 0.1rem' }}>
                <TypeChip summative={!!a.aligned} />
              </th>
            ))}
            <th data-testid="grid-header-spacer" aria-hidden="true" style={{ background: 'var(--bg-subtle)' }} />
          </tr>
          {/* Region 3 — Due Date utility row. */}
          <tr>
            <th style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-subtle)', whiteSpace: 'nowrap', padding: '0.3rem 0.85rem', boxShadow: '0 5px 6px -3px rgba(0,0,0,0.1)' }}>Due Date</th>
            {assignments.map(a => {
              const short = formatDueShort(a.due_date);
              return (
                <th
                  key={a.id}
                  style={{
                    background: 'var(--bg-subtle)', textAlign: 'center',
                    padding: '0.3rem 0.1rem',
                    fontSize: '0.66rem', fontWeight: 600, whiteSpace: 'nowrap',
                    textTransform: 'none', color: 'var(--text-muted)',
                    cursor: short ? 'help' : 'default',
                    boxShadow: '0 5px 6px -3px rgba(0,0,0,0.1)',
                  }}
                  onMouseEnter={short ? (e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPopover({
                      left: Math.max(8, Math.min(r.left + r.width / 2 - 125, window.innerWidth - 258)),
                      top: r.bottom + 8, width: 250,
                      content: <span style={{ whiteSpace: 'nowrap' }}><strong>Due</strong> {formatDueFull(a.due_date)}</span>,
                    });
                  } : undefined}
                  onMouseLeave={short ? () => setPopover(null) : undefined}
                >
                  {short || '-'}
                </th>
              );
            })}
            <th data-testid="grid-header-spacer" aria-hidden="true" style={{ background: 'var(--bg-subtle)', boxShadow: '0 5px 6px -3px rgba(0,0,0,0.1)' }} />
          </tr>
        </thead>
        <tbody>
          {students.map(s => (
            <tr key={s.id}>
              <td style={{ position: 'sticky', left: 0, background: 'var(--card-bg)', zIndex: 1, whiteSpace: 'nowrap' }}>
                <Link to={`/student/${s.id}`} className="link">
                  {displayName(s)} {s.last_name}
                </Link>
              </td>
              {assignments.map(a => {
                // Individually-assigned assignments targeted at other students
                // render as a grayed dash with no badges or grade logic (#54).
                if (a.assignees && !a.assignees.includes(s.id)) {
                  return (
                    <td key={a.id} style={{ textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-subtle)' }} title="Not assigned to this student">-</td>
                  );
                }
                const g = grades[s.id]?.[a.id];
                // The full submission picture for this cell, as hover text (and the L).
                const tl = timelines[s.id]?.[a.id] || null;
                const tlText = timelineSummary(tl);
                if (!g) {
                  // No grade row — for lti this means the document pass found no
                  // state (no session / not covered); for native dropbox, past-due
                  // unsubmitted → Overdue. Render via the shared badge logic.
                  // #76: a recorded fetch failure shows the re-sync marker instead.
                  if (ltiStatusUnavailable({ is_lti_submission: a.is_lti_submission, lti_fetch_status: a.lti_fetch_status, score: null, exception: 0 })) {
                    return <td key={a.id} style={{ textAlign: 'center' }}>{unavailableMark()}</td>;
                  }
                  const empty = submissionStatus({
                    score: null, exception: 0, late: 0, draft: 0, submitted_at: 0,
                    is_lti_submission: a.is_lti_submission, lti_submission_state: null,
                    due_date: a.due_date, accepts_submissions: a.accepts_submissions, is_test: a.is_test,
                  });
                  if (!empty.length) return <td key={a.id} style={{ textAlign: 'center', position: 'relative' }} title={tlText || undefined}>-{commentBubble(a, s)}</td>;
                  return (
                    <td key={a.id} style={{ textAlign: 'center', whiteSpace: 'nowrap', position: 'relative' }} title={tlText || undefined}>
                      {empty.map(b => (
                        <span key={b.kind} className={`badge ${BADGE_TONE_CLASS[b.tone]}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                          {SHORT_BADGE[b.kind] || b.label[0]}
                        </span>
                      ))}
                      {commentBubble(a, s)}
                    </td>
                  );
                }
                // Aligned summatives show a mini rubric strip of the student's
                // per-topic proficiency instead of a numeric score (#32).
                // A flagged cell shows the flag's symbol in the grade's place, never the strip. A
                // Exempt hides the rubric in the pop-up too; a marker (Late, Incomplete, Absent) is
                // graded straight through, so its pop-up keeps the rubric, and Missing's pop-up shows
                // IE on every topic when Schoology holds no levels (the grade card's view mode, #40).
                const isRubricLocked = isFinalFlag(g.exception) && Number(g.exception) !== 3;
                const rubricTopics = (a.aligned && !isRubricLocked)
                  ? buildAssignmentRubric(a.schoology_assignment_id, s.schoology_uid, indexed)
                  : [];
                const showStrip = rubricTopics.length > 0 && !isFlag(g.exception);

                // Non-aligned cells (and aligned cells with no rubric data
                // available) keep the scale-aware / numeric label.
                const lbl = a.aligned
                  ? gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: null, scales: null })
                  : gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: a.grading_scale_id, scales: grading_scales });
                // For General Academic-family levels, shorten to ED/EX/D/EM/IE
                // and apply the same color coding used in the aligned rubric.
                const code = lbl.kind === 'scale' ? masteryCodeForLevel(lbl.text) : null;
                const c = code ? LEVEL_COLORS[code] : null;
                const text = lbl.kind === 'pending' ? '-' : (code || lbl.text);
                const status = submissionStatus({
                  score: g.score, exception: g.exception, late: tl?.submission?.late ?? g.late, draft: g.draft,
                  submitted_at: g.submitted_at, submission_type: g.submission_type,
                  is_lti_submission: a.is_lti_submission, lti_submission_state: g.lti_submission_state,
                  due_date: a.due_date, accepts_submissions: a.accepts_submissions, is_test: a.is_test,
                });
                // Don't double up exception text — gradeLabel already shows it.
                const inlineBadges = status.filter(b => b.kind !== 'exception');
                // Late (the submission) is a quiet clock in the cell's top-right corner, so the status
                // stays centred; graded late work keeps it (submissionStatus is empty
                // once scored). How late is in the hover text (the timeline).
                // A flagged cell keeps it too: the flag replaces the status, not the fact that the
                // work came in late (the timeline's call, else Schoology's own).
                const isLate = status.some(b => b.late) || (g.score != null && !!tl?.submission?.late)
                  || (isFlag(g.exception) && Boolean(tl?.submission?.late ?? g.late === 1));
                // A cell with an overall comment gets a corner indicator and an
                // instant hover overlay (#36) — `position: relative` anchors the
                // indicator.
                const hasComment = !!g.grade_comment;
                const thread = commentSums?.[a.schoology_assignment_id]?.[s.id] || null;
                const hasThread = thread?.count > 0;
                const cellStyle = {
                  textAlign: 'center',
                  position: 'relative',
                  ...(lbl.kind === 'mismatch' && { color: 'var(--danger)' }),
                  ...(g.resubmit_requested && { background: 'var(--badge-resubmit-bg)' }),
                  ...(g.resubmitted && { boxShadow: 'inset 0 0 0 2px var(--resubmit-ring)' }),
                };
                const openModal = () => setRubricModal(modalFor(s.id, a.id));
                // A flag stands where the grade was: its symbol with its name under it. The cell
                // button owns click and focus, so the symbol is hover-only here (passive).
                const scoreText = lbl.kind === 'exception'
                  ? <FlagSymbol code={lbl.exception} showName passive firstName={preferredFirstName(s)} aligned={Boolean(a.aligned)} savedLevel={g.saved_level ?? null} reasonLine={g.flag_line ?? null} />
                  : c
                  ? <span style={{ background: c.headerFill, color: CELL_TEXT, border: `1px solid ${c.finalBorder}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block', minWidth: 24 }}>{text}</span>
                  : text;
                // A graded cell without a rubric strip (points only, "50 / 100", or a
                // scale level) opens the same modal: comment + timeline, no rubric.
                const opensModal = !showStrip && (lbl.kind === 'numeric' || lbl.kind === 'scale' || lbl.kind === 'mismatch' || lbl.kind === 'exception');
                const inner = showStrip
                  ? <MiniRubricStrip topics={rubricTopics} onClick={openModal} />
                  : opensModal
                    ? <button type="button" className="cell-open" onClick={openModal}
                        aria-label={`${lbl.text}: show feedback`} title="Show the comment and submission detail">{scoreText}</button>
                    : scoreText;
                // #76: an ungraded cell whose lti document fetch failed shows the
                // re-sync marker in place of the pending dash.
                const ltiUnavailable = ltiStatusUnavailable({
                  is_lti_submission: a.is_lti_submission, lti_fetch_status: a.lti_fetch_status,
                  score: g.score, exception: g.exception,
                });
                // The grade comment is surfaced via the corner indicator + the
                // instant hover overlay (#36); the native title is reserved for
                // the resubmission / mismatch signals only.
                const signalTitle = [
                  g.resubmit_requested ? 'Re-submit requested' : null,
                  g.resubmitted ? 'Resubmitted since last graded' : null,
                ].filter(Boolean).join(' · ');
                const cellTitle = [
                  signalTitle,
                  lbl.kind === 'mismatch' ? 'Score does not match any defined level on this grading scale: check Schoology' : '',
                  tlText,
                ].filter(Boolean).join('\n');
                return (
                  <td
                    key={a.id}
                    style={cellStyle}
                    title={cellTitle}
                    onMouseEnter={(hasComment || hasThread) ? (e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      // Drop the overlay below the cell, but flip it above when
                      // the cell sits low in the viewport so a long comment
                      // grows upward instead of off-screen.
                      const below = r.bottom < window.innerHeight * 0.55;
                      setCommentOverlay({
                        text: g.grade_comment || '', visible: g.comment_status === 1,
                        thread: hasThread ? thread : null, studentName: preferredFirstName(s),
                        left: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
                        ...(below
                          ? { top: r.bottom + 4 }
                          : { bottom: window.innerHeight - r.top + 4 }),
                      });
                    } : undefined}
                    onMouseLeave={(hasComment || hasThread) ? () => setCommentOverlay(null) : undefined}
                  >
                    {hasComment && !hasThread && (
                      <span className="overall-comment-mark" role="img" aria-label="Has an overall comment">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                          <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.8v-2.8h-.5a1 1 0 0 1-1-1z" />
                        </svg>
                      </span>
                    )}
                    {isLate && <LateClock variant="corner" title={lateText(tl)} />}
                    {ltiUnavailable ? unavailableMark() : inner}
                    {inlineBadges.map(b => (
                      <span key={b.kind} className={`badge ${BADGE_TONE_CLASS[b.tone] || 'badge-gray'}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                        {SHORT_BADGE[b.kind] || b.label[0]}
                      </span>
                    ))}
                    {commentBubble(a, s, { text: g.grade_comment || '', visible: g.comment_status === 1 })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {rubricModal && (
      <RubricModal
        key={`${rubricModal.student.id}|${rubricModal.assignment.id}`}
        student={rubricModal.student}
        assignment={rubricModal.assignment}
        courseId={courseId}
        grade={rubricModal.grade}
        scales={data.grading_scales}
        reloadKey={data} // each new gradebook (a refetch after a flag write, Done or a sync): the open pop-up reads its card again
        commentSummary={commentSums?.[rubricModal.assignment.schoology_assignment_id]?.[rubricModal.student.id] || null}
        onCommentSummary={commentSums ? (sum) => setCommentSums((prev) => ({
          ...prev,
          [rubricModal.assignment.schoology_assignment_id]: {
            ...(prev?.[rubricModal.assignment.schoology_assignment_id] || {}), [rubricModal.student.id]: sum,
          },
        })) : null}
        onClose={() => setRubricModal(null)}
        onFlagChange={onFlagChange}
      />
    )}
    {commentOverlay && (
      <div
        style={{
          position: 'fixed',
          left: commentOverlay.left,
          ...(commentOverlay.top != null
            ? { top: commentOverlay.top }
            : { bottom: commentOverlay.bottom }),
          zIndex: 1200, maxWidth: 280,
          background: 'var(--card-bg)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
          padding: '0.5rem 0.7rem', fontSize: '0.78rem', color: 'var(--text)',
          whiteSpace: 'pre-wrap', pointerEvents: 'none',
        }}
      >
        <div className="comment-hover__label">
          Your overall comment
          {commentOverlay.text && (
            <span className={`comment-vis comment-vis--${commentOverlay.visible ? 'on' : 'off'}`}>
              {commentOverlay.visible ? 'Visible to student' : 'Hidden from student'}
            </span>
          )}
        </div>
        {commentOverlay.text
          ? <div>{commentOverlay.text}</div>
          : <div className="text-muted" style={{ fontStyle: 'italic' }}>No overall comment yet.</div>}
        {commentOverlay.thread && (
          <div className={`comment-hover__thread${(commentOverlay.thread.student_text || commentOverlay.thread.student_files > 0) ? ' comment-hover__thread--wrote' : ''}`}>
            {commentOverlay.thread.unread > 0
              ? `${commentOverlay.studentName} wrote in the submission comments (${commentOverlay.thread.unread} unread): click the bubble to open`
              : (commentOverlay.thread.student_text || commentOverlay.thread.student_files > 0)
                ? `${commentOverlay.studentName} wrote in the submission comments: click the bubble to open`
                : `${commentOverlay.thread.count} submission comment${commentOverlay.thread.count === 1 ? '' : 's'}: click the bubble to open`}
          </div>
        )}
      </div>
    )}
    {popover && (
      <div
        style={{
          position: 'fixed', left: popover.left, top: popover.top,
          width: popover.width, zIndex: 1300,
          background: 'var(--card-bg)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
          padding: '0.55rem 0.7rem', fontSize: '0.78rem', color: 'var(--text)',
          pointerEvents: 'none',
        }}
      >
        {popover.content}
      </div>
    )}
    </>
  );
}

// ─── Assessments view ────────────────────────────────────────────────────────

// Show/hide toggle for an assignment type. Filled in the type's colour while
// showing, greyed out while hidden (#22). `compact` is the Gradebook tab-row size.
const TOGGLE_VARS = {
  summative: { bg: 'var(--summative-bg)', text: 'var(--summative-text)', border: 'var(--summative-border)' },
  formative: { bg: 'var(--formative-bg)', text: 'var(--formative-text)', border: 'var(--formative-border)' },
  unpublished: { bg: 'var(--badge-gray-bg)', text: 'var(--badge-gray-text)', border: 'var(--badge-gray-text)' },
};

function TypeFilterToggle({ label, count, active, type, compact = false, title, onClick }) {
  const v = TOGGLE_VARS[type];
  const colorStyle = active
    ? { background: v.bg, color: v.text, boxShadow: `inset 0 0 0 1px ${v.border}` }
    : {
        background: 'var(--bg-subtle)',
        color: 'var(--text-muted)',
        boxShadow: 'inset 0 0 0 1px var(--border)',
        opacity: 0.7,
      };
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={title || (active ? `Hide ${label.toLowerCase()} assessments` : `Show ${label.toLowerCase()} assessments`)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: compact ? '0.3rem' : '0.4rem',
        padding: compact ? '0.15rem 0.5rem' : '0.3rem 0.7rem', borderRadius: 999, border: 'none',
        cursor: 'pointer', fontSize: compact ? '0.72rem' : '0.78rem', fontWeight: 600,
        transition: 'opacity 0.12s, background 0.12s',
        ...colorStyle,
      }}
    >
      <span style={{
        display: 'inline-block', width: compact ? 6 : 8, height: compact ? 6 : 8, borderRadius: '50%',
        background: 'currentColor', opacity: active ? 1 : 0.5,
      }} />
      {label}
      <span style={{ fontWeight: 700, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

// "Make-ups: tracked / ignored" chip for one Schoology test/quiz. On a folded quiz row,
// `label` ("Test 2") names which member it is and `title` is that test's full title.
function MakeUpChip({ a, onFlip, label, title }) {
  return (
    <button
      type="button"
      className={`badge makeup-chip ${a.makeup_ignored ? 'badge-gray' : 'badge-blue'}`}
      aria-pressed={!a.makeup_ignored}
      title={a.makeup_ignored
        ? `Ignored for make-ups (all students)${title ? `: ${title}` : ''}. Click to track it again.`
        : `Students who miss ${title ? `"${title}"` : 'this test'} show under Make-up tests. Click to ignore it for all students.`}
      onClick={() => onFlip(a)}
    >
      {label ? `Make-ups (${label})` : 'Make-ups'}: {a.makeup_ignored ? 'ignored' : 'tracked'}
    </button>
  );
}

// Summative / Formative / Unpublished toggles over `filter` (see
// lib/assessmentTypeFilter.js). Full size on the Assessments tab; `compact` in
// the Course page tab row for the Gradebook, where vertical room is scarce.
export function TypeFilterBar({ assignments, filter, onChange, compact = false }) {
  const counts = typeFilterCounts(assignments, filter);
  const flip = (key) => onChange({ ...filter, [key]: !filter[key] });
  const unpublishedTitle = filter.unpublished
    ? 'Hide assessments that are not published on Schoology'
    : 'Show assessments that are not published on Schoology';
  return (
    <div
      role="group" aria-label="Filter assessments"
      className={compact ? 'type-filter-bar type-filter-bar--compact' : 'type-filter-bar'}
    >
      {!compact && <span className="text-sm text-muted" style={{ marginRight: '0.25rem' }}>Show:</span>}
      <TypeFilterToggle
        label="Summative" count={counts.summative} type="summative" compact={compact}
        active={filter.summative} onClick={() => flip('summative')}
      />
      <TypeFilterToggle
        label="Formative" count={counts.formative} type="formative" compact={compact}
        active={filter.formative} onClick={() => flip('formative')}
      />
      {counts.unpublished > 0 && (
        <TypeFilterToggle
          label="Unpublished" count={counts.unpublished} type="unpublished" compact={compact}
          title={unpublishedTitle} active={filter.unpublished} onClick={() => flip('unpublished')}
        />
      )}
    </div>
  );
}

// onToggleMakeUp(assignment) (live courses only) flips make-up tracking for a
// Schoology test/quiz; its chip shows "Make-ups: tracked / ignored".
// onSetPublished(assignment, 0|1) (live courses only) publishes or unpublishes
// it on Schoology (#138), after a confirm under the row.
export function AssessmentsView({ data, courseId, waits = {}, feedbackLimit = 10, onToggleMakeUp, onSetPublished }) {
  const [filter, setFilter] = useState(DEFAULT_TYPE_FILTER);
  const [makeUpError, setMakeUpError] = useState(null);
  // The row whose publish confirm is open ({ id, published }), and the last result.
  const [publishAsk, setPublishAsk] = useState(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishDone, setPublishDone] = useState(null);
  const [publishError, setPublishError] = useState(null);
  // Combined tests (linked quizzes): member tests fold under the canonical row.
  const [quizGroups, setQuizGroups] = useState([]);
  useEffect(() => {
    let active = true;
    // Promise.resolve().then: a test's api mock without getQuizGroups must not crash the list.
    Promise.resolve().then(() => getQuizGroups(courseId))
      .then(r => { if (active) setQuizGroups(r?.groups || []); })
      .catch(() => {});
    return () => { active = false; };
  }, [courseId]);
  const groupByCanonical = new Map(quizGroups.map(g => [String(g.canonical_schoology_id), g]));
  const foldedIds = new Set(quizGroups.flatMap(g => g.members.map(m => String(m.schoology_assignment_id)))
    .filter(sid => !groupByCanonical.has(sid)));

  // A canonical row's member tests, in group order (the canonical one included when it is a member).
  const assignmentBySid = new Map((data?.assignments || []).map(x => [String(x.schoology_assignment_id), x]));
  const memberTests = (a) => {
    const g = groupByCanonical.get(String(a.schoology_assignment_id));
    if (!g) return null;
    return g.members
      .map(m => assignmentBySid.get(String(m.schoology_assignment_id)))
      .filter(m => m && m.is_test === 1);
  };
  // A result task is often left unpublished until grades go out; its row still shows by
  // default while any of its tests is published, so the folded tests do not vanish with it.
  const forFilter = (a) => (isUnpublished(a) && memberTests(a)?.some(m => !isUnpublished(m)) ? { ...a, published: 1 } : a);

  async function flipMakeUp(a) {
    try {
      await onToggleMakeUp(a);
      setMakeUpError(null);
    } catch (err) {
      setMakeUpError(`Couldn't change make-up tracking for "${a.title}": ${err.message}`);
    }
  }

  async function confirmPublish(a, published) {
    setPublishBusy(true);
    try {
      const r = await onSetPublished(a, published);
      setPublishError(null);
      setPublishDone({ id: a.id, published: r?.published ?? published });
      setTimeout(() => setPublishDone((d) => (d?.id === a.id ? null : d)), 5000);
    } catch (err) {
      setPublishError(`Couldn't ${published ? 'publish' : 'unpublish'} "${a.title}": ${err.message}`);
    } finally {
      setPublishBusy(false);
      setPublishAsk(null);
    }
  }

  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, folders } = data;
  const visible = assignments
    .filter(a => !foldedIds.has(String(a.schoology_assignment_id)))
    .filter(a => passesTypeFilter(forFilter(a), filter));
  const groups = groupAssignmentsByFolder(visible, folders);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--border)' }}>
        <TypeFilterBar assignments={assignments} filter={filter} onChange={setFilter} />
      </div>
      {makeUpError && <div className="alert alert-warning" style={{ margin: '0.75rem 1.25rem' }}>{makeUpError}</div>}
      {publishError && <div className="alert alert-warning" style={{ margin: '0.75rem 1.25rem' }}>{publishError}</div>}

      {groups.length === 0 ? (
        <p className="text-sm text-muted" style={{ padding: '1rem 1.25rem' }}>
          No assessments match the current filters.
        </p>
      ) : (
        groups.map(group => (
          <div key={group.folderId ?? '__none__'}>
            <div style={{
              padding: '0.45rem 1.25rem',
              background: 'var(--accent-subtle)',
              color: 'var(--accent)',
              fontWeight: 700, fontSize: '0.78rem',
              borderBottom: '1px solid var(--border)',
            }}>
              {group.title || 'Ungrouped'}
            </div>
            {group.assignments.map(a => {
              const isSummative = !!a.aligned;
              const unpublished = isUnpublished(a);
              return (
                <div
                  key={a.id}
                  className="assessment-row"
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap',
                    padding: '0.55rem 1.25rem',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span
                    className={`badge ${isSummative ? 'badge-summative' : 'badge-formative'}`}
                    style={{ fontSize: '0.62rem', flexShrink: 0 }}
                    title={isSummative ? 'Summative' : 'Formative'}
                  >
                    {isSummative ? 'S' : 'F'}
                  </span>
                  {/* Title + its outbound Schoology link travel together (#76);
                      the group flexes so the due date stays right-aligned. */}
                  {/* The row wraps its chips to a second line before the title gets narrower than this. */}
                  <span style={{ flex: '1 1 20rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', minWidth: 'min(100%, 20rem)', flexWrap: 'wrap' }}>
                    <Link
                      to={`/course/${courseId}/assessment/${a.schoology_assignment_id}`}
                      className="link"
                      style={unpublished ? { color: 'var(--text-muted)', fontStyle: 'italic' } : undefined}
                    >
                      {a.title}
                    </Link>
                    <SchoologyLink url={a.web_url} ariaLabel={`View "${a.title}" in Schoology`} />
                    <QuizChip group={groupByCanonical.get(String(a.schoology_assignment_id))} />
                    {unpublished && (
                      <span className="badge badge-gray" style={{ fontSize: '0.62rem', flexShrink: 0 }} title="Not published on Schoology">
                        Unpublished
                      </span>
                    )}
                    {/* #138: Publish where it is needed; Unpublish stays quiet until hover or focus. */}
                    {onSetPublished && (
                      <button
                        type="button"
                        className={`publish-btn${unpublished ? '' : ' publish-btn--quiet'}`}
                        aria-expanded={publishAsk?.id === a.id}
                        onClick={() => setPublishAsk(publishAsk?.id === a.id ? null : { id: a.id, published: unpublished ? 1 : 0 })}
                      >
                        {unpublished ? 'Publish' : 'Unpublish'}
                      </button>
                    )}
                  </span>
                  {/* Folded member tests have no row of their own, so their make-up tracking shows here,
                      labelled by place in the group (the full title is in the chip's hover text). */}
                  {onToggleMakeUp && (() => {
                    const tests = memberTests(a);
                    if (!tests) return a.is_test === 1 && <MakeUpChip a={a} onFlip={flipMakeUp} />;
                    return (
                      <span style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
                        {tests.map((m, i) => (
                          <MakeUpChip key={m.id} a={m} onFlip={flipMakeUp} label={tests.length > 1 ? `Test ${i + 1}` : null} title={m.title} />
                        ))}
                      </span>
                    );
                  })()}
                  {waits[a.schoology_assignment_id] && (() => {
                    const w = waits[a.schoology_assignment_id];
                    return (
                      <span className="triage-wait" title={`Oldest wait: ${w.day - 1} school days since the due date (or a late submission); overdue at ${feedbackLimit}`}>
                        <UrgencyRing day={w.day} limit={feedbackLimit} tone={w.tone} approx={w.approx} />
                        <span className="text-sm">{w.owed}/{w.submittedTotal} ungraded</span>
                      </span>
                    );
                  })()}
                  {a.due_date && (
                    <span className="text-sm text-muted" style={{ flexShrink: 0 }}>
                      Due {a.due_date}
                    </span>
                  )}
                  {publishAsk?.id === a.id && (
                    <PublishConfirm title={a.title} published={publishAsk.published} busy={publishBusy}
                      onConfirm={() => confirmPublish(a, publishAsk.published)} onCancel={() => setPublishAsk(null)} />
                  )}
                  {publishDone?.id === a.id && <PublishDone published={publishDone.published} />}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
