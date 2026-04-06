import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getSyncStatus, toggleArchiveCourse, toggleCourseVisibility } from '../services/api.js';

export default function Dashboard() {
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [allCourses, setAllCourses] = useState([]);

  function reload() {
    Promise.all([getCourses(showArchived, false), getSyncStatus()])
      .then(([c, s]) => { setCourses(c); setSyncStatus(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  function loadAllCourses() {
    getCourses(true, true)
      .then(setAllCourses)
      .catch(console.error);
  }

  useEffect(() => { reload(); }, [showArchived]);

  async function handleArchive(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleArchiveCourse(courseId);
    reload();
  }

  async function handleToggleVisibility(courseId) {
    await toggleCourseVisibility(courseId);
    loadAllCourses();
    reload();
  }

  function openEditMode() {
    setEditMode(true);
    loadAllCourses();
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button className="secondary" onClick={openEditMode}>
            Edit Courses
          </button>
          <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
      </div>

      {syncStatus?.last && (
        <p className="text-sm text-muted mb-2">
          Last sync: {new Date(syncStatus.last.completed_at || syncStatus.last.started_at).toLocaleString()}
          {' — '}{syncStatus.last.status}
          {syncStatus.last.records_synced ? ` (${syncStatus.last.records_synced} records)` : ''}
        </p>
      )}

      {courses.length === 0 ? (
        <div className="card empty-state">
          <p>No courses synced yet. Click <strong>Sync Schoology</strong> in the sidebar to pull your courses.</p>
        </div>
      ) : (
        <div className="grid-2">
          {courses.map(c => (
            <Link to={`/course/${c.id}`} key={c.id} className="card" style={{ opacity: c.archived ? 0.6 : 1, position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
                  {c.section_name && <p className="text-sm text-muted">{c.section_name}</p>}
                </div>
                {c.archived && <span className="badge badge-gray">Archived</span>}
              </div>
              {c.synced_at && (
                <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>
                  Synced {new Date(c.synced_at).toLocaleDateString()}
                </p>
              )}
              <button
                onClick={(e) => handleArchive(e, c.id)}
                className="ghost accent"
                style={{ position: 'absolute', bottom: '0.75rem', right: '0.75rem', fontSize: '0.75rem' }}
              >
                {c.archived ? 'Unarchive' : 'Archive'}
              </button>
            </Link>
          ))}
        </div>
      )}

      {/* Edit Courses Modal */}
      {editMode && (
        <div className="modal-overlay" onClick={() => setEditMode(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Manage Course Visibility</h3>
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
                      <div className="text-sm text-muted" style={{ fontStyle: 'italic' }}>
                        No course code
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {c.archived && <span className="badge badge-gray">Archived</span>}
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
