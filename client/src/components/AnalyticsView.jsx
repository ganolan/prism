import { useState, useEffect } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, LineChart,
} from 'recharts';
import { getCourseAnalytics, runAutoFlags } from '../services/api.js';

export default function AnalyticsView({ id }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoFlagResult, setAutoFlagResult] = useState(null);

  function reload() {
    setLoading(true);
    getCourseAnalytics(id)
      .then(setAnalytics)
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, [id]);

  async function handleAutoFlags() {
    const result = await runAutoFlags(id);
    setAutoFlagResult(result);
  }

  if (loading) return <div className="loading">Loading analytics...</div>;

  const rawDist = analytics?.distributions || [];
  const dist = rawDist.map(d => ({
    ...d,
    whiskerLow: d.whiskerLow,
    q1Range: d.q1 - d.whiskerLow,
    q3Range: d.q3 - d.q1,
    whiskerRange: d.whiskerHigh - d.q3,
  }));
  const trend = analytics?.trend || [];

  return (
    <div>
      {dist.length === 0 ? (
        <div className="card empty-state"><p>No scored assignments to analyse yet.</p></div>
      ) : (
        <>
          <div className="card">
            <h3 style={{ marginBottom: '0.75rem' }}>Grade Distribution by Assignment</h3>
            <p className="text-sm text-muted mb-2">
              Box = Q1-Q3 (middle 50%), line = median, whiskers = 1.5x IQR range. Hover for details.
            </p>
            <ResponsiveContainer width="100%" height={350}>
              <ComposedChart data={dist} margin={{ top: 10, right: 20, bottom: 60, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="title" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 11 }} interval={0} />
                <YAxis domain={[0, 100]} label={{ value: '% Score', angle: -90, position: 'insideLeft', offset: 5 }} />
                <Tooltip content={<BoxTooltip />} />
                <ReferenceLine y={50} stroke="var(--warning)" strokeDasharray="3 3" label={{ value: '50%', fill: 'var(--warning)', fontSize: 11 }} />
                <Bar dataKey="whiskerLow" stackId="box" fill="transparent" />
                <Bar dataKey="q1Range" stackId="box" fill="var(--accent-light)" stroke="var(--accent)" />
                <Bar dataKey="q3Range" stackId="box" fill="var(--accent)" stroke="var(--accent-hover)" opacity={0.6} />
                <Bar dataKey="whiskerRange" stackId="box" fill="transparent" stroke="var(--accent)" />
                <Line type="monotone" dataKey="mean" stroke="var(--secondary)" strokeWidth={2} dot={{ fill: 'var(--secondary)', r: 3 }} name="Class Mean" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <h3 style={{ marginBottom: '0.75rem' }}>Class Average Trend</h3>
            <p className="text-sm text-muted mb-2">
              Mean shown with +/- 1 standard deviation band. Wider band = more spread in student scores.
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={trend.map(t => ({
                ...t,
                low: Math.max(0, t.mean - t.stdDev),
                high: Math.min(100, t.mean + t.stdDev),
              }))} margin={{ top: 10, right: 20, bottom: 60, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="title" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 11 }} interval={0} />
                <YAxis domain={[0, 100]} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Legend />
                <Line type="monotone" dataKey="high" stroke="var(--accent-light)" strokeDasharray="3 3" name="+1 SD" dot={false} />
                <Line type="monotone" dataKey="mean" stroke="var(--accent)" strokeWidth={2} name="Mean" dot={{ fill: 'var(--accent)', r: 3 }} />
                <Line type="monotone" dataKey="low" stroke="var(--accent-light)" strokeDasharray="3 3" name="-1 SD" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3>Auto-Flags</h3>
          <button className="primary" onClick={handleAutoFlags}>Run Auto-Flags</button>
        </div>
        {autoFlagResult && (
          <div className="alert alert-success">
            <p className="text-sm">Created {autoFlagResult.flagsCreated} flags</p>
            {autoFlagResult.details.slice(0, 5).map((d, i) => (
              <p key={i} className="text-sm text-muted">{d.student}: {d.type} — {d.assignment || d.reason}</p>
            ))}
            {autoFlagResult.details.length > 5 && <p className="text-sm text-muted">...and {autoFlagResult.details.length - 5} more</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function BoxTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.75rem', fontSize: '0.8rem', boxShadow: 'var(--card-shadow)' }}>
      <strong>{d.title}</strong>
      <p>n = {d.count} students</p>
      <p>Mean: {d.mean}% (SD: {d.stdDev})</p>
      <p>Median: {d.median}%</p>
      <p>Q1: {d.q1}% — Q3: {d.q3}%</p>
      <p>Range: {d.min}% — {d.max}%</p>
    </div>
  );
}
