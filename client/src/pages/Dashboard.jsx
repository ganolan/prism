import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getSyncStatus, toggleArchiveCourse } from '../services/api.js';

export default function Dashboard() {
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  function reload() {
    Promise.all([getCourses(showArchived), getSyncStatus()])
      .then(([c, s]) => { setCourses(c); setSyncStatus(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, [showArchived]);

  async function handleArchive(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleArchiveCourse(courseId);
    reload();
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {syncStatus?.last && (
        <p className="text-sm text-muted mb-2">
          Last sync: {new Date(syncStatus.last.completed_at || syncStatus.last.started_at).toLocaleString()}
          {' — '}{syncStatus.last.status}
          {syncStatus.last.records_synced ? ` (${syncStatus.last.records_synced} records)` : ''}
        </p>
      )}

      {courses.length === 0 ? (
        <div className="card">
          <p>No courses synced yet. Click <strong>Sync Schoology</strong> in the sidebar to pull your courses.</p>
        </div>
      ) : (
        <div className="grid-2">
          {courses.map(c => (
            <Link to={`/course/${c.id}`} key={c.id} className="card" style={{ textDecoration: 'none', color: 'inherit', opacity: c.archived ? 0.6 : 1, position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ marginBottom: '0.25rem' }}>{c.course_name}</h3>
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
                style={{ position: 'absolute', bottom: '0.75rem', right: '0.75rem', background: 'none', border: 'none', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                {c.archived ? 'Unarchive' : 'Archive'}
              </button>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
