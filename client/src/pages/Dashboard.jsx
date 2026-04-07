import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, importCourse } from '../services/api.js';

// Derive academic year and semester from Schoology grading_period title string.
// Examples:
//   "2025-2026: 08/14/2025 - 06/17/2026"  → { academicYear: '2025-26', semester: 'Full Year' }
//   "Semester 1: 08/14/2025 - 01/11/2026" → { academicYear: '2025-26', semester: 'Semester 1' }
//   "Semester 2: 01/12/2026 - 06/17/2026" → { academicYear: '2025-26', semester: 'Semester 2' }
function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };

  let semester = 'Full Year';
  if (gradingPeriod.includes('Semester 1')) semester = 'Semester 1';
  else if (gradingPeriod.includes('Semester 2')) semester = 'Semester 2';

  // Extract the first date in MM/DD/YYYY format
  const dateMatch = gradingPeriod.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateMatch) return { academicYear: 'Unknown', semester };

  const month = parseInt(dateMatch[1], 10);
  const year = parseInt(dateMatch[3], 10);
  // Aug–Dec: this calendar year starts the academic year
  // Jan–Jul: the previous calendar year started the academic year
  const startYear = month >= 8 ? year : year - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(-2)}`;

  return { academicYear, semester };
}

function groupByAcademicYear(courses) {
  const groups = {};
  for (const c of courses) {
    const { academicYear } = parseGradingPeriod(c.grading_period);
    if (!groups[academicYear]) groups[academicYear] = [];
    groups[academicYear].push(c);
  }
  // Sort year keys descending (e.g. "2025-26" before "2024-25")
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearCourses]) => ({ year, courses: yearCourses }));
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('current');
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [allCourses, setAllCourses] = useState([]);
  const [importId, setImportId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);

  function reload() {
    Promise.all([getCoursesByView(activeTab), getSyncStatus()])
      .then(([c, s]) => { setCourses(c); setSyncStatus(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  function loadAllCourses() {
    getCourses(true, true).then(setAllCourses).catch(console.error);
  }

  useEffect(() => {
    setImportError(null);
    setImportSuccess(null);
    reload();
  }, [activeTab]);

  async function handleToggleVisibility(courseId) {
    await toggleCourseVisibility(courseId);
    loadAllCourses();
    reload();
  }

  function openEditMode() {
    setEditMode(true);
    loadAllCourses();
  }

  async function handleImport(e) {
    e.preventDefault();
    const sid = importId.trim();
    if (!sid) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importCourse(sid);
      setImportSuccess(result);
      setImportId('');
      reload();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  const yearGroups = groupByAcademicYear(courses);

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        <button className="secondary" onClick={openEditMode}>Show/Hide Courses</button>
      </div>

      {/* Sync status */}
      {syncStatus?.last && (
        <p className="text-sm text-muted mb-2">
          Last sync: {new Date(syncStatus.last.completed_at || syncStatus.last.started_at).toLocaleString()}
          {' — '}{syncStatus.last.status}
          {syncStatus.last.records_synced ? ` (${syncStatus.last.records_synced} records)` : ''}
        </p>
      )}

      {/* Tab toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <button
          className={activeTab === 'current' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setActiveTab('current')}
        >
          Current
        </button>
        <button
          className={activeTab === 'archived' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setActiveTab('archived')}
        >
          Archived
        </button>
      </div>

      {/* Current tab */}
      {activeTab === 'current' && (
        courses.length === 0 ? (
          <div className="card empty-state">
            <p>No courses synced yet. Click <strong>Sync Schoology</strong> in the sidebar to pull your courses.</p>
          </div>
        ) : (
          <div className="grid-2">
            {courses.map(c => (
              <Link to={`/course/${c.id}`} key={c.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
                    {c.section_name && <p className="text-sm text-muted">{c.section_name}</p>}
                  </div>
                </div>
                {c.synced_at && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>
                    Synced {new Date(c.synced_at).toLocaleDateString()}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )
      )}

      {/* Archived tab */}
      {activeTab === 'archived' && (
        <div>
          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses yet. Use the form below to add a past course.</p>
            </div>
          ) : (
            yearGroups.map(({ year, courses: groupCourses }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{
                  marginBottom: '0.75rem',
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                  fontSize: '0.85rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}>
                  {year}
                </h3>
                <div className="grid-2">
                  {groupCourses.map(c => {
                    const { semester } = parseGradingPeriod(c.grading_period);
                    return (
                      <Link to={`/course/${c.id}`} key={c.id} className="card" style={{ opacity: 0.75 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
                            {c.section_name && <p className="text-sm text-muted">{c.section_name}</p>}
                          </div>
                          <span className="badge badge-gray">{semester}</span>
                        </div>
                        {c.grading_period && (
                          <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>{c.grading_period}</p>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          {/* Add past course form */}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.25rem' }}>Add a past course</h3>
            <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
              Find the section ID in the Schoology URL:{' '}
              <code>schoology.hkis.edu.hk/course/<strong>[ID]</strong>/materials</code>
            </p>
            {importSuccess && (
              <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
                Imported <strong>{importSuccess.course.course_name}</strong> — {importSuccess.studentsCount} students, {importSuccess.assignmentsCount} assignments
              </div>
            )}
            {importError && (
              <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>{importError}</div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label className="text-sm" style={{ display: 'block', marginBottom: '0.25rem' }}>Section ID</label>
                <input
                  type="text"
                  value={importId}
                  onChange={e => setImportId(e.target.value)}
                  placeholder="e.g. 7899907695"
                  style={{ width: '100%' }}
                  disabled={importing}
                />
              </div>
              <button
                className="primary"
                onClick={handleImport}
                disabled={importing || !importId.trim()}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Show/Hide Courses Modal */}
      {editMode && (
        <div className="modal-overlay" onClick={() => setEditMode(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Show/Hide Courses</h3>
              <button className="ghost" onClick={() => setEditMode(false)}>✕</button>
            </div>
            <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
              Hidden courses will not appear on your dashboard. Click to show/hide.
            </p>
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {allCourses.map(c => (
                <div
                  key={c.id}
                  onClick={() => handleToggleVisibility(c.id)}
                  style={{
                    padding: '0.75rem',
                    marginBottom: '0.5rem',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    opacity: c.hidden ? 0.5 : 1,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    transition: 'all 0.2s ease',
                  }}
                  className="hover-lift"
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>{c.course_name}</div>
                    {c.section_name && <div className="text-sm text-muted">{c.section_name}</div>}
                    {(!c.course_code && !c.section_school_code) && (
                      <div className="text-sm text-muted" style={{ fontStyle: 'italic' }}>No course code</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {c.archived ? <span className="badge badge-gray">Past</span> : null}
                    <span className="badge" style={{
                      background: c.hidden ? 'var(--danger-bg)' : 'var(--success-bg)',
                      color: c.hidden ? 'var(--danger)' : 'var(--success)',
                    }}>
                      {c.hidden ? 'Hidden' : 'Visible'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={() => setEditMode(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
