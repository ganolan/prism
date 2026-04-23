import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse, getCourseStudents, getGradebook, triggerMasterySync, triggerMasteryLogin } from '../services/api.js';
import AnalyticsView from '../components/AnalyticsView.jsx';

export default function CoursePage() {
  const { id } = useParams();
  const [course, setCourse] = useState(null);
  const [students, setStudents] = useState([]);
  const [gradebook, setGradebook] = useState(null);
  const [view, setView] = useState('roster');
  const [loading, setLoading] = useState(true);
  const [masterySyncing, setMasterySyncing] = useState(false);
  const [masterySyncResult, setMasterySyncResult] = useState(null);

  useEffect(() => {
    Promise.all([getCourse(id), getCourseStudents(id), getGradebook(id)])
      .then(([c, s, g]) => { setCourse(c); setStudents(s); setGradebook(g); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

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
        <div className="card">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Email</th>
                <th>Graded</th>
                <th>Average</th>
              </tr>
            </thead>
            <tbody>
              {students.map(s => (
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
                  <td>{s.graded_count}</td>
                  <td>
                    {s.avg_pct != null ? (
                      <span className={`badge ${s.avg_pct >= 70 ? 'badge-green' : s.avg_pct >= 50 ? 'badge-blue' : 'badge-red'}`}>
                        {s.avg_pct}%
                      </span>
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'gradebook' && <GradebookView data={gradebook} />}
      {view === 'analytics' && <AnalyticsView id={id} />}
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
