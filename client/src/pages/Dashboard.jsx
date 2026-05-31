import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, updateCourseBlockNumber } from '../services/api.js';
import { parseGradingPeriod, groupByAcademicYear } from '../lib/courseDisplay.js';
import ArchivedCoursesPanel from '../components/ArchivedCoursesPanel.jsx';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('current');
  const [showHidden, setShowHidden] = useState(false);
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  // editingBlock: courseId currently being edited, blockDraft: current input value
  const [settingsCard, setSettingsCard] = useState(null);

  async function reload() {
    try {
      let coursesData;
      if (showHidden) {
        // Fetch all including hidden, filter by tab client-side
        const all = await getCourses(true, true);
        coursesData = activeTab === 'current'
          ? all.filter(c => !c.archived)
          : all.filter(c => c.archived);
      } else {
        coursesData = await getCoursesByView(activeTab);
      }
      const [, status] = await Promise.all([Promise.resolve(coursesData), getSyncStatus()]);
      setCourses(coursesData);
      setSyncStatus(status);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [activeTab, showHidden]);

  async function handleToggleVisibility(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleCourseVisibility(courseId);
    reload();
  }

  if (loading) return <div className="loading">Loading...</div>;

  const yearGroups = groupByAcademicYear(courses);

  // Shared course card renderer
  function CourseCard({ c, showSemester = false }) {
    const { semester } = parseGradingPeriod(c.grading_period);
    const isSettings = settingsCard === c.id;

    return (
      <Link
        to={`/course/${c.id}`}
        key={c.id}
        className="card"
        style={{ opacity: !!c.hidden ? 0.5 : (showSemester ? 0.75 : 1) }}
      >
        {/* Course info */}
        <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
          {c.block_number && (
            <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: '0.35rem' }}>[BK {c.block_number}]</span>
          )}
          {c.course_name}
        </h3>
        {c.grading_period && showSemester && (
          <p className="text-sm text-muted">{c.grading_period}</p>
        )}

        {/* Bottom row: badges + cog / settings */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {showSemester && <span className="badge badge-gray">{semester}</span>}
            {!!c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
          </div>

          {isSettings ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
              <select
                defaultValue={c.block_number || ''}
                onChange={async e => {
                  const val = e.target.value;
                  await updateCourseBlockNumber(c.id, val || null);
                  reload();
                }}
                style={{ fontSize: '0.8rem', padding: '0.2rem 0.3rem' }}
              >
                <option value="">No block</option>
                {[1,2,3,4,5,6,7,8].map(n => <option key={n} value={String(n)}>Block {n}</option>)}
              </select>
              <button
                className="ghost"
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
                onClick={e => { e.preventDefault(); e.stopPropagation(); handleToggleVisibility(e, c.id); }}
              >
                {!!c.hidden ? 'Show' : 'Hide'}
              </button>
              <button
                className="ghost"
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
                onClick={e => { e.preventDefault(); e.stopPropagation(); setSettingsCard(null); }}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              className="ghost"
              style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1 }}
              onClick={e => { e.preventDefault(); e.stopPropagation(); setSettingsCard(c.id); }}
              title="Card settings"
            >
              ⚙
            </button>
          )}
        </div>
      </Link>
    );
  }

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
      </div>

      {/* Sync status */}
      {syncStatus?.last && (
        <p className="text-sm text-muted mb-2">
          Last sync: {new Date(syncStatus.last.completed_at || syncStatus.last.started_at).toLocaleString()}
          {' — '}{syncStatus.last.status}
          {syncStatus.last.records_synced ? ` (${syncStatus.last.records_synced} records)` : ''}
        </p>
      )}

      {/* Controls: tab toggle + show hidden */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <button className={activeTab === 'current' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('current')}>Current</button>
        <button className={activeTab === 'archived' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('archived')}>Archived</button>
        <span style={{ color: 'var(--border)', userSelect: 'none' }}>|</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
          <div
            onClick={() => setShowHidden(h => !h)}
            style={{
              position: 'relative', width: '36px', height: '20px',
              background: showHidden ? 'var(--accent)' : 'var(--border)',
              borderRadius: '10px', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: '2px',
              left: showHidden ? '18px' : '2px',
              width: '16px', height: '16px',
              background: 'white', borderRadius: '50%',
              transition: 'left 0.2s',
            }} />
          </div>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Show hidden</span>
        </label>
      </div>

      {/* Current tab */}
      {activeTab === 'current' && (
        courses.length === 0 ? (
          <div className="card empty-state">
            <p>No courses synced yet. Click <strong>Sync Schoology</strong> in the sidebar to pull your courses.</p>
          </div>
        ) : (
          <div className="grid-2">
            {courses.map(c => <CourseCard key={c.id} c={c} />)}
          </div>
        )
      )}

      {/* Archived tab */}
      {activeTab === 'archived' && (
        <div>
          <ArchivedCoursesPanel onImported={reload} />

          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses imported yet. Use the "Check Schoology for archived courses" action above to find and import them.</p>
            </div>
          ) : (
            yearGroups.map(({ year, courses: groupCourses }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {year}
                </h3>
                <div className="grid-2">
                  {groupCourses.map(c => <CourseCard key={c.id} c={c} showSemester />)}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
