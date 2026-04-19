import { useState, useEffect } from 'react';
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { getStudentAnalytics } from '../services/api.js';

const COLORS = ['#7c3aed', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

export default function StudentAnalytics({ studentId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [alertsOpen, setAlertsOpen] = useState(false);

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
      {/* Performance alerts — collapsible, collapsed by default */}
      {alerts.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--warning)', padding: 0, overflow: 'hidden' }}>
          <button
            onClick={() => setAlertsOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.75rem 1.25rem', background: 'none', border: 'none', cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <h3 style={{ margin: 0 }}>Performance Alerts</h3>
            <span className="text-sm text-muted">({alerts.length})</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6, marginLeft: 'auto',
              background: 'var(--bg-subtle)', border: '1px solid var(--border)',
              color: 'var(--text)', flexShrink: 0,
              transform: alertsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
            }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.427 6.427a.75.75 0 0 1 1.06 0L8 8.94l2.513-2.513a.75.75 0 0 1 1.06 1.06l-3.043 3.044a.75.75 0 0 1-1.06 0L4.427 7.487a.75.75 0 0 1 0-1.06z"/>
              </svg>
            </span>
          </button>
          {alertsOpen && (
            <div style={{ padding: '0 1.25rem 1.25rem' }}>
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

    </>
  );
}
