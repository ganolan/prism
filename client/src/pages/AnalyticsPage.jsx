import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getCourse } from '../services/api.js';
import AnalyticsView from '../components/AnalyticsView.jsx';

export default function AnalyticsPage() {
  const { id } = useParams();
  const [course, setCourse] = useState(null);

  useEffect(() => {
    getCourse(id).then(setCourse).catch(console.error);
  }, [id]);

  if (!course) return <div className="loading">Loading...</div>;

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>{course.course_name} — Analytics</h2>
        <Link to={`/course/${id}`} className="link text-sm">Back to roster</Link>
      </div>
      <AnalyticsView id={id} />
    </div>
  );
}
