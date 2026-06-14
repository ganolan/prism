import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getMasteryForAssignment, getFeedbackForAssignment, getAssessmentAnalysis, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag, getRubricForAssignment, getRubricConfig, getDraftsForAssignment } from '../services/api.js';
import { draftBaseline } from '../lib/assessmentDraft.js';
import { makeDraftSaver } from '../lib/assessmentDraftSaver.js';
import { resolveRubricScores, distributionByTopic } from '../lib/rubricSuggestions.js';
import { studentFullName } from '../lib/studentNames.js';
import { useDataVersion } from '../hooks/useDataVersion.jsx';
import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';
import { useProficiencyScale } from '../hooks/useProficiencyScale.js';
import RubricDescriptorGrid from '../components/RubricDescriptorGrid.jsx';
import RubricManagerModal from '../components/RubricManagerModal.jsx';
import AiSparkle from '../components/AiSparkle.jsx';
import SchoologyLink from '../components/SchoologyLink.jsx';

const EXCEPTION_LABELS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing', 4: 'Late' };
// Suggestion accent — fuchsia CSS tokens (matches descriptor grid's --ai-suggest).
const SUGGEST = { fill: 'var(--ai-suggest-wash)', ring: 'var(--ai-suggest)', glyph: 'var(--ai-suggest)' };
// Sentinel stored in pending[topicId] to stage a synced final for removal (Slice 2).
const REMOVE = '__remove__';

function displayName(student) {
  return studentFullName(student);
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

// A header status pill for the per-submission review / resubmit flags (#20/#49).
// Inactive: thin accent border, white background, neutral text, accent icon —
// clicking activates. Active: thicker accent border + filled accent colours;
// clicking clears it, and hovering swaps the icon/label to a ✕ "Clear"
// affordance so it's obvious the click will remove the flag. Sized to match the
// control-band buttons (0.85rem / 600).
function HeaderPill({ active, accent, activeBg, activeText, icon, label, clearLabel, onClick, busy }) {
  const [hover, setHover] = useState(false);
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
    borderRadius: 999, padding: '0 0.7rem', lineHeight: 1.2,
    // Fixed height + border-box so the inactive (1.5px) and active (2.5px) border
    // widths produce the SAME outer height — the header band never resizes when a
    // pill activates.
    height: '1.8rem', boxSizing: 'border-box', whiteSpace: 'nowrap',
    fontSize: '0.85rem', fontWeight: 600, fontFamily: 'inherit',
    cursor: busy ? 'default' : 'pointer', userSelect: 'none',
    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
  };
  // Fixed-width icon box so swapping the glyph (icon ↔ ✕) never resizes the pill.
  const iconBox = { display: 'inline-block', width: '1em', textAlign: 'center', flexShrink: 0 };

  if (!active) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{ ...base, border: `1.5px solid ${accent}`, background: 'var(--card-bg)', color: 'var(--text-muted)' }}
      >
        <span aria-hidden="true" style={{ ...iconBox, color: accent }}>{icon}</span>
        {label}
      </button>
    );
  }

  // Active: clicking clears. On hover we keep the SAME label text (and width) to
  // avoid a resize-flicker loop — only the icon swaps to ✕, the label gets a
  // strike-through, and the colours shift to the danger palette so it reads as
  // "this click removes it".
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={clearLabel}
      title="Click to clear"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        ...base, border: `2.5px solid ${hover ? 'var(--danger)' : accent}`,
        background: hover ? 'var(--danger-bg)' : activeBg,
        color: hover ? 'var(--danger)' : activeText,
      }}
    >
      <span aria-hidden="true" style={iconBox}>{hover ? '✕' : icon}</span>
      <span style={{ textDecoration: hover ? 'line-through' : 'none' }}>{label}</span>
    </button>
  );
}

// ── Per-student rubric card ──────────────────────────────────────────────────

