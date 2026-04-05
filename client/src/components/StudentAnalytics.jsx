import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';
import { getStudentAnalytics } from '../services/api.js';

const COLORS = ['#7c3aed', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

export default function StudentAnalytics({ studentId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStudentAnalytics(studentId)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [studentId]);

  if (loading) return <div className="text-sm text-muted" style={{ padding: '0.5rem' }}>Loading analytics...</div>;
  if (!data) return null;

  const { trends, crossCourse, alerts } = data;
  const courseIds = Object.keys(trends);

  if (courseIds.length === 0) return null;

  return (
    <>
      {/* Performance alerts */}
      {alerts.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>Performance Alerts</h3>
          <p className="text-sm text-muted mb-1">Changes of {data.threshold}% or more between consecutive assignments:</p>
          {alerts.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0' }}>
              <span className={`badge ${a.direction === 'decline' ? 'badge-red' : 'badge-green'}`}>
                {a.change > 0 ? '+' : ''}{a.change}%
              </span>
              <span className="text-sm">
                {a.course_name}: {a.from.title} ({a.from.pct}%) → {a.to.title} ({a.to.pct}%)
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Cross-course comparison */}
      {crossCourse.length > 1 && (
        <div className="card">
          <h3 style={{ marginBottom: '0.75rem' }}>Cross-Course Comparison</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={crossCourse} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="course_name" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} label={{ value: 'Avg %', angle: -90, position: 'insideLeft' }} />
              <Tooltip formatter={(v) => `${v}%`} />
              <Bar dataKey="avg_pct" name="Average" radius={[6, 6, 0, 0]}>
                {crossCourse.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Grade trend per course */}
      {courseIds.map((courseId, ci) => {
        const t = trends[courseId];
        if (t.points.length < 2) return null;
        return (
          <div className="card" key={courseId}>
            <h3 style={{ marginBottom: '0.75rem' }}>
              Grade Trend — <Link to={`/course/${courseId}`} className="link">{t.course_name}</Link>
            </h3>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={t.points} margin={{ top: 10, right: 20, bottom: 60, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="title" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 10 }} interval={0} />
                <YAxis domain={[0, 100]} label={{ value: '%', angle: -90, position: 'insideLeft' }} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Line
                  type="monotone" dataKey="pct" name="Score"
                  stroke={COLORS[ci % COLORS.length]} strokeWidth={2}
                  dot={{ fill: COLORS[ci % COLORS.length], r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </>
  );
}
