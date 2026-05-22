import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getMasteryForAssignment, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, createFlag, deleteFlag } from '../services/api.js';
import { draftKey, readDraft, writeDraft, clearDraft, draftBaseline } from '../lib/assessmentDraft.js';

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

// Collapse soft line wraps from sources like PowerPoint text boxes into single
// lines, while preserving real paragraph breaks (a blank line in the source).
// PowerPoint emits \r\n for hard returns, \v (vertical tab) for soft breaks,
// and litters zero-width spaces onto blank lines and paragraph ends — those
// must be stripped first or blank lines won't register as paragraph breaks.
// Runs of blank lines collapse to one break; blank leading/trailing paragraphs
// are dropped.
function normalizePastedText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\v/g, '\n')
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')   // strip zero-width chars
    .split(/\n[ \t\u00a0]*\n+/)                          // blank line -> paragraph break
    .map(p => p.replace(/[ \t\u00a0]*\n[ \t\u00a0]*/g, ' ').trim())  // wrap -> space
    .filter(Boolean)
    .join('\n\n');
}

// ── Per-student rubric card ──────────────────────────────────────────────────

export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
  const loadedDisplay = student.comment_status === 1;
  const storageKey = draftKey(courseId, assignmentId, student.enrollment_id);
  // Signature of the synced Schoology values this card was rendered against.
  // A stored draft is only valid while this is unchanged (#47).
  const currentBaseline = draftBaseline(student, topics);

  // Restore any unsaved draft for this card from localStorage (#47). Read once
  // on mount; a restored draft means the teacher already interacted with the
  // card, so auto-flip starts disarmed. A draft whose `base` no longer matches
  // the synced data is stale — Schoology changed underneath it — so it is
  // discarded and the synced values (the source of truth) win.
  const [restoredDraft] = useState(() => {
    const draft = readDraft(storageKey);
    if (!draft) return null;
    if (draft.base !== currentBaseline) {
      clearDraft(storageKey);
      return null;
    }
    return draft;
  });

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

  // Review flag (#20) — Prism-local, submission-scoped. Written via /api/flags,
  // entirely independent of the Schoology grade/comment write below.
  const [reviewFlag, setReviewFlag] = useState(student.review_flag || null);
  const [showFlagInput, setShowFlagInput] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagError, setFlagError] = useState(null);
  const [flagControlHover, setFlagControlHover] = useState(false);

  // Re-submit requested flag (#49) — Prism-local, submission-scoped, pure toggle.
  const [resubmitFlag, setResubmitFlag] = useState(student.resubmit_flag || null);
  const [resubmitBusy, setResubmitBusy] = useState(false);
  const [resubmitHover, setResubmitHover] = useState(false);

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
  // The `base` signature lets a later mount detect if Schoology data changed
  // underneath the draft. Remove the entry the moment the card returns to a
  // no-changes state.
  useEffect(() => {
    if (hasPendingChanges) {
      writeDraft(storageKey, { pending, comment, display, base: currentBaseline });
    } else {
      clearDraft(storageKey);
    }
  }, [hasPendingChanges, pending, comment, display, storageKey, currentBaseline]);

  // Apply a new comment value, auto-flipping the display toggle ON the first
  // time a virgin record's comment goes empty → non-empty. Shared by the
  // textarea's onChange and onPaste handlers.
  function applyComment(next) {
    if (autoFlipArmed && comment === '' && next !== '') {
      setDisplay(true);
      setAutoFlipArmed(false);
    }
    setComment(next);
  }

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

  async function handleFlagForReview() {
    const reason = flagReason.trim();
    if (!reason || !assignmentRow?.id) return;
    setFlagError(null);
    setFlagBusy(true);
    try {
      const flag = await createFlag({
        student_id: student.id,
        assignment_id: assignmentRow.id,
        flag_type: 'review_needed',
        flag_reason: reason,
      });
      setReviewFlag({ id: flag.id, flag_reason: flag.flag_reason });
      setShowFlagInput(false);
      setFlagReason('');
    } catch (err) {
      setFlagError(`Flag failed: ${err.message}`);
    } finally {
      setFlagBusy(false);
    }
  }

  async function handleClearReviewFlag() {
    if (!reviewFlag) return;
    setFlagError(null);
    setFlagBusy(true);
    try {
      await deleteFlag(reviewFlag.id);
      setReviewFlag(null);
    } catch (err) {
      setFlagError(`Clear failed: ${err.message}`);
    } finally {
      setFlagBusy(false);
    }
  }

  async function handleRequestResubmit() {
    if (!assignmentRow?.id || resubmitBusy) return;
    setFlagError(null);
    setResubmitBusy(true);
    try {
      const flag = await createFlag({
        student_id: student.id,
        assignment_id: assignmentRow.id,
        flag_type: 'resubmit_requested',
      });
      setResubmitFlag({ id: flag.id });
    } catch (err) {
      setFlagError(`Re-submit request failed: ${err.message}`);
    } finally {
      setResubmitBusy(false);
    }
  }

  async function handleClearResubmit() {
    if (!resubmitFlag || resubmitBusy) return;
    setFlagError(null);
    setResubmitBusy(true);
    try {
      await deleteFlag(resubmitFlag.id);
      setResubmitFlag(null);
    } catch (err) {
      setFlagError(`Clear re-submit failed: ${err.message}`);
    } finally {
      setResubmitBusy(false);
    }
  }

  const bothSignals = !!resubmitFlag && !!student.resubmitted;

  return (
    <div style={{
      border: bothSignals ? '1px solid var(--resubmit-ring)' : '1px solid var(--border)',
      boxShadow: bothSignals ? '0 0 0 2px var(--badge-resubmit-bg)' : 'none',
      borderRadius: 10,
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
        {/* Review flag (#20) — Prism-local; never part of a Schoology save.
            Control and badge live together here in the card header. */}
        {reviewFlag ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            onMouseEnter={() => setFlagControlHover(true)}
            onMouseLeave={() => setFlagControlHover(false)}
          >
            <span className="badge badge-amber" style={{ fontSize: '0.68rem' }}>
              ⚑ Review: {reviewFlag.flag_reason}
            </span>
            <button
              className="ghost danger"
              onClick={handleClearReviewFlag}
              onFocus={() => setFlagControlHover(true)}
              onBlur={() => setFlagControlHover(false)}
              disabled={flagBusy}
              aria-label="Clear review flag"
              title="Clear review flag"
              style={{
                fontSize: '0.9rem', fontWeight: 600, lineHeight: 1,
                padding: '0.1rem 0.35rem',
                opacity: flagControlHover ? 1 : 0,
                transition: 'opacity 0.12s',
              }}
            >
              ✕
            </button>
          </span>
        ) : showFlagInput ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="text"
              value={flagReason}
              onChange={e => setFlagReason(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !flagBusy && flagReason.trim()) handleFlagForReview();
                if (e.key === 'Escape') { setShowFlagInput(false); setFlagReason(''); }
              }}
              placeholder="Reason for review..."
              style={{ fontSize: '0.78rem', width: 200 }}
              autoFocus
            />
            <button
              className="primary"
              onClick={handleFlagForReview}
              disabled={flagBusy || !flagReason.trim()}
              style={{ fontSize: '0.7rem' }}
            >
              Flag
            </button>
            <button
              className="ghost"
              onClick={() => { setShowFlagInput(false); setFlagReason(''); }}
              title="Cancel (Esc)"
              style={{ fontSize: '0.7rem' }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            className="ghost accent"
            onClick={() => setShowFlagInput(true)}
            style={{ fontSize: '0.7rem' }}
          >
            ⚑ Flag for review
          </button>
        )}
        {/* Re-submit requested (#49) — Prism-local pure toggle; never part of a
            Schoology save. */}
        {resubmitFlag ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            onMouseEnter={() => setResubmitHover(true)}
            onMouseLeave={() => setResubmitHover(false)}
          >
            <span className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
              ⟳ Re-submit requested
            </span>
            <button
              className="ghost danger"
              onClick={handleClearResubmit}
              onFocus={() => setResubmitHover(true)}
              onBlur={() => setResubmitHover(false)}
              disabled={resubmitBusy}
              aria-label="Clear re-submit request"
              title="Clear re-submit request"
              style={{
                fontSize: '0.9rem', fontWeight: 600, lineHeight: 1,
                padding: '0.1rem 0.35rem',
                opacity: resubmitHover ? 1 : 0,
                transition: 'opacity 0.12s',
              }}
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            className="ghost accent"
            onClick={handleRequestResubmit}
            disabled={resubmitBusy}
            style={{ fontSize: '0.7rem' }}
          >
            ⟳ Request re-submit
          </button>
        )}
        {student.resubmitted && (
          <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
                title="The student has submitted new work since this was last graded">
            ↩ Resubmitted
          </span>
        )}
        {flagError && (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>{flagError}</span>
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
          onChange={e => applyComment(e.target.value)}
          onPaste={e => {
            const raw = e.clipboardData.getData('text/plain');
            if (!raw) return;
            e.preventDefault();
            const cleaned = normalizePastedText(raw);
            const el = e.target;
            const { selectionStart, selectionEnd } = el;
            const next = comment.slice(0, selectionStart) + cleaned + comment.slice(selectionEnd);
            applyComment(next);
            requestAnimationFrame(() => {
              const pos = selectionStart + cleaned.length;
              el.setSelectionRange(pos, pos);
            });
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
