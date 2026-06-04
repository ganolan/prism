import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getMasteryForAssignment, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag } from '../services/api.js';
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
// PrisMCP cell language (spec §1). Header tint = final fill; cell text is always
// black because descriptor text will later replace the level codes, so colour
// cannot carry meaning in the text. Kept inline (deliberate local exception to
// the app.css CSS-var convention) — consistent with LEVEL_COLORS above.
const CELL_COLORS = {
  ED: { headerFill: '#bfdbfe', draftFill: '#eff6ff', finalBorder: '#2563eb', draftBorder: '#93c5fd' },
  EX: { headerFill: '#bbf7d0', draftFill: '#f0fdf4', finalBorder: '#16a34a', draftBorder: '#86efac' },
  D:  { headerFill: '#fef08a', draftFill: '#fefce8', finalBorder: '#ca8a04', draftBorder: '#fcd34d' },
  EM: { headerFill: '#fed7aa', draftFill: '#fff7ed', finalBorder: '#ea580c', draftBorder: '#fdba74' },
  IE: { headerFill: '#fecaca', draftFill: '#fef2f2', finalBorder: '#dc2626', draftBorder: '#fca5a5' },
};
// Suggestion accent — deliberately violet, NOT yellow (Developing is already yellow).
const SUGGEST = { fill: '#ede9fe', ring: '#a78bfa', glyph: '#8b5cf6' };
const CELL_TEXT = '#1a1a1a';
// Sentinel stored in pending[topicId] to stage a synced final for removal (Slice 2).
const REMOVE = '__remove__';

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

