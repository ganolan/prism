import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, importCourse, updateCourseBlockNumber } from '../services/api.js';

function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };
  let semester = 'Full Year';
  if (gradingPeriod.includes('Semester 1')) semester = 'Semester 1';
  else if (gradingPeriod.includes('Semester 2')) semester = 'Semester 2';
  const dateMatch = gradingPeriod.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateMatch) return { academicYear: 'Unknown', semester };
  const month = parseInt(dateMatch[1], 10);
  const year = parseInt(dateMatch[3], 10);
  const startYear = month >= 8 ? year : year - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(-2)}`;
  return { academicYear, semester };
}

function groupByAcademicYear(courses) {
  const groups = {};
  for (const c of courses) {
    const { academicYear } = parseGradingPeriod(c.grading_period);
    if (!groups[academicYear]) groups[academicYear] = [];
    groups[academicYear].push(c);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearCourses]) => ({ year, courses: yearCourses }));
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('current');
  const [showHidden, setShowHidden] = useState(false);
  const [courses, setCourses] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importId, setImportId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  // editingBlock: courseId currently being edited, blockDraft: current input value
  const [editingBlock, setEditingBlock] = useState(null);
  const [blockDraft, setBlockDraft] = useState('');

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
    setImportError(null);
    setImportSuccess(null);
    reload();
  }, [activeTab, showHidden]);

  async function handleToggleVisibility(e, courseId) {
    e.preventDefault();
    e.stopPropagation();
    await toggleCourseVisibility(courseId);
    reload();
  }

  async function handleImport(e) {
    e.preventDefault();
    const sid = importId.trim();
    if (!sid) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importCourse(sid);
      setImportSuccess(result);
      setImportId('');
      reload();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  function startEditBlock(e, courseId, currentValue) {
    e.preventDefault();
    e.stopPropagation();
    setEditingBlock(courseId);
    setBlockDraft(currentValue || '');
  }

  function cancelEditBlock(e) {
    e.preventDefault();
    e.stopPropagation();
    setEditingBlock(null);
  }

  if (loading) return <div className="loading">Loading...</div>;

  const yearGroups = groupByAcademicYear(courses);

  // Shared course card renderer
  function CourseCard({ c, showSemester = false }) {
    const { semester } = parseGradingPeriod(c.grading_period);
    const isEditing = editingBlock === c.id;

    return (
      <Link
        to={`/course/${c.id}`}
        key={c.id}
        className="card"
        style={{ opacity: c.hidden ? 0.5 : (showSemester ? 0.75 : 1), position: 'relative' }}
      >
        {/* Block number — top right, prominent */}
        <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          {isEditing ? (
            <>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.05em' }}>BLOCK</span>
              <select
                value={blockDraft}
                onChange={async e => {
                  e.preventDefault(); e.stopPropagation();
                  const val = e.target.value;
                  setBlockDraft(val);
                  await updateCourseBlockNumber(c.id, val || null);
                  setEditingBlock(null);
                  reload();
                }}
                onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                style={{ fontSize: '0.8rem', padding: '0.2rem 0.3rem' }}
                autoFocus
              >
                <option value="">—</option>
                {[1,2,3,4,5,6,7,8].map(n => <option key={n} value={String(n)}>{n}</option>)}
              </select>
              <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem' }} onClick={cancelEditBlock}>✕</button>
            </>
          ) : (
            <button
              className="ghost"
              style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', fontWeight: c.block_number ? 700 : 400, color: c.block_number ? 'var(--accent)' : 'var(--text-muted)', letterSpacing: c.block_number ? '0.05em' : 'normal' }}
              onClick={e => startEditBlock(e, c.id, c.block_number)}
              title="Set block number"
            >
              {c.block_number ? `BLOCK ${c.block_number}` : '+ Block'}
            </button>
          )}
        </div>

        {/* Course info */}
        <div style={{ paddingRight: '7rem' }}>
          <h3 style={{ marginBottom: '0.25rem', fontWeight: 600 }}>{c.course_name}</h3>
          {c.grading_period && showSemester && (
            <p className="text-sm text-muted">{c.grading_period}</p>
          )}
        </div>

        {/* Bottom row: badges + hide button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {showSemester && <span className="badge badge-gray">{semester}</span>}
            {c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
          </div>
          <button
            className="ghost"
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
            onClick={e => handleToggleVisibility(e, c.id)}
            title={c.hidden ? 'Show course' : 'Hide course'}
          >
            {c.hidden ? 'Show' : 'Hide'}
          </button>
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
          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses yet. Use the form below to add a past course.</p>
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

          {/* Add past course form */}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.25rem' }}>Add a past course</h3>
            <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
              Find the section ID in the Schoology URL:{' '}
              <code>schoology.hkis.edu.hk/course/<strong>[ID]</strong>/materials</code>
            </p>
            {importSuccess && (
              <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
                Imported <strong>{importSuccess.course.course_name}</strong> — {importSuccess.studentsCount} students, {importSuccess.assignmentsCount} assignments
              </div>
            )}
            {importError && (
              <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>{importError}</div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label className="text-sm" style={{ display: 'block', marginBottom: '0.25rem' }}>Section ID</label>
                <input
                  type="text"
                  value={importId}
                  onChange={e => setImportId(e.target.value)}
                  placeholder="e.g. 7899907695"
                  style={{ width: '100%' }}
                  disabled={importing}
                />
              </div>
              <button className="primary" onClick={handleImport} disabled={importing || !importId.trim()}>
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
