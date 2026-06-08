import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, updateCourseBlockNumber, syncBlockNumbers } from '../services/api.js';
import { groupByYearAndSemester } from '../lib/courseDisplay.js';
import ArchivedCoursesPanel from '../components/ArchivedCoursesPanel.jsx';
import { useDataVersion } from '../hooks/useDataVersion.jsx';

export default function Dashboard() {
  const dataVersion = useDataVersion();
  const [activeTab, setActiveTab] = useState('current');
  const [showHidden, setShowHidden] = useState(false);
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  // editingBlock: courseId currently being edited, blockDraft: current input value
  const [settingsCard, setSettingsCard] = useState(null);
  const [blockSyncing, setBlockSyncing] = useState(false);
  const [blockSyncMsg, setBlockSyncMsg] = useState(null);

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
  }, [activeTab, showHidden, dataVersion]);

  async function handleToggleVisibility(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleCourseVisibility(courseId);
    reload();
  }

  async function handleSyncBlocks() {
    setBlockSyncing(true);
    setBlockSyncMsg(null);
    try {
      const s = await syncBlockNumbers();
      setBlockSyncMsg({ type: 'success', text: `Blocks synced from PowerSchool: ${s.updated} updated, ${s.unchanged} unchanged, ${s.skipped} skipped.` });
      await reload();
    } catch (err) {
      const needsLogin = /mastery:login|log in/i.test(err.message);
      setBlockSyncMsg({ type: 'warning', text: needsLogin ? 'PowerSchool session expired — run `npm run mastery:login`, then try again.' : err.message });
    } finally {
      setBlockSyncing(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  const yearGroups = groupByYearAndSemester(courses);

  // Shared course card renderer
  function CourseCard({ c, showSemester = false }) {
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
        <button
          className="secondary"
          onClick={handleSyncBlocks}
          disabled={blockSyncing}
          title="Populate each course's block from PowerSchool's attendance page"
        >
          {blockSyncing ? 'Syncing blocks…' : 'Sync blocks from PowerSchool'}
        </button>
      </div>

      {blockSyncMsg && (
        <div className={`alert alert-${blockSyncMsg.type}`} style={{ marginBottom: '1rem' }}>
          {blockSyncMsg.text}
        </div>
      )}

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
            yearGroups.map(({ year, semesters }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {year}
                </h3>
                {semesters.map(({ semester, courses: semCourses }) => (
                  <div key={semester} style={{ marginBottom: '1rem' }}>
                    <h4 className="archived-semester-subhead">{semester}</h4>
                    <div className="grid-2">
                      {semCourses.map(c => <CourseCard key={c.id} c={c} showSemester />)}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
