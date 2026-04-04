import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse, getCourseStudents, getGradebook } from '../services/api.js';

export default function CoursePage() {
  const { id } = useParams();
  const [course, setCourse] = useState(null);
  const [students, setStudents] = useState([]);
  const [gradebook, setGradebook] = useState(null);
  const [view, setView] = useState('roster'); // 'roster' or 'gradebook'
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getCourse(id), getCourseStudents(id), getGradebook(id)])
      .then(([c, s, g]) => { setCourse(c); setStudents(s); setGradebook(g); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!course) return <div className="error-msg">Course not found</div>;

  const displayName = (s) => s.preferred_name || s.first_name;

  return (
    <div>
      <h2 className="page-title">{course.course_name}</h2>
      {course.section_name && <p className="subtitle">{course.section_name}</p>}
      <p className="text-sm text-muted mb-2">{course.studentCount} students</p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button className={view === 'roster' ? 'primary' : ''} onClick={() => setView('roster')}
          style={view !== 'roster' ? { background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' } : undefined}>
          Roster
        </button>
        <button className={view === 'gradebook' ? 'primary' : ''} onClick={() => setView('gradebook')}
          style={view !== 'gradebook' ? { background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' } : undefined}>
          Gradebook
        </button>
        <Link to={`/course/${id}/analytics`} className="primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', background: '#6b7280', color: 'white', padding: '0.5rem 1rem', borderRadius: '6px', fontSize: '0.85rem' }}>
          Analytics
        </Link>
      </div>

      {view === 'roster' ? (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Graded</th>
                <th>Average</th>
              </tr>
            </thead>
            <tbody>
              {students.map(s => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/student/${s.id}`} className="link">
                      {displayName(s)} {s.last_name}
                    </Link>
                    {s.preferred_name && (
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
      ) : (
        <GradebookView data={gradebook} />
      )}
    </div>
  );
}

function GradebookView({ data }) {
  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, students, grades } = data;
  const displayName = (s) => s.preferred_name || s.first_name;

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'white', zIndex: 1 }}>Student</th>
            {assignments.map(a => (
              <th key={a.id} style={{ minWidth: '80px', whiteSpace: 'nowrap' }} title={a.title}>
                {a.title.length > 15 ? a.title.slice(0, 15) + '...' : a.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {students.map(s => (
            <tr key={s.id}>
              <td style={{ position: 'sticky', left: 0, background: 'white', zIndex: 1, whiteSpace: 'nowrap' }}>
                <Link to={`/student/${s.id}`} className="link">
                  {displayName(s)} {s.last_name}
                </Link>
              </td>
              {assignments.map(a => {
                const g = grades[s.id]?.[a.id];
                return (
                  <td key={a.id} style={{ textAlign: 'center' }} title={g?.grade_comment || ''}>
                    {g?.score != null ? g.score : (g?.exception ? 'EX' : '-')}
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
