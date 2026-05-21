import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse, getCourseStudents, getGradebook, getMasteryForCourse, triggerMasterySync, triggerMasteryLogin } from '../services/api.js';
import AnalyticsView from '../components/AnalyticsView.jsx';
import OverridePopup, { LEVEL_COLORS } from '../components/OverridePopup.jsx';
import { computeLetterGrade, LetterGradePopup, LETTER_GRADE_COLORS } from '../components/MasteryPerformanceSummary.jsx';
import { gradeLabel, submissionStatus } from '../lib/gradeLabel.js';
import { masteryCodeForLevel } from '../lib/masteryLevels.js';
import { groupAssignmentsByFolder } from '../lib/assessmentGroups.js';
import { indexMastery, buildAssignmentRubric } from '../lib/gradebookMastery.js';
import CompactRubric from '../components/CompactRubric.jsx';

const SHORT_BADGE = { late: 'L', draft: 'D', missing: 'M', 'not-started': 'NS', submitted: 'S' };

function pointsToLevel(points) {
  if (points == null) return null;
  if (points >= 87.5) return 'ED';
  if (points >= 62.5) return 'EX';
  if (points >= 37.5) return 'D';
  if (points >= 12.5) return 'EM';
  return 'IE';
}

export default function CoursePage() {
  const { id } = useParams();
  const [course, setCourse] = useState(null);
  const [students, setStudents] = useState([]);
  const [gradebook, setGradebook] = useState(null);
  const [mastery, setMastery] = useState(null);
  const [view, setView] = useState('roster');
  const [loading, setLoading] = useState(true);
  const [masterySyncing, setMasterySyncing] = useState(false);
  const [masterySyncResult, setMasterySyncResult] = useState(null);
  const [overrideTarget, setOverrideTarget] = useState(null); // { studentUid, category, currentLevel, hasOverride }
  const [overrideSaving, setOverrideSaving] = useState(false);

  useEffect(() => {
    Promise.all([getCourse(id), getCourseStudents(id), getGradebook(id), getMasteryForCourse(id).catch(() => null)])
      .then(([c, s, g, m]) => { setCourse(c); setStudents(s); setGradebook(g); setMastery(m); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  async function refreshMastery() {
    const m = await getMasteryForCourse(id).catch(() => null);
    setMastery(m);
  }

  async function handleMasterySync() {
    setMasterySyncing(true);
    setMasterySyncResult(null);
    try {
      const result = await triggerMasterySync(id);
      setMasterySyncResult({ success: true, ...result });
    } catch (err) {
      const needsLogin = err.message?.includes('Not logged in') || err.message?.includes('mastery:login');
      setMasterySyncResult({ success: false, error: err.message, needsLogin });
    } finally {
      setMasterySyncing(false);
    }
  }

  async function handleMasteryLogin() {
    setMasterySyncResult({ success: false, error: 'Opening login browser... Log in to Schoology, then close the browser window.', needsLogin: false });
    try {
      await triggerMasteryLogin();
      setMasterySyncResult({ success: true, error: null, message: 'Login saved. Click Sync Mastery to pull data.' });
    } catch (err) {
      setMasterySyncResult({ success: false, error: `Login failed: ${err.message}` });
    }
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (!course) return <div className="error-msg">Course not found</div>;

  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;

  return (
    <div className="fade-in">
      <h2 className="page-title">{course.course_name}</h2>
      {course.section_name && <p className="subtitle">{course.section_name}</p>}
      <p className="text-sm text-muted mb-2">
        {course.studentCount} students
        {course.section_school_code && <span style={{ marginLeft: '0.75rem' }}>{course.section_school_code}</span>}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
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

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {masterySyncResult && (
            <span className="text-sm" style={{ color: masterySyncResult.success ? 'var(--success)' : 'var(--danger)', maxWidth: 400 }}>
              {masterySyncResult.success
                ? (masterySyncResult.message || `Synced ${masterySyncResult.categoriesCount} categories, ${masterySyncResult.topicsCount} topics, ${masterySyncResult.scoresCount} scores`)
                : masterySyncResult.error}
            </span>
          )}
          {masterySyncResult?.needsLogin && (
            <button className="primary" onClick={handleMasteryLogin} style={{ whiteSpace: 'nowrap' }}>
              Log in to Schoology
            </button>
          )}
          <button
            className="secondary"
            onClick={handleMasterySync}
            disabled={masterySyncing}
            title="Sync mastery (SBG) data from Schoology for this course"
            style={{ whiteSpace: 'nowrap' }}
          >
            {masterySyncing ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                Syncing Mastery…
              </span>
            ) : 'Sync Mastery'}
          </button>
        </div>
      </div>

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
      {view === 'gradebook' && <GradebookView data={gradebook} courseId={id} mastery={mastery} />}
      {view === 'assessments' && <AssessmentsView data={gradebook} courseId={id} />}
      {view === 'analytics' && <AnalyticsView id={id} />}
    </div>
  );
}

// ─── Roster view ────────────────────────────────────────────────────────────

function levelCellStyle(level, extra = {}) {
  const c = level ? LEVEL_COLORS[level] : null;
  return {
    background: c ? c.bg : 'var(--bg-subtle)',
    color: c ? c.text : 'var(--text-muted)',
    textAlign: 'center',
    fontWeight: 700,
    fontSize: '0.82rem',
    padding: '0.5rem 0.4rem',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    ...extra,
  };
}

function RosterView({ students, mastery, courseId, displayName, onOverrideClick }) {
  const [showGradeScale, setShowGradeScale] = useState(false);
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

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          {/* Row 1: category group headers — use full title to match mastery summary */}
          <tr>
            <th rowSpan={2}></th>
            <th rowSpan={2}>Name</th>
            <th rowSpan={2}>Email</th>
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
          {students.map(s => {
            const uid = s.schoology_uid || s.uid;
            // Per-student approximate letter grade using the same formula as
            // MasteryPerformanceSummary: pointsToLevel(flat category average)
            // for each reporting category → computeLetterGrade().
            const categoryLevels = categories.map(cat => {
              const avg = categoryAvg(uid, cat.id);
              return avg != null ? pointsToLevel(avg) : null;
            });
            const letterGrade = computeLetterGrade(categoryLevels);
            return (
              <tr key={s.id}>
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
                </td>
                <td className="text-sm">{s.email || '-'}</td>
                {categories.flatMap((cat, catIdx) => {
                  const avg = categoryAvg(uid, cat.id);
                  const avgLevel = avg != null ? pointsToLevel(avg) : null;
                  const r = schoologyRollup(uid, cat.id);
                  const rVal = r ? (r.override_value != null ? r.override_value : r.grade_scaled_rounded) : null;
                  const rLevel = rVal != null ? pointsToLevel(rVal) : null;
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
                      {avgLevel || '—'}{avg != null ? ` (${Math.round(avg)})` : ''}
                    </td>,
                    <td
                      key={`${cat.id}-s`}
                      className="schoology-cell"
                      onClick={() => onOverrideClick(uid, cat, rLevel, hasOverride)}
                      title={mismatchTitle || (hasOverride
                        ? `Schoology reported: ${rLevel} — override set (click to change or clear)`
                        : `Schoology reported${rLevel ? `: ${rLevel}` : ': no data'} (click to set override)`)}
                      style={levelCellStyle(rLevel, {
                        cursor: 'pointer',
                        borderLeft: '2px solid var(--accent)',
                        ...mismatchBorders,
                      })}
                    >
                      {rLevel || '—'}{r?.grade_percentage != null ? ` (${Math.round(r.grade_percentage)})` : ''}{hasOverride ? '*' : ''}
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
                    : 'Not enough data — at least one reporting category is missing a computed level'}>
                    {letterGrade || '—'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {categories.length === 0 && (
        <p className="text-sm text-muted" style={{ padding: '0.75rem' }}>
          No mastery data yet. Click <strong>Sync Mastery</strong> above to pull reporting categories from Schoology.
        </p>
      )}
      {categories.length > 0 && (
        <p className="text-sm text-muted" style={{ padding: '0.5rem 0.75rem', marginTop: '0.25rem', borderTop: '1px solid var(--border)', fontSize: '0.72rem' }}>
          Cells with an <span style={{ padding: '0 0.3rem', borderTop: '2px solid rgba(234, 179, 8, 0.85)', borderBottom: '2px solid rgba(234, 179, 8, 0.85)' }}>amber border</span> show a mismatch between Prism's computed average and Schoology's reported level. The <strong style={{ color: 'var(--accent)' }}>Schoology</strong> column (accent-bordered) is the authoritative data — click any cell to set an override.
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
            style={{ flex: 1, background: c ? c.bg : 'var(--bg-subtle)' }}
          />
        );
      })}
    </button>
  );
}

// Modal opened from a MiniRubricStrip — the full rubric grid (shared
// CompactRubric) plus the overall comment, matching the /student/ page.
function RubricModal({ student, assignment, courseId, topics, comment, onClose }) {
  const name = student.preferred_name_teacher || student.preferred_name || student.first_name;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--card-bg)', borderRadius: 12,
          maxWidth: 560, width: '100%', maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '0.85rem 1.1rem', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>{name} {student.last_name}</div>
            <div className="text-sm text-muted" style={{ marginTop: 2 }}>
              {assignment.title}
              <span className="badge badge-summative" style={{ fontSize: '0.6rem', marginLeft: 6 }}>S</span>
            </div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '1rem 1.1rem' }}>
          <CompactRubric topics={topics} />
          {comment && (
            <div
              className="text-sm"
              style={{
                marginTop: '0.85rem', background: 'var(--bg-subtle)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '0.6rem 0.75rem',
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 5 }}>Comment:</span>{comment}
            </div>
          )}
        </div>
        <div style={{ padding: '0 1.1rem 1rem' }}>
          <Link
            to={`/course/${courseId}/assessment/${assignment.schoology_assignment_id}`}
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

function GradebookView({ data, courseId, mastery }) {
  const indexed = useMemo(() => indexMastery(mastery), [mastery]);
  const [rubricModal, setRubricModal] = useState(null);

  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, students, grades, grading_scales } = data;
  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;

  return (
    <>
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'var(--table-header-bg)', zIndex: 1, verticalAlign: 'bottom' }}>Student</th>
            {assignments.map(a => {
              const isSummative = !!a.aligned;
              return (
                <th key={a.id} style={{ minWidth: 30, padding: '0.5rem 0.15rem 0.4rem', verticalAlign: 'bottom' }}>
                  {/* Vertical title so long names are never clipped; title links
                      to its grading page (#37). Badge sits at the bottom, next
                      to the data cells. The redundant trailing (F)/(S) is
                      dropped since the badge already conveys the type. */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                    <Link
                      to={`/course/${courseId}/assessment/${a.schoology_assignment_id}`}
                      className="link"
                      title={a.title}
                      style={{
                        writingMode: 'vertical-rl',
                        whiteSpace: 'nowrap',
                        fontWeight: 500,
                      }}
                    >
                      {a.title.replace(/\s*\((?:F|S)\)\s*$/i, '')}
                    </Link>
                    <span
                      className={`badge ${isSummative ? 'badge-summative' : 'badge-formative'}`}
                      style={{ fontSize: '0.6rem' }}
                      title={isSummative ? 'Summative' : 'Formative'}
                    >
                      {isSummative ? 'S' : 'F'}
                    </span>
                  </div>
                </th>
              );
            })}
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
                    <td key={a.id} style={{ textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-subtle)' }} title="Not assigned to this student">—</td>
                  );
                }
                const g = grades[s.id]?.[a.id];
                if (!g) {
                  // No grade row exists — student is enrolled but Schoology has
                  // recorded no activity for this assignment. Past-due → Missing.
                  const empty = submissionStatus({
                    score: null, exception: 0, late: 0, draft: 0,
                    submitted_at: 0, due_date: a.due_date,
                  });
                  if (!empty.length) return <td key={a.id} style={{ textAlign: 'center' }}>—</td>;
                  return (
                    <td key={a.id} style={{ textAlign: 'center', whiteSpace: 'nowrap' }} title="Past due — student has not opened or submitted">
                      <span className="badge badge-red" style={{ fontSize: '0.55rem' }}>M</span>
                      <span className="badge badge-pink" style={{ fontSize: '0.55rem', marginLeft: 3 }}>NS</span>
                    </td>
                  );
                }
                // Aligned summatives show a mini rubric strip of the student's
                // per-topic proficiency instead of a numeric score (#32).
                // Rubric-locking exceptions (Excused/Incomplete/Missing) delete
                // the scores in Schoology, so those cells keep the badge below.
                const isRubricLocked = g.exception === 1 || g.exception === 2 || g.exception === 3;
                const rubricTopics = (a.aligned && !isRubricLocked)
                  ? buildAssignmentRubric(a.schoology_assignment_id, s.schoology_uid, indexed)
                  : [];
                const showStrip = rubricTopics.length > 0;

                // Non-aligned cells (and aligned cells with no rubric data
                // available) keep the scale-aware / numeric label.
                const lbl = a.aligned
                  ? gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: null, scales: null })
                  : gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: a.grading_scale_id, scales: grading_scales });
                // For General Academic-family levels, shorten to ED/EX/D/EM/IE
                // and apply the same color coding used in the aligned rubric.
                const code = lbl.kind === 'scale' ? masteryCodeForLevel(lbl.text) : null;
                const c = code ? LEVEL_COLORS[code] : null;
                const text = lbl.kind === 'pending' ? '—' : (code || lbl.text);
                const cellStyle = {
                  textAlign: 'center',
                  ...(lbl.kind === 'mismatch' && { color: 'var(--danger)' }),
                  ...(g.resubmit_requested && { background: 'var(--badge-resubmit-bg)' }),
                  ...(g.resubmitted && { boxShadow: 'inset 0 0 0 2px var(--resubmit-ring)' }),
                };
                const inner = showStrip
                  ? <MiniRubricStrip
                      topics={rubricTopics}
                      onClick={() => setRubricModal({
                        student: s, assignment: a, topics: rubricTopics,
                        comment: g.grade_comment || '',
                      })}
                    />
                  : (c
                      ? <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block', minWidth: 24 }}>{text}</span>
                      : text);
                const status = submissionStatus({
                  score: g.score, exception: g.exception, late: g.late, draft: g.draft,
                  submitted_at: g.submitted_at, due_date: a.due_date,
                });
                // Don't double up exception text — gradeLabel already shows it.
                const inlineBadges = status.filter(b => b.kind !== 'exception');
                // Tooltip names whichever resubmission signals apply, falling
                // back to the mismatch warning or the grade comment.
                const signalTitle = [
                  g.resubmit_requested ? 'Re-submit requested' : null,
                  g.resubmitted ? 'Resubmitted since last graded' : null,
                ].filter(Boolean).join(' · ');
                const cellTitle = signalTitle
                  || (lbl.kind === 'mismatch'
                      ? 'Score does not match any defined level on this grading scale — check Schoology'
                      : (g.grade_comment || ''));
                return (
                  <td key={a.id} style={cellStyle} title={cellTitle}>
                    {inner}
                    {inlineBadges.map(b => (
                      <span key={b.kind} className={`badge ${b.tone === 'red' ? 'badge-red' : b.tone === 'blue' ? 'badge-blue' : 'badge-pink'}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                        {SHORT_BADGE[b.kind] || b.label[0]}
                      </span>
                    ))}
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
        student={rubricModal.student}
        assignment={rubricModal.assignment}
        courseId={courseId}
        topics={rubricModal.topics}
        comment={rubricModal.comment}
        onClose={() => setRubricModal(null)}
      />
    )}
    </>
  );
}

// ─── Assessments view ────────────────────────────────────────────────────────

// Show/hide toggle for an assignment type. Filled in the type's colour while
// showing, greyed out while hidden (#22).
function TypeFilterToggle({ label, count, active, type, onClick }) {
  const colorStyle = active
    ? {
        background: `var(--${type}-bg)`,
        color: `var(--${type}-text)`,
        boxShadow: `inset 0 0 0 1px var(--${type}-border)`,
      }
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
      title={active ? `Hide ${label.toLowerCase()} assessments` : `Show ${label.toLowerCase()} assessments`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.3rem 0.7rem', borderRadius: 999, border: 'none',
        cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
        transition: 'opacity 0.12s, background 0.12s',
        ...colorStyle,
      }}
    >
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: 'currentColor', opacity: active ? 1 : 0.5,
      }} />
      {label}
      <span style={{ fontWeight: 700, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

function AssessmentsView({ data, courseId }) {
  const [showSummative, setShowSummative] = useState(true);
  const [showFormative, setShowFormative] = useState(true);

  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, folders } = data;
  const summativeCount = assignments.filter(a => a.aligned).length;
  const formativeCount = assignments.length - summativeCount;

  const visible = assignments.filter(a => (a.aligned ? showSummative : showFormative));
  const groups = groupAssignmentsByFolder(visible, folders);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
        padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--border)',
      }}>
        <span className="text-sm text-muted" style={{ marginRight: '0.25rem' }}>Show:</span>
        <TypeFilterToggle
          label="Summative" count={summativeCount} type="summative"
          active={showSummative} onClick={() => setShowSummative(v => !v)}
        />
        <TypeFilterToggle
          label="Formative" count={formativeCount} type="formative"
          active={showFormative} onClick={() => setShowFormative(v => !v)}
        />
      </div>

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
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.6rem',
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
                  <Link
                    to={`/course/${courseId}/assessment/${a.schoology_assignment_id}`}
                    className="link"
                    style={{ flex: 1 }}
                  >
                    {a.title}
                  </Link>
                  {a.due_date && (
                    <span className="text-sm text-muted" style={{ flexShrink: 0 }}>
                      Due {a.due_date}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
