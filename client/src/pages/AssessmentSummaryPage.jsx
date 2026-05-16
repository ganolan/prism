import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getMasteryForAssignment, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment } from '../services/api.js';
import { draftKey, readDraft, writeDraft, clearDraft } from '../lib/assessmentDraft.js';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
const LEVEL_LABELS = {
  ED: 'Exhibiting Depth',
  EX: 'Exhibiting',
  D: 'Developing',
  EM: 'Emerging',
  IE: 'Insufficient Evidence',
};
const LEVEL_POINTS = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };
const EXCEPTION_LABELS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing', 4: 'Late' };
const LEVEL_COLORS = {
  ED: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd', activeBg: '#1d4ed8', activeText: '#fff' },
  EX: { bg: '#dcfce7', text: '#166534', border: '#86efac', activeBg: '#16a34a', activeText: '#fff' },
  D:  { bg: '#fef9c3', text: '#713f12', border: '#fde047', activeBg: '#ca8a04', activeText: '#fff' },
  EM: { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa', activeBg: '#ea580c', activeText: '#fff' },
  IE: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', activeBg: '#dc2626', activeText: '#fff' },
};

function displayName(student) {
  return `${student.preferred_name_teacher || student.preferred_name || student.first_name} ${student.last_name}`;
}

// ── Per-student rubric card ──────────────────────────────────────────────────

export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
  const loadedDisplay = student.comment_status === 1;
  const storageKey = draftKey(courseId, assignmentId, student.enrollment_id);

  // Restore any unsaved draft for this card from localStorage (#47). Read once
  // on mount; a restored draft means the teacher already interacted with the
  // card, so auto-flip starts disarmed.
  const [restoredDraft] = useState(() => readDraft(storageKey));

  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState(() => restoredDraft?.pending ?? {});
  const [comment, setComment] = useState(
    () => restoredDraft?.comment ?? (student.grade_comment || '')
  );
  // Display-to-student toggle (#34). Loaded from grades.comment_status:
  // 1 → ON, anything else → OFF. Auto-flip is armed when the row hasn't been
  // published yet AND has no comment text — covers virgin records and rows
  // that exist from a sync but haven't had any meaningful teacher action.
  // Once the toggle has been touched (auto or manual) we disarm; Schoology's
  // existing state (already-published rows or rows with saved comments) is
  // never auto-flipped over. A restored draft also disarms it.
  const [display, setDisplay] = useState(
    () => restoredDraft?.display ?? loadedDisplay
  );
  const [autoFlipArmed, setAutoFlipArmed] = useState(() =>
    restoredDraft
      ? false
      : student.comment_status !== 1 && !student.grade_comment
  );
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);

  // Exception (Excused/Incomplete/Missing) on the underlying grade locks the
  // rubric grid: setting one of these in Schoology deletes the score, so any
  // proficiency a teacher selected here would be wiped on the next sync.
  // Comments and the Display-to-student toggle stay editable — Schoology
  // allows those for flagged students, and they add important context for
  // students/parents. Late (4) doesn't lock anything.
  const exceptionLabel = EXCEPTION_LABELS[student.exception];
  // Rubric-locking exceptions only. Schoology disables rubric editing for
  // Excused/Incomplete/Missing but leaves the comment + display-to-student
  // flag editable — Prism mirrors that. Late (4) does NOT lock the rubric.
  const isRubricLocked = student.exception === 1 || student.exception === 2 || student.exception === 3;

  const hasPendingChanges = (
    Object.keys(pending).length > 0 ||
    comment !== (student.grade_comment || '') ||
    display !== loadedDisplay
  );

  // Persist unsaved work to localStorage so it survives a page reload (#47).
  // Remove the entry the moment the card returns to a no-changes state.
  useEffect(() => {
    if (hasPendingChanges) {
      writeDraft(storageKey, { pending, comment, display });
    } else {
      clearDraft(storageKey);
    }
  }, [hasPendingChanges, pending, comment, display, storageKey]);

  function selectLevel(topicId, level) {
    if (isRubricLocked) return;
    const currentGrade = student.scores[topicId]?.grade;
    if (level === currentGrade) {
      // Clicking current — deselect pending
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
    } else {
      // Auto-flip ON the first time a real selection is made for a virgin
      // record. Deselect clicks (level === currentGrade) don't count.
      if (autoFlipArmed) {
        setDisplay(true);
        setAutoFlipArmed(false);
      }
      setPending(p => ({ ...p, [topicId]: level }));
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      // Schoology's /observations endpoint replaces the entire observation set
      // for this enrollment+material — partial payloads wipe untouched topics.
      // Build gradeInfo from every aligned topic, with pending changes merged over
      // the current scores.
      const gradeInfo = {};
      for (const t of topics) {
        const pendingLevel = pending[t.id];
        const currentGrade = student.scores[t.id]?.grade;
        const level = pendingLevel ?? currentGrade;
        if (level == null) continue;
        // Schoology expects numeric grade strings ("100"/"75"/...). DB stores
        // letter codes ("ED"/"EX"/...). Always map through LEVEL_POINTS so the
        // payload is uniformly numeric — Schoology silently drops letter codes.
        const points = LEVEL_POINTS[level];
        if (points == null) continue;
        gradeInfo[t.id] = { grade: String(points), gradingScaleId: 21337256 };
      }

      const hasScoreChanges = Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');
      const hasDisplayChange = display !== loadedDisplay;

      if (hasScoreChanges && assignmentRow) {
        await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo,
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        });
      }

      if (hasCommentChange || hasDisplayChange) {
        await writeMasteryComment(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          comment,
          commentStatus: display,
        });
      }
      setSaveResult('saved');
      setPending({});
      // Explicit clear: onSaved() triggers a page reload that unmounts this
      // card, so the write effect above will not run to clear the key itself.
      clearDraft(storageKey);
      onSaved?.();
    } catch (err) {
      setSaveResult(`error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10,
      background: 'var(--card-bg)', overflow: 'hidden',
      marginBottom: '1rem',
    }}>
      {/* Student header */}
      <div style={{
        padding: '0.6rem 1rem', background: 'var(--bg-subtle)',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        borderBottom: '1px solid var(--border)',
      }}>
        <Link to={`/student/${student.id}`} className="link" style={{ fontWeight: 600, fontSize: '0.95rem' }}>
          {displayName(student)}
        </Link>
        {Object.keys(pending).length > 0 && (
          <span className="badge" style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.68rem' }}>
            {Object.keys(pending).length} pending change{Object.keys(pending).length !== 1 ? 's' : ''}
          </span>
        )}
        {saveResult === 'saved' && (
          <span className="badge badge-green" style={{ fontSize: '0.68rem' }}>Saved ✓</span>
        )}
        {saveResult?.startsWith('error') && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }}>{saveResult}</span>
        )}
        {isRubricLocked && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }} title="Exception set in Schoology — score data is deleted while the exception is active">
            {exceptionLabel} — rubric locked
          </span>
        )}
      </div>

      {/* Rubric grid */}
      <div style={{
        overflowX: 'auto', padding: '0.75rem 1rem 0',
        opacity: isRubricLocked ? 0.45 : 1,
        pointerEvents: isRubricLocked ? 'none' : 'auto',
      }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
          <thead>
            <tr>
              <th style={{
                padding: '0.3rem 0.6rem', textAlign: 'left',
                background: 'var(--bg-subtle)', border: '1px solid var(--border)',
                fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-muted)', minWidth: 160,
              }}>
                Measurement Topic
              </th>
              {LEVELS.map(l => (
                <th key={l} style={{
                  padding: '0.3rem 0.5rem', textAlign: 'center', width: '12%',
                  background: LEVEL_COLORS[l].bg, color: LEVEL_COLORS[l].text,
                  border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.72rem',
                  whiteSpace: 'nowrap',
                }}>
                  {l}
                  <div style={{ fontWeight: 400, fontSize: '0.6rem', opacity: 0.8 }}>{LEVEL_LABELS[l]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topics.map(t => {
              const currentGrade = student.scores[t.id]?.grade || null;
              const pendingGrade = pending[t.id] || null;

              return (
                <tr key={t.id}>
                  <td style={{
                    padding: '0.3rem 0.6rem', border: '1px solid var(--border)',
                    fontSize: '0.78rem', color: 'var(--text)',
                  }}>
                    {t.title}
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', opacity: 0.7 }}>{t.category_title} · {t.external_id}</div>
                  </td>
                  {LEVELS.map(l => {
                    const isCurrent = l === currentGrade;
                    const isPending = l === pendingGrade;
                    const c = LEVEL_COLORS[l];

                    let cellStyle = {
                      padding: '0.25rem 0.4rem',
                      border: '1px solid var(--border)',
                      textAlign: 'center',
                      cursor: 'pointer',
                      userSelect: 'none',
                      transition: 'all 0.1s',
                    };

                    if (isCurrent && !pendingGrade) {
                      // Currently awarded, no pending change → solid green fill
                      cellStyle = { ...cellStyle, background: '#16a34a', border: '2px solid #15803d' };
                    } else if (isPending) {
                      // Pending selection → green border, light fill
                      cellStyle = { ...cellStyle, background: c.bg, border: `2px solid #16a34a` };
                    } else if (isCurrent && pendingGrade) {
                      // Was current but overridden by a pending change → show dimmed
                      cellStyle = { ...cellStyle, background: c.bg, opacity: 0.4 };
                    } else {
                      cellStyle = { ...cellStyle, background: 'var(--card-bg)' };
                    }

                    return (
                      <td
                        key={l}
                        style={cellStyle}
                        onClick={() => selectLevel(t.id, l)}
                        title={`Set ${t.title} to ${LEVEL_LABELS[l]}`}
                      >
                        {(isCurrent || isPending) ? (
                          <span style={{
                            fontWeight: 700, fontSize: '0.75rem',
                            color: isCurrent && !pendingGrade ? '#fff' : isPending ? '#16a34a' : c.text,
                          }}>
                            {l}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Comment + update */}
      <div style={{ padding: '0.75rem 1rem' }}>
        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.3rem', color: 'var(--text-muted)' }}>
          Overall Comment
        </label>
        <textarea
          value={comment}
          onChange={e => {
            const next = e.target.value;
            // Auto-flip ON the first time the comment goes empty → non-empty
            // for a virgin record. After firing once, autoFlipArmed is cleared
            // so subsequent edits don't re-flip the toggle.
            if (autoFlipArmed && comment === '' && next !== '') {
              setDisplay(true);
              setAutoFlipArmed(false);
            }
            setComment(next);
          }}
          rows={3}
          style={{ width: '100%', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box' }}
          placeholder="Teacher comment for this student on this assessment..."
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', alignItems: 'center' }}>
          <button
            className="primary"
            onClick={handleSave}
            disabled={saving || !hasPendingChanges}
          >
            {saving ? 'Saving...' : 'Update Schoology'}
          </button>
          {hasPendingChanges && !saving && (
            <button className="ghost" onClick={() => {
              setPending({});
              setComment(student.grade_comment || '');
              setDisplay(loadedDisplay);
              setAutoFlipArmed(student.comment_status !== 1 && !student.grade_comment);
            }}>
              Discard Changes
            </button>
          )}
          {!hasPendingChanges && (
            <span className="text-sm text-muted">No changes</span>
          )}
          <label
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center',
              gap: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)',
              cursor: 'pointer', userSelect: 'none',
            }}
            title="When ON, the student sees this assignment's grade, comment, and proficiencies on Schoology."
          >
            Display to student
            <span
              role="switch"
              aria-checked={display}
              aria-label="Display to student"
              tabIndex={0}
              onClick={() => {
                setDisplay(d => !d);
                setAutoFlipArmed(false);
              }}
              onKeyDown={e => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  setDisplay(d => !d);
                  setAutoFlipArmed(false);
                }
              }}
              style={{
                position: 'relative', width: 36, height: 20,
                background: display ? 'var(--accent)' : 'var(--bg-subtle)',
                border: '1px solid var(--border)', borderRadius: 999,
                transition: 'background 0.15s',
              }}
            >
              <span style={{
                position: 'absolute', top: 1, left: display ? 17 : 1,
                width: 16, height: 16, borderRadius: '50%',
                background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                transition: 'left 0.15s',
              }} />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AssessmentSummaryPage() {
  const { id: courseId, assignmentId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);

  function load() {
    setLoading(true);
    getMasteryForAssignment(courseId, assignmentId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const result = await syncMasteryForAssignment(courseId, assignmentId);
      setRefreshResult(`Synced ${result.scoresCount ?? 0} scores across ${result.topicsCount ?? 0} topics${result.commentsCount ? `, ${result.commentsCount} comments` : ''}`);
      load();
    } catch (err) {
      setRefreshResult(`Error: ${err.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(load, [courseId, assignmentId]);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  const { assignment, topics, students } = data;

  const alignedTopics = topics;

  return (
    <div className="fade-in">
      <div style={{ marginBottom: '1.25rem' }}>
        <Link to={`/course/${courseId}`} className="link" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          ← Back to course
        </Link>
        <h2 style={{ margin: '0.3rem 0 0.2rem', fontSize: '1.3rem', fontWeight: 700 }}>
          {assignment.title || assignmentId}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            {students.length} students · {alignedTopics.length} measurement topics
          </p>
          <button className="secondary" onClick={handleRefresh} disabled={refreshing} style={{ fontSize: '0.78rem' }}>
            {refreshing ? 'Refreshing...' : 'Refresh from Schoology'}
          </button>
          {refreshResult && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>{refreshResult}</span>
          )}
        </div>
      </div>

      {/* Proficiency level legend */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {LEVELS.map(l => (
          <span key={l} style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            padding: '0.2rem 0.5rem', borderRadius: 6,
            background: LEVEL_COLORS[l].bg, color: LEVEL_COLORS[l].text,
            fontSize: '0.72rem', fontWeight: 600, border: `1px solid ${LEVEL_COLORS[l].border}`,
          }}>
            {l} — {LEVEL_LABELS[l]}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
          Click a cell to change proficiency · green border = pending · solid green = current
        </span>
      </div>

      {students.length === 0 ? (
        <div className="card">
          <p className="text-muted">No students found. Run a mastery sync for this course first.</p>
        </div>
      ) : (
        students.map(student => (
          <StudentRubricCard
            key={student.schoology_uid}
            student={student}
            topics={alignedTopics}
            courseId={courseId}
            assignmentId={assignmentId}
            assignmentRow={assignment}
            onSaved={load}
          />
        ))
      )}
    </div>
  );
}
