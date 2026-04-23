import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse, getCourseStudents, getGradebook, getMasteryForCourse, triggerMasterySync, triggerMasteryLogin } from '../services/api.js';
import AnalyticsView from '../components/AnalyticsView.jsx';
import OverridePopup, { LEVEL_COLORS } from '../components/OverridePopup.jsx';

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
      {view === 'gradebook' && <GradebookView data={gradebook} />}
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
    </div>
  );
}

const EXCEPTION_LABELS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing', 4: 'Late' };

function GradebookView({ data }) {
  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, students, grades } = data;
  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;
  const SUMMATIVE_SCALE_ID = '21337256';

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'var(--table-header-bg)', zIndex: 1 }}>Student</th>
            {assignments.map(a => {
              const isSummative = a.grading_scale_id === SUMMATIVE_SCALE_ID;
              const typeLabel = a.grading_scale_id ? (isSummative ? 'S' : 'F') : null;
              return (
                <th key={a.id} style={{ minWidth: '80px', whiteSpace: 'nowrap' }} title={a.title}>
                  {typeLabel && <span className={`badge ${isSummative ? 'badge-blue' : 'badge-green'}`} style={{ fontSize: '0.6rem', marginRight: 4 }}>{typeLabel}</span>}
                  {a.title.length > 15 ? a.title.slice(0, 15) + '…' : a.title}
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
                const g = grades[s.id]?.[a.id];
                const exLabel = g?.exception ? EXCEPTION_LABELS[g.exception] : null;
                return (
                  <td key={a.id} style={{ textAlign: 'center' }} title={g?.grade_comment || ''}>
                    {g?.score != null ? (
                      <span>
                        {g.score}
                        {g.late ? <span className="badge badge-red" style={{ fontSize: '0.55rem', marginLeft: 3 }}>L</span> : null}
                      </span>
                    ) : exLabel ? (
                      <span className={`badge ${g.exception === 3 ? 'badge-red' : 'badge-blue'}`} style={{ fontSize: '0.6rem' }}>
                        {exLabel}
                      </span>
                    ) : '-'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
