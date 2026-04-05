import { useState, useEffect, useRef } from 'react';
import { getCourses, getEmails, getRandomStudents, getGroups } from '../services/api.js';

const GROUP_COLORS = [
  'var(--badge-blue-bg)', 'var(--badge-green-bg)', 'var(--warning-light)',
  'var(--badge-pink-bg)', 'var(--accent-light)', 'var(--secondary-light)',
  'var(--error-light)', 'var(--success-light)',
];

export default function ToolsPage() {
  const [courses, setCourses] = useState([]);
  const [selectedCourse, setSelectedCourse] = useState('');

  useEffect(() => {
    getCourses().then(setCourses).catch(console.error);
  }, []);

  return (
    <div className="fade-in">
      <h2 className="page-title">Class Tools</h2>

      <div style={{ marginBottom: '1.5rem', maxWidth: '400px' }}>
        <label className="text-sm" style={{ fontWeight: 600 }}>Select Course</label>
        <select value={selectedCourse} onChange={e => setSelectedCourse(e.target.value)}>
          <option value="">-- Choose a course --</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.course_name}</option>)}
        </select>
      </div>

      {selectedCourse && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <EmailTool courseId={selectedCourse} />
          <RandomPicker courseId={selectedCourse} />
          <GroupGenerator courseId={selectedCourse} />
        </div>
      )}
    </div>
  );
}

function EmailTool({ courseId }) {
  const [type, setType] = useState('student');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    const data = await getEmails(courseId, type);
    setResult(data);
    setCopied(false);
  }

  function handleCopy() {
    navigator.clipboard.writeText(result.formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>Email List</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <div>
          <label className="text-sm">Type</label>
          <select value={type} onChange={e => setType(e.target.value)} style={{ width: 'auto' }}>
            <option value="student">Student emails</option>
            <option value="parent">Parent emails</option>
            <option value="both">Both</option>
          </select>
        </div>
        <button className="primary" onClick={handleGenerate}>Generate</button>
        {result && (
          <button className="primary" onClick={handleCopy} style={{ background: copied ? 'var(--success)' : undefined }}>
            {copied ? 'Copied!' : `Copy ${result.count} emails`}
          </button>
        )}
      </div>
      {result && (
        <textarea readOnly value={result.formatted} rows={3}
          style={{ background: 'var(--bg-subtle)' }}
        />
      )}
    </div>
  );
}

function RandomPicker({ courseId }) {
  const [count, setCount] = useState(1);
  const [picked, setPicked] = useState([]);
  const [animating, setAnimating] = useState(false);
  const [display, setDisplay] = useState(null);
  const intervalRef = useRef(null);

  const displayName = (s) => `${s.preferred_name || s.first_name} ${s.last_name}`;

  async function handlePick() {
    setAnimating(true);
    setPicked([]);
    setDisplay(null);

    const data = await getRandomStudents(courseId, count);
    const finalPicked = data.picked;

    let tick = 0;
    intervalRef.current = setInterval(() => {
      const idx = Math.floor(Math.random() * data.total);
      setDisplay(`${finalPicked[tick % finalPicked.length]?.first_name || '?'} ...`);
      tick++;
    }, 80);

    setTimeout(() => {
      clearInterval(intervalRef.current);
      setPicked(finalPicked);
      setDisplay(null);
      setAnimating(false);
    }, 1500);
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>Random Name Picker</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <div style={{ width: '80px' }}>
          <label className="text-sm">Count</label>
          <input type="number" min={1} max={30} value={count} onChange={e => setCount(parseInt(e.target.value) || 1)} />
        </div>
        <button className="primary" onClick={handlePick} disabled={animating}>
          {animating ? 'Picking...' : 'Pick'}
        </button>
      </div>
      {animating && display && (
        <div style={{ fontSize: '1.5rem', fontWeight: 700, padding: '1rem', textAlign: 'center', background: 'var(--gradient-primary)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {display}
        </div>
      )}
      {picked.length > 0 && !animating && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', padding: '0.5rem 0' }}>
          {picked.map(s => (
            <span key={s.id} className="badge badge-blue" style={{ fontSize: '1rem', padding: '0.4rem 0.75rem' }}>
              {displayName(s)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupGenerator({ courseId }) {
  const [groupCount, setGroupCount] = useState(4);
  const [balanced, setBalanced] = useState(false);
  const [groups, setGroups] = useState(null);

  const displayName = (s) => `${s.preferred_name || s.first_name} ${s.last_name}`;

  async function handleGenerate() {
    const data = await getGroups(courseId, groupCount, balanced);
    setGroups(data.groups);
  }

  function handleExportCSV() {
    if (!groups) return;
    let csv = 'Group,Name\n';
    groups.forEach((g, i) => {
      g.forEach(s => { csv += `${i + 1},"${displayName(s)}"\n`; });
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'groups.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>Group Generator</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <div style={{ width: '120px' }}>
          <label className="text-sm">Number of groups</label>
          <input type="number" min={2} max={20} value={groupCount} onChange={e => setGroupCount(parseInt(e.target.value) || 4)} />
        </div>
        <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={balanced} onChange={e => setBalanced(e.target.checked)} />
          Balance by grade
        </label>
        <button className="primary" onClick={handleGenerate}>Generate</button>
        {groups && <button className="secondary" onClick={handleExportCSV}>Export CSV</button>}
      </div>

      {groups && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
          {groups.map((g, i) => (
            <div key={i} style={{ background: GROUP_COLORS[i % GROUP_COLORS.length], borderRadius: 10, padding: '0.75rem' }}>
              <strong className="text-sm">Group {i + 1}</strong>
              <ul style={{ listStyle: 'none', marginTop: '0.4rem' }}>
                {g.map(s => (
                  <li key={s.id} className="text-sm" style={{ padding: '0.15rem 0' }}>
                    {displayName(s)}
                    {balanced && s.avg_pct != null && <span className="text-muted" style={{ fontSize: '0.75rem', marginLeft: '0.3rem' }}>({s.avg_pct}%)</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