export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved, onPendingChange, registerCard, unregisterCard }) {
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

  // ── Page-level "Send all" wiring (#51) ──────────────────────────────────
  // Report this card's pending state up so the page bar can count unsaved
  // cards and enable/disable. Register two callbacks the page's batched
  // "Send all" uses: getEntry() returns this card's request entry + in-place
  // patch (or null when nothing is unsaved), and applyResult(ok) updates the
  // card's own badge/pending state after the batch lands. The refs always point
  // at the latest closures so the page reads current state, not a stale one.
  const entryRef = useRef(null);
  entryRef.current = buildSendEntry;
  const applyRef = useRef(null);
  applyRef.current = applySendResult;

  useEffect(() => {
    onPendingChange?.(student.schoology_uid, hasPendingChanges);
  }, [hasPendingChanges, student.schoology_uid, onPendingChange]);

  useEffect(() => {
    const uid = student.schoology_uid;
    registerCard?.(uid, {
      getEntry: () => entryRef.current(),
      applyResult: (ok) => applyRef.current(ok),
    });
    return () => unregisterCard?.(uid);
  }, [student.schoology_uid, registerCard, unregisterCard]);

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
    const pendingVal = pending[topicId];

    // Re-clicking a drafted cell toggles it off (back to whatever is synced).
    if (pendingVal != null && pendingVal !== REMOVE && level === pendingVal) {
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
      return;
    }
    // Re-clicking the staged final cell unstages the removal.
    if (pendingVal === REMOVE && level === currentGrade) {
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
      return;
    }
    // Clicking the synced final with nothing pending stages it for removal.
    if (pendingVal == null && level === currentGrade) {
      armAutoFlip();
      setPending(p => ({ ...p, [topicId]: REMOVE }));
      return;
    }
    // Otherwise set/replace a draft on this level.
    armAutoFlip();
    setPending(p => ({ ...p, [topicId]: level }));
  }

  // Auto-flip the display toggle ON the first real selection for a virgin record.
  function armAutoFlip() {
    if (autoFlipArmed) {
      setDisplay(true);
      setAutoFlipArmed(false);
    }
  }

  // Schoology's /observations endpoint replaces the entire observation set for
  // this enrollment+material — partial payloads wipe untouched topics. So build
  // gradeInfo from every aligned topic, with pending changes merged over the
  // current scores. Numeric grade strings ("100"/"75"/...) only: the DB stores
  // letter codes, but Schoology silently drops them — always map via LEVEL_POINTS.
  // `t.id in pending` distinguishes a cleared draft (key deleted → fall back to
  // synced) from a staged removal (REMOVE → omit so the /observations replace
  // clears it in Schoology).
  function buildGradeInfo() {
    const gradeInfo = {};
    for (const t of topics) {
      const level = (t.id in pending) ? pending[t.id] : student.scores[t.id]?.grade;
      if (level == null || level === REMOVE) continue;
      const points = LEVEL_POINTS[level];
      if (points == null) continue;
      gradeInfo[t.id] = { grade: String(points), gradingScaleId: 21337256 };
    }
    return gradeInfo;
  }

  // Post-save score map (pending merged over current), keeping the DB's letter
  // codes — used to patch this card in place after save, no reload/unmount (#50).
  function buildSavedScores() {
    const newScores = {};
    for (const t of topics) {
      const level = (t.id in pending) ? pending[t.id] : student.scores[t.id]?.grade;
      if (level == null || level === REMOVE) continue;
      newScores[t.id] = { points: LEVEL_POINTS[level], grade: level };
    }
    return newScores;
  }

  // This card's batched "Send all" entry + its in-place patch, or null when
  // nothing is unsaved. Same writes as handleSave, expressed as data for the
  // page to collapse into one request (#51).
  function buildSendEntry() {
    const hasScoreChanges = Object.keys(pending).length > 0;
    const hasCommentChange = comment !== (student.grade_comment || '');
    const hasDisplayChange = display !== loadedDisplay;
    if (!hasScoreChanges && !hasCommentChange && !hasDisplayChange) return null;
    return {
      entry: {
        uid: student.schoology_uid,
        enrollmentId: student.enrollment_id,
        assignmentId,
        scores: (hasScoreChanges && assignmentRow) ? {
          gradeInfo: buildGradeInfo(),
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        } : null,
        comment: (hasCommentChange || hasDisplayChange) ? { comment, commentStatus: display } : null,
      },
      patch: { scores: buildSavedScores(), grade_comment: comment, comment_status: display ? 1 : null },
    };
  }

  // Update this card's own UI after the page's batch lands. The page applies the
  // in-place data patch itself (handleCardSaved) — here we only own the badge,
  // pending reset, and draft clear (mirrors handleSave's success/error tail).
  function applySendResult(ok) {
    if (ok) {
      setSaveResult('saved');
      setPending({});
      clearDraft(storageKey);
    } else {
      setSaveResult('error: send failed');
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      const hasScoreChanges = Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');
      const hasDisplayChange = display !== loadedDisplay;

      if (hasScoreChanges && assignmentRow) {
        await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo: buildGradeInfo(),
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
      // Explicit clear: the card stays mounted now, but the write effect runs
      // asynchronously — clear here so a fast bulk run can't race a stale key.
      clearDraft(storageKey);
      onSaved?.(student.schoology_uid, {
        scores: buildSavedScores(),
        grade_comment: comment,
        comment_status: display ? 1 : null,
      });
      return true;
    } catch (err) {
      setSaveResult(`error: ${err.message}`);
      return false;
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
      // overflow visible so the oversized avatar can pop past the header band
      // (top and bottom) without being clipped. Only the header has a corner-
      // reaching background, so we round its top corners to keep the card edge.
      background: 'var(--card-bg)', overflow: 'visible',
      marginBottom: '1rem',
    }}>
      {/* Student header */}
      <div style={{
        padding: '0.6rem 1rem', background: 'var(--bg-subtle)',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        borderBottom: '1px solid var(--border)',
        borderTopLeftRadius: 10, borderTopRightRadius: 10,
      }}>
        {/* Student photo (#24) — mirrors the course-roster avatar pattern, with
            an initials fallback when no picture has synced. */}
        {/* Sized larger than the header band and given negative vertical margins
            so the ring extrudes past the header's bottom border onto the card
            body — the white border + shadow make the avatar pop. */}
        {student.picture_url ? (
          <img
            src={student.picture_url}
            alt=""
            style={{
              width: 70, height: 70, borderRadius: '50%', objectFit: 'cover',
              display: 'block', flexShrink: 0, marginTop: -28, marginBottom: -28,
              border: '3px solid var(--card-bg)', boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
            }}
            onError={e => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div style={{
            width: 70, height: 70, borderRadius: '50%', flexShrink: 0,
            marginTop: -28, marginBottom: -28,
            border: '3px solid var(--card-bg)', boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
            background: 'var(--bg-subtle)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem', color: 'var(--text-muted)', fontWeight: 600,
          }}>
            {(student.first_name?.[0] || '')}{(student.last_name?.[0] || '')}
          </div>
        )}
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
                  background: CELL_COLORS[l].headerFill, color: CELL_TEXT,
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
              const pendingGrade = pending[t.id] ?? null;
              const suggestedLevel = null; // wired in Slice 4 (rubric suggestion overlay)

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
                    const c = CELL_COLORS[l];
                    const stagedRemoval = pendingGrade === REMOVE && l === currentGrade;
                    const isDraft = pendingGrade !== REMOVE && l === pendingGrade;
                    // A synced final shows ONLY when nothing is pending for this topic (a pending
                    // draft on another cell overrides it → that old final renders Empty; spec §2).
                    const isFinal = l === currentGrade && pendingGrade == null;
                    // Suggestion overlay inputs arrive in Slice 4; null-safe until then.
                    const isSuggested = suggestedLevel != null && l === suggestedLevel;
                    const hasTeacherMark = isFinal || isDraft || stagedRemoval;

                    let cellStyle = {
                      padding: '0.25rem 0.4rem',
                      border: '1px solid var(--border)',
                      textAlign: 'center',
                      cursor: 'pointer',
                      userSelect: 'none',
                      transition: 'all 0.1s',
                      color: CELL_TEXT,
                      background: 'var(--card-bg)',
                      position: 'relative',
                    };

                    if (isFinal) {
                      cellStyle = {
                        ...cellStyle, background: c.headerFill,
                        border: `2px solid ${c.finalBorder}`, fontWeight: 700,
                        zIndex: 2,
                      };
                    } else if (isDraft) {
                      cellStyle = {
                        ...cellStyle, background: c.draftFill,
                        border: `2px solid ${c.draftBorder}`,
                        zIndex: 2,
                      };
                    } else if (stagedRemoval) {
                      // Removal marker (Slice 2): default bg, red dashed ring + ✕ glyph.
                      cellStyle = {
                        ...cellStyle, background: 'var(--card-bg)',
                        outline: '1.5px dashed #ef4444', outlineOffset: '-3px',
                        zIndex: 2,
                      };
                    }

                    // Suggestion overlay (Slice 4) composes on top: dashed violet ring always;
                    // violet wash only when there is no teacher mark in this cell (spec §2).
                    if (isSuggested) {
                      cellStyle = {
                        ...cellStyle,
                        ...(stagedRemoval
                          ? { outline: cellStyle.outline, outlineOffset: cellStyle.outlineOffset }
                          : { outline: `1px dashed ${SUGGEST.ring}`, outlineOffset: '-3px' }),
                        zIndex: 2,
                        ...(hasTeacherMark ? {} : { background: SUGGEST.fill }),
                      };
                    }

                    const showCode = isFinal || isDraft || stagedRemoval || isSuggested;

                    return (
                      <td
                        key={l}
                        style={cellStyle}
                        onClick={() => selectLevel(t.id, l)}
                        title={`Set ${t.title} to ${LEVEL_LABELS[l]}`}
                      >
                        {showCode ? (
                          <span style={{ fontSize: '0.75rem', color: CELL_TEXT }}>
                            {l}
                          </span>
                        ) : null}
                        {isSuggested && (
                          <span style={{
                            position: 'absolute', top: 1, right: 3, fontSize: '0.58rem',
                            lineHeight: 1, color: SUGGEST.glyph,
                          }}>✦</span>
                        )}
                        {stagedRemoval && (
                          <span style={{
                            position: 'absolute', top: 0, right: 2, fontSize: '0.6rem',
                            lineHeight: 1, color: '#ef4444',
                          }}>✕</span>
                        )}
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

  // "Send all" bar state (#51). pendingByUid maps each card's uid → true while
  // it has unsaved changes; cardsRef holds each card's { getEntry, applyResult }
  // so the batch can collect entries and report results back per card.
  const [pendingByUid, setPendingByUid] = useState({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const cardsRef = useRef({});

  // Patch a single student in place after its card saves, instead of reloading
  // the whole page (#50). Avoids the "Loading..." flash that unmounted every
  // card on every save during a grading run.
  const handleCardSaved = useCallback((uid, patch) => {
    setData(prev => (prev ? {
      ...prev,
      students: prev.students.map(s => (s.schoology_uid === uid ? { ...s, ...patch } : s)),
    } : prev));
  }, []);

  // Stable registry callbacks (empty deps) so the cards' effects don't churn.
  // The no-op guard keeps a card reporting an unchanged pending state from
  // triggering a re-render loop.
  const handlePendingChange = useCallback((uid, has) => {
    setPendingByUid(prev => {
      if (!!prev[uid] === has) return prev;
      const next = { ...prev };
      if (has) next[uid] = true; else delete next[uid];
      return next;
    });
  }, []);
  const registerCard = useCallback((uid, handlers) => { cardsRef.current[uid] = handlers; }, []);
  const unregisterCard = useCallback((uid) => {
    delete cardsRef.current[uid];
    setPendingByUid(prev => {
      if (!prev[uid]) return prev;
      const next = { ...prev }; delete next[uid]; return next;
    });
  }, []);

  const totalPending = Object.keys(pendingByUid).length;

  async function handleSendAll() {
    const uids = Object.keys(pendingByUid);
    if (uids.length === 0) return;
    setBulkSaving(true);
    setBulkResult(null);

    // Collect each pending card's request entry + its in-place patch, then send
    // the whole set in one batched request (#51) — one browser session for all
    // score writes + one bulk comment PUT, instead of a per-card loop.
    const items = [];
    for (const uid of uids) {
      const built = cardsRef.current[uid]?.getEntry();
      if (built) items.push({ uid, ...built });
    }
    if (items.length === 0) { setBulkSaving(false); return; }

    try {
      const { results } = await sendAllGrades(courseId, items.map(i => i.entry));
      const okByUid = new Map((results || []).map(r => [r.uid, r.ok]));
      let ok = 0, fail = 0;
      for (const i of items) {
        const success = okByUid.get(i.uid) ?? false;
        cardsRef.current[i.uid]?.applyResult(success);
        if (success) { handleCardSaved(i.uid, i.patch); ok++; } else { fail++; }
      }
      setBulkResult(`Sent ${ok} grade${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`);
    } catch (err) {
      // All-or-nothing: a non-2xx (incl. the 502 abort) rejects here — mark every
      // card failed and leave them pending so a retry is one click away.
      for (const i of items) cardsRef.current[i.uid]?.applyResult(false);
      setBulkResult(`Error: ${err.message}`);
    } finally {
      setBulkSaving(false);
    }
  }

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
        <>
          {students.map(student => (
            <StudentRubricCard
              key={student.schoology_uid}
              student={student}
              topics={alignedTopics}
              courseId={courseId}
              assignmentId={assignmentId}
              assignmentRow={assignment}
              onSaved={handleCardSaved}
              onPendingChange={handlePendingChange}
              registerCard={registerCard}
              unregisterCard={unregisterCard}
            />
          ))}

          {/* Bulk send-all bar (#51) — sticky so it stays reachable during a
              fast grading run. */}
          <div style={{
            position: 'sticky', bottom: 0, marginTop: '0.5rem',
            padding: '0.75rem 1rem', background: 'var(--card-bg)',
            borderTop: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
            display: 'flex', alignItems: 'center', gap: '0.75rem',
          }}>
            <button
              className="primary"
              onClick={handleSendAll}
              disabled={bulkSaving || totalPending === 0}
            >
              {bulkSaving
                ? 'Sending...'
                : totalPending > 0
                  ? `Send all to Schoology (${totalPending})`
                  : 'Send all to Schoology'}
            </button>
            {!bulkSaving && totalPending > 0 && (
              <span className="text-sm text-muted">
                {totalPending} student{totalPending !== 1 ? 's' : ''} with unsaved changes
              </span>
            )}
            {bulkResult && (
              <span className="text-sm text-muted">{bulkResult}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