export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow, draftRow = null, rubric = null, viewMode = 'descriptors', rubricPalette = {}, onSaved, onPendingChange, onDisplayChange, registerCard, unregisterCard }) {
  const scale = useProficiencyScale();
  const loadedDisplay = student.comment_status === 1;
  // Per-card DB draft saver (replaces the former localStorage key). Created once.
  const saverRef = useRef(null);
  if (!saverRef.current) {
    saverRef.current = makeDraftSaver(
      { assignmentId, studentId: student.id, enrollmentId: student.enrollment_id },
      { delay: 500 }
    );
  }
  // Set true by discrete handlers (proficiency / display) so the next autosave
  // flushes immediately instead of debouncing.
  const flushNextRef = useRef(false);
  // Signature of the synced Schoology values this card was rendered against.
  // A stored draft is only valid while this is unchanged (#47).
  const currentBaseline = draftBaseline(student, topics);

  // Reviewer rubric suggestions resolved to topic ids (spec §5). Best-effort:
  // unresolved keys / out-of-set values are silently dropped by the resolver.
  const suggestedByTopic = resolveRubricScores(feedbackRow?.feedback_parsed?.rubric_scores, topics);

  const reviewerFlags = feedbackRow?.feedback_parsed?.reviewer_flags || null;
  const narrativeSuggestion = feedbackRow?.feedback_parsed?.narrative_feedback || null;
  // Teacher-facing dot-point analysis (grader signal; never published to the
  // student). Lives in feedback_json.strengths/.suggestions, distinct from the
  // narrative and the reviewer flags. Surfaced via the "Show full analysis" toggle.
  const strengths = feedbackRow?.feedback_parsed?.strengths || [];
  const suggestions = feedbackRow?.feedback_parsed?.suggestions || [];
  const hasAnalysis = strengths.length > 0 || suggestions.length > 0;
  const hasSuggestionBlock = Boolean(narrativeSuggestion || reviewerFlags || hasAnalysis);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);

  // Restore any unsaved draft for this card from localStorage (#47). Read once
  // on mount; a restored draft means the teacher already interacted with the
  // card, so auto-flip starts disarmed. A draft whose `base` no longer matches
  // the synced data is stale — Schoology changed underneath it — so it is
  // discarded and the synced values (the source of truth) win.
  const [restoredDraft] = useState(() => {
    if (!draftRow) return null;
    // Stale: Schoology changed underneath the draft (#47). Ignore it; the mount
    // effect below deletes the orphaned server row.
    if (draftRow.base !== currentBaseline) return null;
    return draftRow;
  });
  const draftWasStale = Boolean(draftRow && draftRow.base !== currentBaseline);

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
  // Whether the teacher *manually* changed the visibility toggle. The auto-flip
  // (turning visibility on when a virgin record is first graded) is a side
  // effect of grading, not a separate action, so it must NOT inflate the pending
  // count — only a manual toggle does. Persisted in the draft.
  const [displayTouched, setDisplayTouched] = useState(
    () => restoredDraft?.displayTouched ?? false
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

  // Re-submit requested flag (#49) — Prism-local, submission-scoped, pure toggle.
  const [resubmitFlag, setResubmitFlag] = useState(student.resubmit_flag || null);
  const [resubmitBusy, setResubmitBusy] = useState(false);

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

  // Comment publish state, verified against the synced Schoology value mirrored
  // in the local DB (grades.grade_comment → student.grade_comment). After a
  // successful publish the card patches grade_comment to the new text, so:
  //   published = current text is non-empty AND equal to the synced value;
  //   dirty     = current text differs from the synced value (unsaved edit).
  const syncedComment = student.grade_comment || '';
  const commentDirty = comment !== syncedComment;
  const commentPublished = comment.trim() !== '' && !commentDirty;

  // Count every distinct unsaved change: each changed rubric topic, plus the
  // comment edit, plus a manual display-to-student toggle. Drives the "N pending
  // change(s)" badge so a visibility flip or comment edit is reflected too.
  const pendingCount = (
    Object.keys(pending).length +
    (commentDirty ? 1 : 0) +
    ((displayTouched && display !== loadedDisplay) ? 1 : 0)
  );
  const hasPendingChanges = pendingCount > 0;

  // Track whether this card has ever held a draft, so an untouched card does NOT
  // fire a spurious DELETE on first mount (only a real draft→clear transition does).
  const didDraftRef = useRef(Boolean(restoredDraft));

  // Mirror unsaved work to the DB. React state stays the instant UI source of
  // truth; this autosave is fire-and-forget. Typing debounces (~500ms); a
  // discrete proficiency/display change flushes immediately (flushNextRef).
  useEffect(() => {
    const saver = saverRef.current;
    if (hasPendingChanges) {
      didDraftRef.current = true;
      saver.save(
        { pending, comment, display, displayTouched, base: currentBaseline },
        { immediate: flushNextRef.current }
      );
    } else if (didDraftRef.current) {
      // Honor flushNextRef so a discrete clear (discard / toggle-off) deletes the
      // server row immediately; a debounced remove could be lost on fast navigate
      // (the unmount flush intentionally does not flush queued deletes).
      saver.remove({ immediate: flushNextRef.current });
    }
    flushNextRef.current = false;
  }, [hasPendingChanges, pending, comment, display, displayTouched, currentBaseline]);

  // Flush a pending save on tab-hide (sendBeacon) and on SPA unmount (keepalive);
  // delete a stale server draft once on mount.
  useEffect(() => {
    const saver = saverRef.current;
    if (draftWasStale) saver.remove({ immediate: true });
    const onPageHide = () => saver.flush({ beacon: true });
    const onVisibility = () => { if (document.visibilityState === 'hidden') saver.flush({ beacon: true }); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      saver.flush({ keepalive: true });
      saver.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time migration of a pre-DB localStorage draft for this card. If the
  // browser still holds the old key and the server has no draft, seed React
  // state from it (the autosave effect then persists it) and clear localStorage.
  useEffect(() => {
    if (draftRow) return;
    const legacyKey = `prism:assessment-draft:${courseId}:${assignmentId}:${student.enrollment_id}`;
    let legacy = null;
    try { const raw = localStorage.getItem(legacyKey); legacy = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (!legacy) return;
    // Remove before the baseline check — a stale legacy draft should not persist either.
    try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
    if (legacy.base === currentBaseline) {
      flushNextRef.current = true;
      setPending(legacy.pending ?? {});
      setComment(legacy.comment ?? (student.grade_comment || ''));
      setDisplay(legacy.display ?? loadedDisplay);
      setDisplayTouched(legacy.displayTouched ?? false);
      setAutoFlipArmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const discardRef = useRef(null);
  discardRef.current = discardChanges;
  const setDisplayRef = useRef(null);
  setDisplayRef.current = applyDisplay;

  useEffect(() => {
    onPendingChange?.(student.schoology_uid, hasPendingChanges);
  }, [hasPendingChanges, student.schoology_uid, onPendingChange]);

  // Report this card's current visibility up so the page bar's "show all to
  // students" toggle can reflect the class-wide aggregate (all / none / mixed).
  useEffect(() => {
    onDisplayChange?.(student.schoology_uid, display);
  }, [display, student.schoology_uid, onDisplayChange]);

  useEffect(() => {
    const uid = student.schoology_uid;
    registerCard?.(uid, {
      getEntry: () => entryRef.current(),
      applyResult: (ok) => applyRef.current(ok),
      discard: () => discardRef.current(),
      setDisplay: (v) => setDisplayRef.current(v),
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
    flushNextRef.current = true;
    const currentGrade = student.scores[topicId]?.grade;
    const pendingVal = pending[topicId];
    const hasPending = topicId in pending; // a draft level OR the REMOVE sentinel

    // Clicking the cell whose level matches the synced final score.
    if (level === currentGrade) {
      if (hasPending) {
        // A draft (on this or any other cell in the row) or a staged removal is
        // active → clicking the original final reverts the whole topic straight
        // back to its synced score, in one click (not a draft of the final).
        setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
      } else {
        // Nothing pending → stage this synced final for removal.
        armAutoFlip();
        setPending(p => ({ ...p, [topicId]: REMOVE }));
      }
      return;
    }

    // Re-clicking the active draft cell toggles it off (back to the synced score).
    if (pendingVal != null && pendingVal !== REMOVE && level === pendingVal) {
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
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

  // Revert all of this card's unsaved changes back to the synced Schoology
  // state. Shared by the per-card Discard button and the page-level Discard all.
  function discardChanges() {
    flushNextRef.current = true;
    setPending({});
    setComment(student.grade_comment || '');
    setDisplay(loadedDisplay);
    setDisplayTouched(false);
    setAutoFlipArmed(student.comment_status !== 1 && !student.grade_comment);
  }

  // Set the display-to-student visibility. Shared by the per-card switch and the
  // page-level "show/hide all". Marks it a manual change so it counts as pending
  // (the pendingCount guard ignores it when value already equals the synced one).
  function applyDisplay(value) {
    flushNextRef.current = true;
    setDisplay(value);
    setDisplayTouched(true);
    setAutoFlipArmed(false);
  }

  // Schoology's /observations endpoint replaces the entire observation set for
  // this enrollment+material — partial payloads wipe untouched topics. So build
  // gradeInfo from every aligned topic, with pending changes merged over the
  // current scores. Numeric grade strings ("100"/"75"/...) only: the DB stores
  // letter codes, but Schoology silently drops them — always map via scale.levelToPoints (the SSOT).
  // `t.id in pending` distinguishes a cleared draft (key deleted → fall back to
  // synced) from a staged removal (REMOVE → omit so the /observations replace
  // clears it in Schoology).
  function buildGradeInfo() {
    const gradeInfo = {};
    for (const t of topics) {
      const level = (t.id in pending) ? pending[t.id] : student.scores[t.id]?.grade;
      if (level == null || level === REMOVE) continue;
      const points = scale.levelToPoints(level);
      if (points == null) continue;
      gradeInfo[t.id] = { grade: String(points), gradingScaleId: scale.schoologyScaleId };
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
      newScores[t.id] = { points: scale.levelToPoints(level), grade: level };
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
        // Guard on scale.ready: if the scale hasn't loaded yet, levelToPoints
        // returns null for every topic, so buildGradeInfo() produces {} (all
        // topics skipped). Schoology's /observations write REPLACES the full
        // observation set, so posting an empty gradeInfo would wipe all scores.
        // Defer the score write instead of posting a destructive empty set.
        // The per-card Save button uses the same discriminator (!scale.ready →
        // disabled), so this mirrors that behaviour for the batch path.
        // NOTE: an empty gradeInfo when scale.ready IS true is a valid "clear
        // all topics" intent — do not use gradeInfo emptiness as the skip signal.
        scores: (hasScoreChanges && assignmentRow && scale.ready) ? {
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
      saverRef.current.remove({ immediate: true });
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
      saverRef.current.remove({ immediate: true });
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

  // Descriptor view: order rows by criterion.position → mapped topic; topics with
  // no criterion fall after. Built only when a rubric is attached.
  const topicById = Object.fromEntries(topics.map(t => [t.id, t]));
  const critByTopic = Object.fromEntries((rubric?.topicByCriterion || []).map(m => [m.topic_id, m.criterion_id]));
  const orderedCrit = (rubric?.criteria || []).slice().sort((a, b) => a.position - b.position);
  const descriptorRows = [
    ...orderedCrit.map(c => {
      const m = (rubric?.topicByCriterion || []).find(x => x.criterion_id === c.id);
      const tid = m?.topic_id;
      return tid && topicById[tid] ? { topic: topicById[tid], criterion: c } : null;
    }).filter(Boolean),
    ...topics.filter(t => !critByTopic[t.id]).map(t => ({ topic: t, criterion: null })),
  ];
  const cellStateFor = (topicId, l) => {
    const currentGrade = student.scores[topicId]?.grade || null;
    const pendingGrade = pending[topicId] ?? null;
    const suggestedLevel = suggestedByTopic[topicId] || null;
    return {
      final: l === currentGrade && pendingGrade == null,
      draft: pendingGrade !== REMOVE && l === pendingGrade,
      staged: pendingGrade === REMOVE && l === currentGrade,
      suggested: suggestedLevel != null && l === suggestedLevel,
    };
  };
  const showDescriptors = viewMode === 'descriptors' && !!rubric;

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
        {saveResult === 'saved' && (
          <span className="badge badge-green" style={{ fontSize: '0.68rem' }}>Saved ✓</span>
        )}
        {saveResult?.startsWith('error') && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }}>{saveResult}</span>
        )}
        {/* Right-aligned control cluster — pins the review/resubmit pills to the
            card's right edge so they sit on the same vertical plane across every
            card regardless of student-name length. */}
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        {/* Review flag (#20) — Prism-local; never part of a Schoology save.
            Control and badge live together here in the card header. */}
        {reviewFlag ? (
          <HeaderPill
            active
            accent="var(--badge-amber-text)"
            activeBg="var(--badge-amber-bg)"
            activeText="var(--badge-amber-text)"
            icon="⚑"
            label={`Review: ${reviewFlag.flag_reason}`}
            clearLabel="Clear review flag"
            onClick={handleClearReviewFlag}
            busy={flagBusy}
          />
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
          <HeaderPill
            accent="var(--badge-amber-text)"
            icon="⚑"
            label="Flag for review"
            onClick={() => setShowFlagInput(true)}
          />
        )}
        {/* Resubmission flag (#49, Part A) — a Prism-local reminder that the
            teacher has asked this student to resubmit. There's no agreed Schoology
            channel for the request yet, so it's a teacher-to-student arrangement;
            the flag just stops the teacher forgetting. Never part of a Schoology save. */}
        {resubmitFlag ? (
          <HeaderPill
            active
            accent="var(--resubmit-ring)"
            activeBg="var(--badge-resubmit-bg)"
            activeText="var(--badge-resubmit-text)"
            icon="⟳"
            label="Resubmission requested"
            clearLabel="Clear re-submit request"
            onClick={handleClearResubmit}
            busy={resubmitBusy}
          />
        ) : (
          <HeaderPill
            accent="var(--resubmit-ring)"
            icon="⟳"
            label="Ask to resubmit"
            onClick={handleRequestResubmit}
            busy={resubmitBusy}
          />
        )}
        {/* Detected resubmission (#49, Part B) — the student submitted new work
            since this was last graded. Prominent + amber because it's an
            actionable "regrade me" signal, distinct from the teacher's request. */}
        {student.resubmitted && (
          <span
            title="The student submitted new work after this was last graded — review and update the grade."
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              height: '1.8rem', boxSizing: 'border-box', padding: '0 0.7rem',
              borderRadius: 999, fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap',
              background: 'var(--warning-light)', color: 'var(--warning)',
              border: '2px solid var(--warning)',
            }}
          >
            ⚠ Ungraded resubmission — review
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
      </div>

      {/* Rubric grid */}
      <div style={{
        overflowX: 'auto', padding: '0.75rem 1rem 0',
        opacity: isRubricLocked ? 0.45 : 1,
        pointerEvents: isRubricLocked ? 'none' : 'auto',
      }}>
        {showDescriptors ? (
          <RubricDescriptorGrid
            rows={descriptorRows}
            levels={LEVELS}
            cellState={cellStateFor}
            onSelect={selectLevel}
            palette={rubricPalette}
            levelHeaderColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].headerFill]))}
            levelBorderColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].finalBorder]))}
            levelDraftColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].draftFill]))}
          />
        ) : (
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
                  background: LEVEL_COLORS[l].headerFill, color: CELL_TEXT,
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
              const suggestedLevel = suggestedByTopic[t.id] || null;

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
                    const c = LEVEL_COLORS[l];
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
                      // Draft reads as "tentative": a DASHED border (vs the final's
                      // solid border) plus a very faint fill. The dashed style is the
                      // distinct indicator that separates draft from final without
                      // colliding with the violet/red dashed *outlines* used for
                      // suggestions/removals (those are outline, not border).
                      cellStyle = {
                        ...cellStyle, background: c.draftFill,
                        border: `2px dashed ${c.draftBorder}`,
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
                        ...(stagedRemoval ? {} : { outline: `1px dashed ${SUGGEST.ring}`, outlineOffset: '-3px' }),
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
                        {isSuggested && !stagedRemoval && (
                          <span style={{
                            position: 'absolute', top: 1, right: 3, lineHeight: 1,
                          }}><AiSparkle size={11} style={{ color: 'var(--ai-suggest)' }} /></span>
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
        )}
      </div>

      {/* Consolidated AI suggestion block: reviewer flags (uncollapsed) →
          expandable Strengths/Suggestions analysis → narrative → footer actions.
          Placed between the rubric grid and the Overall Comment. */}
      {hasSuggestionBlock && (
        <div style={{
          margin: '0.75rem 1rem 0', border: '1px solid #e6e1f3', background: '#faf9fd',
          borderRadius: 7, padding: '0.5rem 0.65rem',
        }}>
          <div style={{
            fontSize: '0.63rem', fontWeight: 600, color: '#9a90b8',
            letterSpacing: '0.03em', marginBottom: '0.4rem',
            display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}>
            <AiSparkle size={12} style={{ color: 'var(--ai-suggest)' }} /> Suggested feedback
          </div>

          {reviewerFlags && (
            <div style={{
              border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
              padding: '0.45rem 0.6rem', marginBottom: '0.5rem',
            }}>
              <div style={{
                fontSize: '0.72rem', fontWeight: 600, color: '#92740f',
                display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem',
              }}>
                ⚑ Reviewer flags
              </div>
              <div style={{ fontSize: '0.72rem', lineHeight: 1.5, color: '#5a4a1f', whiteSpace: 'pre-wrap' }}>
                {reviewerFlags}
              </div>
            </div>
          )}

          {showFullAnalysis && hasAnalysis && (
            <div style={{ marginBottom: '0.5rem' }}>
              {strengths.length > 0 && (
                <div style={{ marginBottom: suggestions.length > 0 ? '0.4rem' : 0 }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#716b85', marginBottom: '0.2rem' }}>
                    Strengths
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', lineHeight: 1.45, color: '#716b85' }}>
                    {strengths.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
              {suggestions.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#716b85', marginBottom: '0.2rem' }}>
                    Suggestions
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', lineHeight: 1.45, color: '#716b85' }}>
                    {suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {narrativeSuggestion && (
            <div style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#716b85', whiteSpace: 'pre-wrap' }}>
              {narrativeSuggestion}
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            gap: '0.5rem', marginTop: '0.55rem',
          }}>
            {hasAnalysis && (
              <button
                type="button"
                onClick={() => setShowFullAnalysis(v => !v)}
                style={{
                  borderRadius: 7, padding: '0.35rem 0.6rem', fontSize: '0.72rem',
                  fontWeight: 600, cursor: 'pointer',
                  background: 'var(--card-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                }}
              >
                {showFullAnalysis ? '▴ Hide full analysis' : '▾ Show full analysis'}
              </button>
            )}
            {narrativeSuggestion && (
              <button
                onClick={() => applyComment(normalizePastedText(narrativeSuggestion))}
                title="Copy the suggestion down into your comment"
                style={{
                  borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
                  fontWeight: 600, cursor: 'pointer',
                  background: 'var(--ai-suggest-wash)', color: 'var(--ai-suggest)', border: '1px solid var(--ai-suggest)',
                }}
              >
                ↓ Use suggestion
              </button>
            )}
          </div>
        </div>
      )}

      {/* Overall Comment — the hero */}
      <div style={{ padding: '0.75rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.35rem' }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 700, color: '#333' }}>
            Overall Comment
          </label>
          {/* Published-status indicator — verified against the synced DB value. */}
          {commentPublished && (
            <span style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--success)' }}>
              ✓ Published to Schoology
            </span>
          )}
          {commentDirty && (
            <span style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--warning)' }}>
              ● Draft - not published
            </span>
          )}
        </div>
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
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box',
            // Border encodes publish state: green = published (matches Schoology),
            // amber = unsaved edit, grey = empty/clean.
            border: `1.5px solid ${commentDirty ? 'var(--warning)' : commentPublished ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: 8, padding: '0.6rem', fontSize: '0.84rem', lineHeight: 1.45,
            fontFamily: 'inherit', resize: 'vertical', color: 'var(--text)',
          }}
          placeholder="Teacher comment for this student on this assessment..."
        />

        {/* Control band — directly under the comment (creates the focus boundary) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
          {/* Display-to-student: eye icon + switch, no text label */}
          <button
            type="button"
            role="switch"
            aria-checked={display}
            aria-label="Display to student"
            title="Display to student"
            onClick={() => applyDisplay(!display)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              alignSelf: 'stretch', boxSizing: 'border-box',
              border: '1px solid var(--border)', borderRadius: 7,
              padding: '0 0.55rem', background: 'var(--card-bg)',
              color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none',
              font: 'inherit',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
            </svg>
            <span style={{
              position: 'relative', width: 28, height: 16, borderRadius: 9,
              background: display ? 'var(--accent)' : 'var(--bg-subtle)',
              border: '1px solid var(--border)', transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 1, left: display ? 13 : 1,
                width: 12, height: 12, borderRadius: '50%', background: '#fff',
                boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s',
              }} />
            </span>
          </button>

          <button
            className="primary"
            onClick={handleSave}
            disabled={saving || !hasPendingChanges || !scale.ready}
            title="Publish scores & comment to Schoology"
          >
            {saving ? 'Publishing...' : 'Publish to Schoology'}
          </button>

          {/* Discard — undo arrow + label, always shown, disabled when nothing pending.
              A wider labelled target is easier to hit than the old icon-only button.
              Red accent when active so it reads as "revert / destructive". */}
          <button
            onClick={discardChanges}
            disabled={!hasPendingChanges}
            aria-label="Discard changes"
            title={hasPendingChanges ? 'Discard changes' : 'Discard changes (nothing to discard)'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              alignSelf: 'stretch', boxSizing: 'border-box',
              padding: '0 0.7rem', borderRadius: 7,
              border: `1px solid ${hasPendingChanges ? 'var(--danger)' : 'var(--border)'}`,
              background: hasPendingChanges ? 'var(--danger-bg)' : 'var(--card-bg)',
              color: hasPendingChanges ? 'var(--danger)' : 'var(--border)',
              cursor: hasPendingChanges ? 'pointer' : 'default',
              fontSize: '0.85rem', fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            Discard Changes
          </button>

          {/* Pending-change count — sits immediately right of Discard. Counts
              rubric edits + comment + visibility toggle. */}
          {pendingCount > 0 && (
            <span className="badge" style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.72rem' }}>
              {pendingCount} pending change{pendingCount !== 1 ? 's' : ''}
            </span>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Reviewer Analysis drawer body ────────────────────────────────────────────

function ReviewerAnalysisBody({ topics, feedbackRows, analysis }) {
  const dist = distributionByTopic(feedbackRows, topics);
  const noticings = analysis?.noticings || [];
  const moderationNote = analysis?.moderation_note || null;

  return (
    <div style={{ padding: '0.8rem' }}>
      {/* Proposed score distribution */}
      <div style={{ marginBottom: '0.9rem' }}>
        <div style={{
          fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.15rem',
          display: 'flex', alignItems: 'center', gap: '0.3rem',
        }}>
          <AiSparkle size={11} style={{ color: 'var(--ai-suggest)' }} />
          Proposed score distribution
        </div>
        <div style={{ fontSize: '0.6rem', color: '#9a90b8', marginBottom: '0.4rem' }}>
          From the reviewer's suggested grades — not final entered scores.
        </div>
        {topics.map(t => {
          const counts = dist[t.id] || { ED: 0, EX: 0, D: 0, EM: 0, IE: 0 };
          const total = LEVELS.reduce((sum, l) => sum + counts[l], 0);
          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.35rem' }}>
              <div style={{ width: 70, fontSize: '0.64rem', fontWeight: 600, flexShrink: 0 }}>{t.title}</div>
              <div style={{
                flex: 1, display: 'flex', height: 18, borderRadius: 4,
                overflow: 'hidden', border: '1px solid var(--border)',
                background: 'var(--bg-subtle)',
              }}>
                {total > 0 && LEVELS.filter(l => counts[l] > 0).map(l => {
                  const showLabel = counts[l] / total >= 0.12;
                  return (
                    <div key={l} title={`${counts[l]} ${l}`} style={{
                      flex: counts[l], display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.56rem', fontWeight: 700, color: CELL_TEXT,
                      background: LEVEL_COLORS[l].headerFill,
                    }}>
                      {showLabel ? `${counts[l]} ${l}` : counts[l]}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {moderationNote && (
          <div style={{
            fontSize: '0.62rem', color: '#92740f', background: '#fffbef',
            border: '1px solid #f0dea8', borderRadius: 6, padding: '0.35rem 0.5rem',
            marginTop: '0.45rem', lineHeight: 1.35,
          }}>
            ⚖️ {moderationNote}
          </div>
        )}
      </div>

      {/* Noticings */}
      {noticings.length > 0 && (
        <div>
          <div style={{
            fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.45rem',
          }}>
            Noticings
          </div>
          {noticings.map((n, i) => (
            <div key={i} style={{ marginBottom: '0.55rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.68rem', marginBottom: '0.12rem' }}>{n.title}</div>
              <div style={{ fontSize: '0.66rem', lineHeight: 1.4, color: 'var(--text)' }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AssessmentSummaryPage() {
  const { id: courseId, assignmentId } = useParams();
  const dataVersion = useDataVersion();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);
  const [feedbackByStudent, setFeedbackByStudent] = useState({});
  const [draftByStudent, setDraftByStudent] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Attached rubric + reporting-category colour palette for this assignment (Task 13).
  // rubricData: { id, rubric:{...criteria...}, topicByCriterion:[...] } | null.
  // viewMode toggles the per-card grid between descriptor prose and the compact
  // level table; defaults to Descriptors (the richer, student-language view).
  const [rubricData, setRubricData] = useState(null);
  const [rubricPalette, setRubricPalette] = useState({});
  const [viewMode, setViewMode] = useState('descriptors');
  const [rubricModalOpen, setRubricModalOpen] = useState(false);
  const reloadRubric = async () => setRubricData(await getRubricForAssignment(assignmentId));

  // "Send all" bar state (#51). pendingByUid maps each card's uid → true while
  // it has unsaved changes; cardsRef holds each card's { getEntry, applyResult }
  // so the batch can collect entries and report results back per card.
  const [pendingByUid, setPendingByUid] = useState({});
  // Per-card visibility (display-to-student) reported up so the bulk bar's
  // "show all" toggle can reflect the class-wide aggregate.
  const [displayByUid, setDisplayByUid] = useState({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  // "Discard all" is destructive across every student, so it requires a second
  // confirming click (armed → confirm). Disarms on mouse-leave or after firing.
  const [discardAllArmed, setDiscardAllArmed] = useState(false);
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
  const handleDisplayChange = useCallback((uid, vis) => {
    setDisplayByUid(prev => (prev[uid] === vis ? prev : { ...prev, [uid]: vis }));
  }, []);
  const registerCard = useCallback((uid, handlers) => { cardsRef.current[uid] = handlers; }, []);
  const unregisterCard = useCallback((uid) => {
    delete cardsRef.current[uid];
    setPendingByUid(prev => {
      if (!prev[uid]) return prev;
      const next = { ...prev }; delete next[uid]; return next;
    });
    setDisplayByUid(prev => {
      if (!(uid in prev)) return prev;
      const next = { ...prev }; delete next[uid]; return next;
    });
  }, []);

  const totalPending = Object.keys(pendingByUid).length;

  // Class-wide visibility aggregate for the bulk "show all to students" toggle.
  const visUids = Object.keys(displayByUid);
  const visibleCount = visUids.filter(u => displayByUid[u]).length;
  const allVisible = visUids.length > 0 && visibleCount === visUids.length;
  const noneVisible = visibleCount === 0;
  const mixedVisible = !allVisible && !noneVisible;

  // Push a visibility value to every card (each marks itself pending only if the
  // value differs from its synced state). Used by the bulk toggle.
  function handleSetAllVisible(value) {
    for (const uid of Object.keys(cardsRef.current)) cardsRef.current[uid]?.setDisplay?.(value);
  }

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
      setBulkResult(`Published ${ok} grade${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`);
    } catch (err) {
      // All-or-nothing: a non-2xx (incl. the 502 abort) rejects here — mark every
      // card failed and leave them pending so a retry is one click away.
      for (const i of items) cardsRef.current[i.uid]?.applyResult(false);
      setBulkResult(`Error: ${err.message}`);
    } finally {
      setBulkSaving(false);
    }
  }

  // Revert every card with unsaved changes back to its synced state (#51 sibling
  // of Send all). First click arms a confirm; the second click actually discards.
  // Each pending card discards its own local draft; the cards' pending-change
  // reports then clear pendingByUid.
  function handleDiscardAll() {
    if (Object.keys(pendingByUid).length === 0) return;
    if (!discardAllArmed) { setDiscardAllArmed(true); return; }
    setDiscardAllArmed(false);
    for (const uid of Object.keys(pendingByUid)) cardsRef.current[uid]?.discard?.();
    setBulkResult(null);
  }

  function load() {
    setLoading(true);
    Promise.all([
      getMasteryForAssignment(courseId, assignmentId),
      getFeedbackForAssignment(assignmentId).catch(() => ({})),
      getAssessmentAnalysis(assignmentId).catch(() => null),
      getDraftsForAssignment(assignmentId).catch(() => ({})),
    ])
      .then(([mastery, feedback, analysisRow, drafts]) => {
        setData(mastery);
        setFeedbackByStudent(feedback || {});
        setAnalysis(analysisRow || null);
        setDraftByStudent(drafts || {});
      })
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

  useEffect(load, [courseId, assignmentId, dataVersion]);

  // Load the attached rubric + the reporting-category colour palette (Task 13).
  // Best-effort: a missing rubric / config failure leaves the page in compact-
  // capable state with no descriptors, never blocking the grade grid.
  useEffect(() => {
    let active = true;
    getRubricForAssignment(assignmentId).then(r => active && setRubricData(r)).catch(() => {});
    getRubricConfig().then(c => active && setRubricPalette(c.reportingCategoryColors || {})).catch(() => {});
    return () => { active = false; };
  }, [assignmentId]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  const { assignment, topics, students } = data;
  const hasAnalysis = Object.keys(feedbackByStudent).length > 0 || !!analysis;

  const alignedTopics = topics;

  return (
    <div className="fade-in">
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)',
        marginBottom: '1.25rem', padding: '0.55rem 0',
        borderBottom: '1px solid var(--border)',
      }}>
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
          {/* Jump straight to this assignment's Schoology page (#76). Hidden when
              Schoology didn't return a web_url for the assignment. */}
          <SchoologyLink
            url={assignment.web_url}
            label="View in Schoology"
            style={{ fontSize: '0.78rem' }}
          />
          <button
            className="primary"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-pull scores & comments from Schoology"
            style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {refreshing ? 'Refreshing...' : 'Refresh from Schoology'}
          </button>
          {refreshResult && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>{refreshResult}</span>
          )}

          {/* Rubric view toggle (Task 13) — Descriptors (default) shows the
              student-language descriptor prose per level; Compact falls back to
              the dense level-code table. */}
          <div role="group" aria-label="Rubric view" style={{ display: 'inline-flex', gap: '0.25rem' }}>
            <button className={`filter-btn${viewMode === 'descriptors' ? ' active' : ''}`}
              onClick={() => setViewMode('descriptors')}>Descriptors</button>
            <button className={`filter-btn${viewMode === 'compact' ? ' active' : ''}`}
              onClick={() => setViewMode('compact')}>Compact</button>
          </div>

          {/* Single entry point to the rubric hub (attach existing / upload / map / reorder / delete). */}
          <button className="secondary" style={{ fontSize: '0.78rem' }}
            onClick={() => setRubricModalOpen(true)}>Manage rubrics…</button>

          {hasAnalysis && (
            <button
              onClick={() => setDrawerOpen(true)}
              title="Reviewer Analysis — not student-facing"
              style={{
                marginLeft: 'auto', border: '1px solid var(--ai-suggest)', background: 'var(--ai-suggest-wash)',
                color: 'var(--ai-suggest)', borderRadius: 7, padding: '0.32rem 0.7rem',
                fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              }}
            >
              <AiSparkle size={14} style={{ color: 'var(--ai-suggest)' }} />
              Reviewer Analysis
            </button>
          )}
        </div>
      </div>

      {students.length === 0 ? (
        <div className="card">
          <p className="text-muted">No students found. Run a mastery sync for this course first.</p>
        </div>
      ) : (
        <>
          {students.map((student) => (
            <StudentRubricCard
              key={student.schoology_uid}
              student={student}
              topics={alignedTopics}
              courseId={courseId}
              assignmentId={assignmentId}
              assignmentRow={assignment}
              feedbackRow={feedbackByStudent[student.id] || null}
              draftRow={draftByStudent[student.id] || null}
              rubric={rubricData ? { ...rubricData.rubric, topicByCriterion: rubricData.topicByCriterion } : null}
              viewMode={viewMode}
              rubricPalette={rubricPalette}
              onSaved={handleCardSaved}
              onPendingChange={handlePendingChange}
              onDisplayChange={handleDisplayChange}
              registerCard={registerCard}
              unregisterCard={unregisterCard}
            />
          ))}

          {/* Whole-class command bar (#51) — sticky so it stays reachable during
              a fast grading run. Deliberately styled distinct from the white
              per-card control bands (subtle surface + accent stripe + "Whole
              class" label) so it can't be mistaken for a single card's buttons
              when it sits just above one. zIndex sits above the rubric cells
              (z-index 2), which would otherwise paint over it while scrolling. */}
          <div style={{
            position: 'sticky', bottom: 0, zIndex: 10, marginTop: '0.85rem',
            padding: '0.7rem 1rem 0.7rem 0.85rem',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)', borderLeft: '4px solid var(--accent)',
            borderRadius: 10, boxShadow: '0 -3px 14px rgba(0,0,0,0.12)',
            display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap',
          }}>
            {/* Show-all-to-students toggle — same eye+switch visual as the per-card
                control, with a label + aggregate state (all / none / mixed) so it
                reads as the class-wide version. */}
            <button
              type="button"
              role="switch"
              aria-checked={allVisible ? 'true' : mixedVisible ? 'mixed' : 'false'}
              aria-label="Grade visibility for all students"
              title="Toggle whether every student sees their grade & comment in Schoology"
              onClick={() => handleSetAllVisible(!allVisible)}
              disabled={bulkSaving}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                boxSizing: 'border-box', height: '2rem',
                border: '1px solid var(--border)', borderRadius: 7,
                padding: '0 0.6rem', background: 'var(--card-bg)',
                color: 'var(--text-muted)', cursor: bulkSaving ? 'default' : 'pointer',
                userSelect: 'none', fontSize: '0.78rem', fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
              <span style={{
                position: 'relative', width: 28, height: 16, borderRadius: 9,
                background: allVisible ? 'var(--accent)' : mixedVisible ? 'var(--warning)' : 'var(--bg-subtle)',
                border: '1px solid var(--border)', transition: 'background 0.15s',
              }}>
                <span style={{
                  position: 'absolute', top: 1, left: allVisible ? 13 : mixedVisible ? 7 : 1,
                  width: 12, height: 12, borderRadius: '50%', background: '#fff',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                }} />
              </span>
              {/* Status label — describes the CURRENT class-wide visibility state
                  (the switch position carries the on/off meaning). Fixed width so
                  switching text never shifts neighbours. */}
              <span style={{ display: 'inline-block', width: '4.6rem', textAlign: 'left', whiteSpace: 'nowrap' }}>
                {allVisible ? 'All shown' : noneVisible ? 'All hidden' : 'Mixed'}
              </span>
            </button>

            <button
              className="primary"
              onClick={handleSendAll}
              disabled={bulkSaving || totalPending === 0}
            >
              {bulkSaving
                ? 'Publishing...'
                : totalPending > 0
                  ? `Publish all to Schoology (${totalPending})`
                  : 'Publish all to Schoology'}
            </button>
            <button
              onClick={handleDiscardAll}
              onMouseLeave={() => setDiscardAllArmed(false)}
              disabled={bulkSaving || totalPending === 0}
              title="Discard all unsaved changes across every student"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.4rem 0.75rem', borderRadius: 7,
                border: `1px solid ${totalPending > 0 ? 'var(--danger)' : 'var(--border)'}`,
                background: discardAllArmed ? 'var(--danger)' : (totalPending > 0 ? 'var(--danger-bg)' : 'var(--card-bg)'),
                color: discardAllArmed ? '#fff' : (totalPending > 0 ? 'var(--danger)' : 'var(--border)'),
                cursor: (totalPending > 0 && !bulkSaving) ? 'pointer' : 'default',
                fontSize: '0.8rem', fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {discardAllArmed ? 'Click again to confirm' : 'Discard all'}
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

      {drawerOpen && (
        <>
          <div
            aria-hidden="true"
            data-testid="reviewer-analysis-scrim"
            onClick={() => setDrawerOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,30,0.28)', zIndex: 40 }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reviewer-analysis-title"
            style={{
            position: 'fixed', top: 0, right: 0, height: '100%', width: 360,
            background: 'var(--card-bg)', boxShadow: '-6px 0 20px rgba(0,0,0,0.16)',
            zIndex: 50, overflowY: 'auto',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.65rem 0.85rem', borderBottom: '1px solid var(--border)',
              background: 'var(--bg-subtle)', position: 'sticky', top: 0,
            }}>
              <AiSparkle size={13} style={{ color: 'var(--ai-suggest)' }} />
              <span id="reviewer-analysis-title" style={{ fontWeight: 700, fontSize: '0.84rem' }}>Reviewer Analysis</span>
              <span style={{
                fontSize: '0.58rem', background: 'var(--bg-subtle)', color: 'var(--text-muted)',
                borderRadius: 5, padding: '1px 5px', fontWeight: 600,
              }}>not student-facing</span>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close Reviewer Analysis"
                style={{
                  marginLeft: 'auto', cursor: 'pointer', color: 'var(--text-muted)',
                  fontSize: '1.05rem', lineHeight: 1, border: 'none', background: 'none',
                }}
              >✕</button>
            </div>
            <ReviewerAnalysisBody
              topics={topics}
              feedbackRows={Object.values(feedbackByStudent)}
              analysis={analysis?.analysis_parsed || null}
            />
          </div>
        </>
      )}

      <RubricManagerModal
        open={rubricModalOpen}
        onClose={() => setRubricModalOpen(false)}
        courseId={courseId}
        assignmentId={assignmentId}
        topics={alignedTopics}
        attachment={rubricData}
        onChanged={reloadRubric}
      />
    </div>
  );
}
