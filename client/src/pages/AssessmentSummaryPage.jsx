import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { getMasteryForAssignment, getSubmissionLinks, setSuggestionState, getFeedbackForAssignment, getAssessmentAnalysis, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag, getRubricForAssignment, getRubricConfig, getDraftsForAssignment, getSettings } from '../services/api.js';
import { draftBaseline } from '../lib/assessmentDraft.js';
import { makeDraftSaver } from '../lib/assessmentDraftSaver.js';
import { resolveRubricScores, distributionByTopic } from '../lib/rubricSuggestions.js';
import { studentFullName } from '../lib/studentNames.js';
import { useDataVersion } from '../hooks/useDataVersion.jsx';
import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';
import { useProficiencyScale } from '../hooks/useProficiencyScale.js';
import RubricDescriptorGrid from '../components/RubricDescriptorGrid.jsx';
import ResubmitControl from '../components/ResubmitControl.jsx';
import RubricManagerModal from '../components/RubricManagerModal.jsx';
import AiSparkle from '../components/AiSparkle.jsx';
import SchoologyLink from '../components/SchoologyLink.jsx';
import SubmissionStatusPill from '../components/SubmissionStatusPill.jsx';
import ScaleLevelPicker from '../components/ScaleLevelPicker.jsx';
import AssessmentFilterBar from '../components/AssessmentFilterBar.jsx';
import { passesFilters } from '../lib/assessmentFilters.js';
import { useStickyTab } from '../hooks/useStickyTab.js';
import { formatDateTime } from '../lib/formatDate.js';
import { briefFlags, textSignature } from '../lib/reviewerFlags.js';
import { receivedLine, composeComment } from '../lib/statusLines.js';

const EXCEPTION_LABELS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing', 4: 'Late' };
// Suggestion accent — fuchsia CSS tokens (matches descriptor grid's --ai-suggest).
const SUGGEST = { fill: 'var(--ai-suggest-wash)', ring: 'var(--ai-suggest)', glyph: 'var(--ai-suggest)' };
// Sentinel stored in pending[topicId] to stage a synced final for removal (Slice 2).
const REMOVE = '__remove__';
// pending key for a score-scale grade (#41): an unaligned assignment graded on
// a plain Schoology scale has one level for the whole assignment, not per topic.
const SCALE = '__scale__';

// The card's resubmission fields after a save (final review I2): the save routes
// return the pair's post-save state (resubmissionFields — what the server decided
// after snapshotting the save and settling an answered request), so patch exactly
// that. A hidden-only, unchanged or received-line-only save keeps an arrival
// Arrived. Unknown (null/absent — the server could not read it) → leave the card's
// fields alone rather than guess.
export function resubmissionFieldsPatch(fields) {
  if (!fields) return {};
  return {
    resubmission: fields.resubmission ?? null,
    resubmit_flag: fields.resubmit_flag ?? null,
    resubmitted: Boolean(fields.resubmitted),
    arrived_on: fields.arrived_on ?? null,
  };
}

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

// Is `line` still (verbatim) the comment's first line? Mirrors the exact-text
// check composeComment/write-comment use, so a save only sends statusLine when
// the teacher hasn't edited it away (triage resubmissions, Amendment B Task 7).
function topLineIs(text, line) {
  if (!line) return false;
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  return t === line || t.startsWith(`${line}\n`);
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

export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow, draftRow = null, rubric = null, viewMode = 'descriptors', rubricPalette = {}, submissionLink = null, scoreScale = null, resubmitLessonsDefault = 3, resubmitEnabled = true, highlight = false, onSaved, onPendingChange, onDisplayChange, registerCard, unregisterCard }) {
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
  // Flags at a glance: the agent's brief lines, or the first sentence of each
  // flag; the full text sits behind "Show detailed flags" (showFullAnalysis).
  const { items: flagBrief, hasMore: flagsHaveMore } = briefFlags(reviewerFlags, feedbackRow?.feedback_parsed?.reviewer_flags_brief);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);
  // Whole "Reviewer notes" block collapse. Expanded by default; persists per
  // student+assignment in localStorage so a deliberate collapse survives reloads,
  // and auto-collapses once the grade is published. The stored value is the
  // signature of the notes that were collapsed, so NEW notes (an agent re-run)
  // reopen the block by themselves. A legacy '1' stays collapsed.
  const notesKey = `prism:reviewer-notes-collapsed:${assignmentId}:${student.enrollment_id ?? student.id}`;
  const notesSig = textSignature(JSON.stringify(feedbackRow?.feedback_parsed ?? {}));
  const [notesStored, setNotesStored] = useState(() => {
    try { return localStorage.getItem(notesKey); } catch { return null; }
  });
  const notesCollapsed = notesStored === '1' || notesStored === notesSig;
  const setNotesCollapsed = (v) => {
    const value = v ? notesSig : '0';
    setNotesStored(value);
    try { localStorage.setItem(notesKey, value); } catch { /* ignore */ }
  };
  // How the teacher handled the suggested-feedback narrative, kept on the
  // server (feedback.suggestion_state) so it holds across devices: 'used' and
  // 'ignored' fold the box to one line; 'revised' (an agent re-run changed a
  // handled narrative) shows it again, tagged. A used-marker this browser kept
  // before the server did still counts (read-only).
  const narrativeSig = narrativeSuggestion ? textSignature(narrativeSuggestion) : null;
  const [legacyUsedSig] = useState(() => {
    try { return localStorage.getItem(`prism:suggestion-used:${assignmentId}:${student.enrollment_id ?? student.id}`); } catch { return null; }
  });
  const [localSuggestionState, setLocalSuggestionState] = useState(null);
  useEffect(() => { setLocalSuggestionState(null); }, [narrativeSig]);
  const suggestionState = localSuggestionState
    ?? feedbackRow?.suggestion_state
    ?? (narrativeSig != null && legacyUsedSig === narrativeSig ? 'used' : null);
  const suggestionFolded = suggestionState === 'used' || suggestionState === 'ignored';
  const suggestionRevised = suggestionState === 'revised';
  const [showUsedAgain, setShowUsedAgain] = useState(false);
  function handleSuggestion(state) {
    setLocalSuggestionState(state);
    setShowUsedAgain(false);
    if (feedbackRow?.id != null) setSuggestionState(feedbackRow.id, state).catch(() => {});
  }
  function ignoreSuggestion() {
    handleSuggestion('ignored');
  }
  function applySuggestion() {
    applyComment(normalizePastedText(narrativeSuggestion));
    handleSuggestion('used');
  }

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
  // The exact "resubmission received" line last inserted by the chip (triage
  // resubmissions, Amendment B Task 7), or null until the chip is clicked. Save
  // sends statusLine only while this is still (verbatim) the draft's first line —
  // an edit away from it means the teacher doesn't want it published.
  // A restored draft (#47) can already have the line on top — from an earlier
  // visit that clicked the chip but didn't save — so treat that as "inserted"
  // too (I3): otherwise a save would silently omit statusLine, and clicking the
  // chip again would stack a second copy on top of the first.
  const [insertedLine, setInsertedLine] = useState(() => {
    if (student.resubmission?.state !== 'arrived' || !student.arrived_on) return null;
    const line = receivedLine({ on: student.arrived_on });
    return topLineIs(comment, line) ? line : null;
  });
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
  const stageRef = useRef(null);
  stageRef.current = stageScaleLevel;
  const acceptRef = useRef(null);
  acceptRef.current = acceptScaleSuggestion;

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
      stageScaleLevel: (code) => stageRef.current(code),
      acceptScaleSuggestion: () => acceptRef.current(),
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

  // Chip (triage resubmissions, Amendment B Task 7): insert a fresh "resubmission
  // received" line at the top of the draft, replacing whatever line is there —
  // the line this chip inserted last (if the teacher hasn't saved since), else
  // the line Prism last actually published (student.status_line). Visible and
  // editable; nothing is saved until the teacher publishes.
  function insertReceivedLine() {
    if (!student.arrived_on) return;
    const line = receivedLine({ on: student.arrived_on });
    const stored = insertedLine ?? (student.status_line?.line || '');
    flushNextRef.current = true;
    applyComment(composeComment(comment, stored, line));
    // A published status line is always visible to the student (global rule) —
    // force it on rather than relying on auto-flip, which only fires once from
    // a virgin empty comment.
    applyDisplay(true);
    setInsertedLine(line);
  }

  // Ask / Extend / Grade stands / Undo on this card (final review I1). Each may have
  // changed the student's Schoology comment (published or removed a status line), so
  // patch the card's stored comment, Display and status_line to match — and rebase the
  // editor, or the next Save would PUT the stale text and erase the published line. An
  // unsaved draft keeps the teacher's edits with the line swapped at the top
  // (composeComment against the line on top now); a clean editor takes the comment
  // Schoology now holds.
  // extra: other card fields the action changed (an Ask's unsubmit → the work is in progress).
  function handleResubmitChange(resubmission, commentChange = null, extra = null) {
    const patch = { resubmission, resubmit_flag: resubmission?.request ? { id: resubmission.request.id } : null, ...(extra || {}) };
    if (commentChange) {
      const newLine = commentChange.line || '';
      if (commentDirty) {
        const onTop = topLineIs(comment, insertedLine) ? insertedLine : (student.status_line?.line || null);
        setComment(composeComment(comment, onTop, newLine));
      } else {
        setComment(commentChange.comment);
      }
      setInsertedLine(null);
      flushNextRef.current = true;
      patch.grade_comment = commentChange.comment;
      patch.status_line = newLine ? { line: newLine, kind: commentChange.kind } : null;
      if (newLine) {
        // Publishing always turns Display on in Schoology (a status line must be visible).
        patch.comment_status = 1;
        setDisplay(true);
        setAutoFlipArmed(false);
      }
    }
    onSaved?.(student.schoology_uid, patch);
  }

  // { statusLine, statusLineKind } for the write-comment/send-all payload, only
  // while the inserted line is still (verbatim) the draft's first line — an edit
  // away from it means don't record it as Prism's published status line.
  function statusLineFields() {
    return topLineIs(comment, insertedLine) ? { statusLine: insertedLine, statusLineKind: 'received' } : {};
  }

  // { status_line: { line, kind } } for the in-place onSaved/getEntry patch, so
  // the card's own student prop reflects what was actually published — without
  // this a re-render after save would still show the pre-save status_line (or
  // null), and a second insert would compose against stale text.
  function statusLinePatch() {
    const f = statusLineFields();
    return f.statusLine ? { status_line: { line: f.statusLine, kind: f.statusLineKind } } : {};
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

  // Score-scale level click (#41). Clicking the synced level (or the pending
  // one) drops the pending choice; there is no "clear the grade" from Prism.
  function selectScaleLevel(code) {
    if (isRubricLocked) return;
    flushNextRef.current = true;
    if (code === student.scale_level || code === pending[SCALE]) {
      setPending(p => { const n = { ...p }; delete n[SCALE]; return n; });
      return;
    }
    armAutoFlip();
    setPending(p => ({ ...p, [SCALE]: code }));
  }

  // Whole-class "Mark all …" (#41): stage `code` only on a card with no grade,
  // no pending choice and no locking exception. Returns whether it staged.
  function stageScaleLevel(code) {
    if (!scoreScale || isRubricLocked || student.scale_level != null || pending[SCALE] != null) return false;
    selectScaleLevel(code);
    return true;
  }

  const scalePointsFor = (code) => scoreScale?.levels.find(l => l.code === code)?.points ?? null;

  // An agent's scale-level suggestion (PrisMCP write_student_suggestions
  // scale_level, #41) + its evidence note. Accepting only stages it.
  const suggestedScale = scoreScale ? (feedbackRow?.feedback_parsed?.scale_level ?? null) : null;
  const suggestedScaleLabel = scoreScale?.levels.find(l => l.code === suggestedScale)?.label ?? null;
  const scaleEvidence = suggestedScale ? (feedbackRow?.feedback_parsed?.evidence ?? null) : null;
  function acceptScaleSuggestion() {
    if (!suggestedScaleLabel || isRubricLocked) return false;
    if (suggestedScale === student.scale_level || pending[SCALE] != null) return false;
    selectScaleLevel(suggestedScale);
    return true;
  }

  // Revert all of this card's unsaved changes back to the synced Schoology
  // state. Shared by the per-card Discard button and the page-level Discard all.
  function discardChanges() {
    flushNextRef.current = true;
    setPending({});
    setComment(student.grade_comment || '');
    setInsertedLine(null);
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
    const scaleCode = scoreScale ? (pending[SCALE] ?? null) : null;
    const hasScoreChanges = !scoreScale && Object.keys(pending).length > 0;
    const hasCommentChange = comment !== (student.grade_comment || '');
    const hasDisplayChange = display !== loadedDisplay;
    if (!hasScoreChanges && !scaleCode && !hasCommentChange && !hasDisplayChange) return null;
    if (scoreScale) {
      // One PUT carries grade + comment + visibility, so the comment always rides along.
      return {
        entry: {
          uid: student.schoology_uid,
          enrollmentId: student.enrollment_id,
          assignmentId,
          scores: null,
          grade: scaleCode ? { points: scalePointsFor(scaleCode) } : null,
          comment: { comment, commentStatus: display, ...statusLineFields() },
        },
        patch: {
          ...(scaleCode ? { score: scalePointsFor(scaleCode), scale_level: scaleCode } : {}),
          grade_comment: comment, comment_status: display ? 1 : null,
          ...statusLinePatch(),
        },
      };
    }
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
        comment: (hasCommentChange || hasDisplayChange) ? { comment, commentStatus: display, ...statusLineFields() } : null,
      },
      patch: {
        scores: buildSavedScores(), grade_comment: comment, comment_status: display ? 1 : null,
        ...statusLinePatch(),
      },
    };
  }

  // Update this card's own UI after the page's batch lands. The page applies the
  // in-place data patch itself (handleCardSaved) — here we only own the badge,
  // pending reset, and draft clear (mirrors handleSave's success/error tail).
  function applySendResult(ok) {
    if (ok) {
      setSaveResult('saved');
      setPending({});
      setInsertedLine(null);
      saverRef.current.remove({ immediate: true });
      setNotesCollapsed(true); // published via bulk → tuck the reviewer notes away
    } else {
      setSaveResult('error: send failed');
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      const scaleCode = scoreScale ? (pending[SCALE] ?? null) : null;
      const hasScoreChanges = !scoreScale && Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');
      const hasDisplayChange = display !== loadedDisplay;

      if (scoreScale) {
        // Score-scale grade (#41): grade + comment + visibility in one write.
        const saved = await writeMasteryComment(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          comment,
          commentStatus: display,
          ...(scaleCode ? { points: scalePointsFor(scaleCode) } : {}),
          ...statusLineFields(),
        });
        setSaveResult('saved');
        setPending({});
        setInsertedLine(null);
        saverRef.current.remove({ immediate: true });
        onSaved?.(student.schoology_uid, {
          ...(scaleCode ? { score: scalePointsFor(scaleCode), scale_level: scaleCode } : {}),
          grade_comment: comment,
          comment_status: display ? 1 : null,
          ...resubmissionFieldsPatch(saved?.resubmissionFields),
          ...statusLinePatch(),
        });
        setNotesCollapsed(true);
        return true;
      }

      // The pair's post-save resubmission state — from the last write that reported it.
      let fields = null;
      let rubricSaved = false;
      if (hasScoreChanges && assignmentRow) {
        const scored = await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo: buildGradeInfo(),
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        });
        fields = scored?.resubmissionFields ?? fields;
        rubricSaved = true;
      }

      if (hasCommentChange || hasDisplayChange) {
        const saved = await writeMasteryComment(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          comment,
          commentStatus: display,
          ...statusLineFields(),
          // This save wrote the rubric first, so the score Schoology recomputed (echoed by
          // the comment write) is the teacher's change, not a Schoology-side one (round 5).
          // Send all needs no flag: the server knows which entries carried scores.
          ...(rubricSaved ? { rubricSaved: true } : {}),
        });
        fields = saved?.resubmissionFields ?? fields;
      }
      setSaveResult('saved');
      setPending({});
      setInsertedLine(null);
      // Explicit clear: the card stays mounted now, but the write effect runs
      // asynchronously — clear here so a fast bulk run can't race a stale key.
      saverRef.current.remove({ immediate: true });
      onSaved?.(student.schoology_uid, {
        scores: buildSavedScores(),
        grade_comment: comment,
        comment_status: display ? 1 : null,
        ...resubmissionFieldsPatch(fields),
        ...statusLinePatch(),
      });
      setNotesCollapsed(true); // published → tuck the reviewer notes away
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

  const bothSignals = !!student.resubmit_flag && !!student.resubmitted;

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
    <div
      id={`student-card-${student.id}`}
      className={highlight ? 'student-card--highlight' : undefined}
      style={{
        border: bothSignals ? '1px solid var(--resubmit-ring)' : '1px solid var(--border)',
        boxShadow: bothSignals ? '0 0 0 2px var(--badge-resubmit-bg)' : 'none',
        borderRadius: 10,
        // overflow visible so the oversized avatar can pop past the header band
        // (top and bottom) without being clipped. Only the header has a corner-
        // reaching background, so we round its top corners to keep the card edge.
        background: 'var(--card-bg)', overflow: 'visible',
        marginBottom: '1rem',
      }}
    >
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
        <SubmissionStatusPill student={student} assignment={assignmentRow} />
        {/* The student's own OneDrive copy — in progress or submitted (#120). */}
        {submissionLink && (
          <SchoologyLink
            url={submissionLink.url}
            label="Open"
            ariaLabel={`Open ${displayName(student)}'s work in OneDrive`}
            title={`Open ${displayName(student)}'s work in OneDrive: last edited ${formatDateTime(submissionLink.modifiedAt)}`}
            style={{ fontSize: '0.78rem', fontWeight: 600 }}
          />
        )}
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
        {/* Resubmission (triage) — ask with a deadline in school days; each action publishes a
            status line to the student's Schoology comment after a confirm (spec Amendment B).
            Not offered on an archived/excluded course (the server refuses those). */}
        {resubmitEnabled && <ResubmitControl
          student={student}
          assignmentId={assignmentRow?.id}
          courseId={courseId}
          title={assignmentRow?.title}
          defaultLessons={resubmitLessonsDefault}
          onChange={handleResubmitChange}
        />}
        {/* Detected resubmission (#49, Part B) — the student submitted new work
            since this was last graded. Prominent + amber because it's an
            actionable "regrade me" signal, distinct from the teacher's request. */}
        {student.resubmitted && (
          <span
            title="The student submitted new work after this was last graded: review and update the grade."
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              height: '1.8rem', boxSizing: 'border-box', padding: '0 0.7rem',
              borderRadius: 999, fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap',
              background: 'var(--warning-light)', color: 'var(--warning)',
              border: '2px solid var(--warning)',
            }}
          >
            ⚠ Ungraded resubmission: review
          </span>
        )}
        {flagError && (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>{flagError}</span>
        )}
        {isRubricLocked && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }} title="Exception set in Schoology: score data is deleted while the exception is active">
            {exceptionLabel}, rubric locked
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
        {scoreScale ? (
          <>
            <ScaleLevelPicker
              scale={scoreScale}
              syncedCode={student.scale_level ?? null}
              pendingCode={pending[SCALE] ?? null}
              suggestedCode={suggestedScaleLabel ? suggestedScale : null}
              locked={isRubricLocked}
              onSelect={selectScaleLevel}
            />
            {/* What the agent checked to suggest this level (teacher-facing). */}
            {suggestedScaleLabel && scaleEvidence && (
              <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--ai-suggest)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <AiSparkle size={12} />
                {`Suggested ${suggestedScaleLabel}: ${scaleEvidence}`}
              </div>
            )}
          </>
        ) : showDescriptors ? (
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

      {/* Reviewer notes — collapsible AI bundle. Collapsed: a compact bar (amber +
          ⚑ when flags exist, so it stays easy to spot while scrolling). Expanded
          (default): a neutral tray grouping amber flags, an expandable two-column
          Strengths(+)/Suggestions(−) seam, and the violet Suggested feedback
          narrative. Collapse persists per student and auto-collapses on publish. */}
      {hasSuggestionBlock && notesCollapsed && (
        <div style={{ margin: '0.75rem 1rem 0' }}>
          <button
            type="button"
            onClick={() => setNotesCollapsed(false)}
            aria-label="Show reviewer notes"
            style={{
              width: '100%', boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              borderRadius: 8, padding: '0.45rem 0.6rem', cursor: 'pointer',
              font: 'inherit', fontSize: '0.72rem', fontWeight: 600, textAlign: 'left',
              border: `1px solid ${reviewerFlags ? '#e6c98a' : 'var(--border)'}`,
              background: reviewerFlags ? '#fffbef' : 'var(--card-bg)',
              color: reviewerFlags ? '#92740f' : 'var(--text-muted)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <AiSparkle size={12} style={{ color: 'var(--ai-suggest)' }} /> Reviewer notes
            </span>
            {reviewerFlags && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                borderRadius: 5, padding: '0.05rem 0.4rem',
                background: '#f3d692', color: '#7a5f0c', fontWeight: 700,
              }}>
                ⚑ Flag
              </span>
            )}
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontWeight: 600 }}>▸ Show</span>
          </button>
        </div>
      )}

      {hasSuggestionBlock && !notesCollapsed && (
        <div style={{
          margin: '0.75rem 1rem 0', border: '1px solid var(--border)', background: 'var(--card-bg)',
          borderRadius: 8, padding: '0.6rem',
          display: 'flex', flexDirection: 'column', gap: '0.55rem',
        }}>
          {/* Header — master label + Hide control (kept distinct from the
              class-level "Reviewer Analysis" drawer). */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{
              fontSize: '0.63rem', fontWeight: 600, color: 'var(--text-muted)',
              letterSpacing: '0.03em',
              display: 'flex', alignItems: 'center', gap: '0.3rem',
            }}>
              <AiSparkle size={12} style={{ color: 'var(--ai-suggest)' }} /> Reviewer notes
            </div>
            <button
              type="button"
              onClick={() => setNotesCollapsed(true)}
              aria-label="Hide reviewer notes"
              style={{
                borderRadius: 6, padding: '0.15rem 0.45rem', fontSize: '0.68rem',
                fontWeight: 600, cursor: 'pointer',
                background: 'var(--card-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
              }}
            >
              ▾ Hide
            </button>
          </div>

          {/* Reviewer flags — amber QA sub-block, at a glance: one short line per
              flag. The full text is behind "Show detailed flags" below. */}
          {reviewerFlags && (
            <div style={{
              border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
              padding: '0.45rem 0.6rem',
            }}>
              <div style={{
                fontSize: '0.72rem', fontWeight: 600, color: '#92740f',
                display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem',
              }}>
                ⚑ Reviewer flags
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.84rem', lineHeight: 1.45, color: '#5a4a1f' }}>
                {flagBrief.map((f, i) => <li key={i} style={{ marginBottom: '0.1rem' }}>{f}</li>)}
              </ul>
            </div>
          )}

          {/* Strengths (green +) / Suggestions (red −), shown by default: quick to judge. */}
          {hasAnalysis && (
            <div style={{ display: 'flex', gap: '1rem', color: '#1a1a1a' }}>
              {strengths.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>Strengths</div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.84rem', lineHeight: 1.45 }}>
                    {strengths.map((st, i) => (
                      <li key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
                        <span style={{ color: 'var(--success)', fontWeight: 700, flexShrink: 0 }}>+</span>
                        <span>{st}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {suggestions.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>Suggestions</div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.84rem', lineHeight: 1.45 }}>
                    {suggestions.map((sg, i) => (
                      <li key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
                        <span style={{ color: 'var(--danger)', fontWeight: 700, flexShrink: 0 }}>−</span>
                        <span>{sg}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Detailed flags — the full reviewer text behind a centred seam toggle,
              only when it says more than the brief lines above. */}
          {reviewerFlags && flagsHaveMore && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <button
                  type="button"
                  onClick={() => setShowFullAnalysis(v => !v)}
                  style={{
                    borderRadius: 6, padding: '0.2rem 0.55rem', fontSize: '0.7rem',
                    fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                    background: 'var(--card-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                  }}
                >
                  {showFullAnalysis ? '▴ Hide detailed flags' : '▾ Show detailed flags'}
                </button>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              {showFullAnalysis && (
                <div style={{
                  marginTop: '0.5rem', border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
                  padding: '0.45rem 0.6rem', fontSize: '0.84rem', lineHeight: 1.5, color: '#5a4a1f', whiteSpace: 'pre-wrap',
                }}>
                  {reviewerFlags}
                </div>
              )}
            </div>
          )}

          {/* Narrative — the publishable AI suggestion: violet wash + border with
              black body text, its own header, and the Use-suggestion action (solid
              fuchsia, to stand out against the wash) scoped inside it. */}
          {narrativeSuggestion && suggestionFolded && !showUsedAgain && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              border: '1px dashed var(--ai-suggest)', borderRadius: 7, padding: '0.35rem 0.65rem',
              fontSize: '0.74rem', color: 'var(--ai-suggest)', fontWeight: 600,
            }}>
              {suggestionState === 'used' ? '✓ Suggestion used, now in your comment below' : 'Suggestion ignored'}
              <button
                type="button"
                onClick={() => setShowUsedAgain(true)}
                aria-label="Show suggestion again"
                style={{
                  marginLeft: 'auto', borderRadius: 6, padding: '0.15rem 0.45rem', fontSize: '0.68rem',
                  fontWeight: 600, cursor: 'pointer', background: 'var(--card-bg)',
                  color: 'var(--text-muted)', border: '1px solid var(--border)',
                }}
              >
                ▸ Show again
              </button>
            </div>
          )}
          {narrativeSuggestion && (!suggestionFolded || showUsedAgain) && (
            <div style={{
              border: '1px solid var(--ai-suggest)', background: 'var(--ai-suggest-wash)',
              borderRadius: 7, padding: '0.5rem 0.65rem',
            }}>
              <div style={{
                fontSize: '0.63rem', fontWeight: 600, color: 'var(--ai-suggest)',
                letterSpacing: '0.03em', marginBottom: '0.35rem',
                display: 'flex', alignItems: 'center', gap: '0.4rem',
              }}>
                Suggested feedback
                {suggestionRevised && (
                  <span style={{
                    borderRadius: 5, padding: '0.05rem 0.35rem', fontWeight: 700,
                    background: 'var(--ai-suggest)', color: '#fff',
                    display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                  }}>
                    <AiSparkle size={10} /> Revised
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.84rem', lineHeight: 1.45, color: '#1a1a1a', whiteSpace: 'pre-wrap' }}>
                {narrativeSuggestion}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={ignoreSuggestion}
                  aria-label="Ignore suggestion"
                  title="Hide this suggestion. Show again from its folded line"
                  style={{
                    borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
                    fontWeight: 600, cursor: 'pointer',
                    background: 'var(--card-bg)', color: 'var(--ai-suggest)', border: '1px solid var(--ai-suggest)',
                  }}
                >
                  Ignore
                </button>
                <button
                  onClick={applySuggestion}
                  title="Copy the suggestion down into your comment"
                  style={{
                    borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
                    fontWeight: 600, cursor: 'pointer',
                    background: 'var(--ai-suggest)', color: '#fff', border: '1px solid var(--ai-suggest)',
                  }}
                >
                  ↓ Use suggestion
                </button>
              </div>
            </div>
          )}
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
          {/* "Resubmission received" chip (triage resubmissions, Amendment B Task 7):
              a resubmission is sitting unanswered (arrived). Inserts the status
              line into the draft above — visible and editable, published only
              when the teacher saves. */}
          {student.resubmission?.state === 'arrived' && (
            <button
              type="button"
              className="ghost btn-sm"
              onClick={insertReceivedLine}
              title="Insert a line telling the student this was regraded after their resubmission"
            >
              ⟳ Insert "resubmission received" line
            </button>
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
            disabled={saving || !hasPendingChanges || (!scoreScale && !scale.ready)}
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
  // Render the moderation note as dot points: split on newlines, strip a leading
  // bullet marker. A single-line note (older data) becomes one item.
  const moderationPoints = (moderationNote || '')
    .split('\n')
    .map(l => l.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);

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
          From the reviewer's suggested grades, not final entered scores.
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
        {moderationPoints.length > 0 && (
          <div style={{
            fontSize: '0.84rem', color: '#92740f', background: '#fffbef',
            border: '1px solid #f0dea8', borderRadius: 6, padding: '0.45rem 0.6rem',
            marginTop: '0.5rem', lineHeight: 1.45,
          }}>
            <div style={{ fontWeight: 700, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span aria-hidden="true">⚖️</span> Moderation note
            </div>
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {moderationPoints.map((p, i) => (
                <li key={i} style={{ marginBottom: i < moderationPoints.length - 1 ? '0.25rem' : 0 }}>{p}</li>
              ))}
            </ul>
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
            <div key={i} style={{ marginBottom: '0.6rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.84rem', marginBottom: '0.15rem' }}>{n.title}</div>
              <div style={{ fontSize: '0.84rem', lineHeight: 1.45, color: 'var(--text)' }}>{n.body}</div>
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
  // Per-student OneDrive work links for lti_submission assignments (#120).
  // Loaded after the page (the server drives a browser, so it takes seconds).
  const [workLinks, setWorkLinks] = useState({ status: null, links: {} });
  // Bumped per lookup; a response for a superseded lookup (e.g. the teacher
  // moved to another assignment mid-fetch) is dropped, so a card can never
  // link to a different assignment's file.
  const workLinksReq = useRef(0);

  // Attached rubric + reporting-category colour palette for this assignment (Task 13).
  // rubricData: { id, rubric:{...criteria...}, topicByCriterion:[...] } | null.
  // viewMode toggles the per-card grid between descriptor prose and the compact
  // level table; defaults to Descriptors (the richer, student-language view).
  const [rubricData, setRubricData] = useState(null);
  const [rubricPalette, setRubricPalette] = useState({});
  const [viewMode, setViewMode] = useStickyTab('assessment-view', 'descriptors', { param: 'view' });
  const [rubricModalOpen, setRubricModalOpen] = useState(false);
  // Default resubmission deadline (lessons), loaded once from Settings (Ruling R2);
  // 3 until it loads, so a card never blocks on this request.
  const [resubmitLessonsDefault, setResubmitLessonsDefault] = useState(3);
  useEffect(() => {
    getSettings().then((s) => setResubmitLessonsDefault(s?.triage?.resubmitLessonsDefault ?? 3)).catch(() => {});
  }, []);
  const [activeFilters, setActiveFilters] = useState(() => new Set());
  const toggleFilter = (id) => setActiveFilters(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // Triage rows link here with ?student=<id>: show that card (clear a filter
  // hiding it), scroll to it, and pulse a highlight ring for ~2 s. Runs once
  // per ?student= value — handleCardSaved patches `data` in place on every
  // card save, so without this guard each save mid-grading-run would re-fire
  // the effect (it depends on `data`) and yank the page back to the linked
  // card. `focusedForRef` tracks which student id has already been handled;
  // a *different* ?student= (a fresh deep link while still on the same
  // assessment) clears it so the new link still focuses.
  const [searchParams] = useSearchParams();
  const focusStudentId = Number(searchParams.get('student')) || null;
  const [highlightId, setHighlightId] = useState(null);
  const focusedForRef = useRef(null);
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
  // "Mark all <level>" for a score-scale assignment (#41) — also a two-click confirm.
  const [markAllArmed, setMarkAllArmed] = useState(false);
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
      const resultByUid = new Map((results || []).map(r => [r.uid, r]));
      let ok = 0, fail = 0;
      for (const i of items) {
        const r = resultByUid.get(i.uid);
        const success = r?.ok ?? false;
        cardsRef.current[i.uid]?.applyResult(success);
        // Each saved pair's post-save resubmission state comes back with its result (I2).
        if (success) { handleCardSaved(i.uid, { ...i.patch, ...resubmissionFieldsPatch(r.resubmissionFields) }); ok++; } else { fail++; }
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

  // Stage the scale's bulk level (e.g. Completed) on every shown card with no
  // grade yet (#41). Nothing is written: the teacher reviews, then publishes.
  function handleMarkAll(level) {
    if (!markAllArmed) { setMarkAllArmed(true); return; }
    setMarkAllArmed(false);
    let staged = 0;
    for (const card of Object.values(cardsRef.current)) {
      if (card?.stageScaleLevel?.(level.code)) staged++;
    }
    setBulkResult(staged
      ? `Marked ${staged} student${staged !== 1 ? 's' : ''} ${level.label}: review, then publish`
      : `Every shown student already has a grade`);
  }

  // Stage every shown card's agent scale suggestion (#41, PrisMCP scale_level)
  // that differs from its grade. Staging only — the teacher still publishes.
  function handleAcceptAllSuggestions() {
    let staged = 0;
    for (const card of Object.values(cardsRef.current)) {
      if (card?.acceptScaleSuggestion?.()) staged++;
    }
    setBulkResult(`Accepted ${staged} suggestion${staged !== 1 ? 's' : ''}: review, then publish`);
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

  function loadWorkLinks({ refresh = false } = {}) {
    const req = ++workLinksReq.current;
    const settle = (next) => { if (req === workLinksReq.current) setWorkLinks(next); };
    setWorkLinks(prev => ({ ...prev, status: 'loading' }));
    getSubmissionLinks(courseId, assignmentId, { refresh })
      .then(r => settle({ status: r.status, links: r.links || {} }))
      .catch(() => settle({ status: 'error', links: {} }));
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshResult(null);
    if (data?.assignment?.is_lti_submission) loadWorkLinks({ refresh: true });
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

  const isLti = !!data?.assignment?.is_lti_submission;
  useEffect(() => {
    workLinksReq.current++;
    setWorkLinks({ status: null, links: {} });
    if (isLti) loadWorkLinks();
  }, [courseId, assignmentId, isLti]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Deep link from a triage row (Task 10). `data` isn't destructured until
  // after the loading/error/null guards below, so this reads straight off it
  // rather than off `alignedTopics` (which is just `data.topics`).
  useEffect(() => {
    if (!focusStudentId) { focusedForRef.current = null; return; }
    if (focusedForRef.current === focusStudentId) return; // already handled this link
    if (!data) return; // wait for data to load before handling
    const s = data.students.find((x) => x.id === focusStudentId);
    if (!s) return;
    focusedForRef.current = focusStudentId;
    if (!passesFilters(s, activeFilters, { assignment: data.assignment, topics: data.topics })) setActiveFilters(new Set());
    setHighlightId(focusStudentId);
    requestAnimationFrame(() => document.getElementById(`student-card-${focusStudentId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }));
    const t = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(t);
  }, [focusStudentId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  const { assignment, topics, students } = data;
  const scoreScale = data.scoreScale || null;
  const bulkLevel = scoreScale?.bulkLevel ? scoreScale.levels.find(l => l.code === scoreScale.bulkLevel) : null;
  // Agent scale suggestions still open: differ from the grade, on an unlocked student.
  const openScaleSuggestions = scoreScale ? students.filter(s => {
    const lv = feedbackByStudent[s.id]?.feedback_parsed?.scale_level;
    return lv && lv !== s.scale_level && ![1, 2, 3].includes(s.exception);
  }).length : 0;
  const hasAnalysis = Object.keys(feedbackByStudent).length > 0 || !!analysis;

  const alignedTopics = topics;
  const visibleStudents = students.filter(s => passesFilters(s, activeFilters, { assignment, topics: alignedTopics }));

  return (
    <div className="fade-in">
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)',
        marginBottom: '1.25rem', padding: '0.55rem 0',
        borderBottom: '1px solid var(--border)',
      }}>
        {/* Breadcrumb back to the class, named with its block (the Dashboard's
            [BK n] label) — sections of the same course look identical otherwise. */}
        <Link to={`/course/${courseId}`} className="link" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          ← {data.course
            ? `${data.course.block_number ? `[BK ${data.course.block_number}] ` : ''}${data.course.course_name}`
            : 'Back to course'}
        </Link>
        <h2 style={{ margin: '0.3rem 0 0.2rem', fontSize: '1.3rem', fontWeight: 700 }}>
          {assignment.title || assignmentId}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            {students.length} students · {scoreScale ? scoreScale.name : `${alignedTopics.length} measurement topics`}
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
          {workLinks.status === 'loading' && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>Finding OneDrive files…</span>
          )}
          {['no_session', 'sso_failed', 'error'].includes(workLinks.status) && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}
              title="Prism couldn't read your OneDrive through the saved Schoology session. Refresh to retry; if it keeps failing, log in again (npm run mastery:login).">
              OneDrive links unavailable
            </span>
          )}

          {/* Rubric view toggle (Task 13) — Descriptors (default) shows the
              student-language descriptor prose per level; Compact falls back to
              the dense level-code table. Hidden for a score scale (#41), whose
              one-row picker has no compact form. */}
          {!scoreScale && (
            <div role="group" aria-label="Rubric view" style={{ display: 'inline-flex', gap: '0.25rem' }}>
              <button className={`filter-btn${viewMode === 'descriptors' ? ' active' : ''}`}
                onClick={() => setViewMode('descriptors')}>Descriptors</button>
              <button className={`filter-btn${viewMode === 'compact' ? ' active' : ''}`}
                onClick={() => setViewMode('compact')}>Compact</button>
            </div>
          )}

          {/* Single entry point to the rubric hub (attach existing / upload / map / reorder / delete). */}
          <button className="secondary" style={{ fontSize: '0.78rem' }}
            onClick={() => setRubricModalOpen(true)}>Manage rubrics…</button>

          {hasAnalysis && (
            <button
              onClick={() => setDrawerOpen(true)}
              title="Reviewer Analysis: not student-facing"
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
        <AssessmentFilterBar
          students={students}
          assignment={assignment}
          topics={alignedTopics}
          active={activeFilters}
          onToggle={toggleFilter}
        />
      </div>

      {students.length === 0 ? (
        <div className="card">
          <p className="text-muted">No students found. Run a mastery sync for this course first.</p>
        </div>
      ) : (
        <>
          {visibleStudents.length === 0 && (
            <div className="card"><p className="text-muted">No students match the current filters.</p></div>
          )}
          {visibleStudents.map((student) => (
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
              submissionLink={workLinks.links[student.schoology_uid] || null}
              scoreScale={scoreScale}
              resubmitLessonsDefault={resubmitLessonsDefault}
              resubmitEnabled={!data.course?.archived && !data.course?.excluded}
              highlight={highlightId === student.id}
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

            {openScaleSuggestions > 0 && (
              <button
                className="secondary"
                onClick={handleAcceptAllSuggestions}
                disabled={bulkSaving}
                title="Select each agent-suggested level for review. Nothing is sent until you publish."
                style={{ color: 'var(--ai-suggest)', borderColor: 'var(--ai-suggest)' }}
              >
                <AiSparkle size={13} /> Accept all suggestions ({openScaleSuggestions})
              </button>
            )}
            {bulkLevel && (
              <button
                className="secondary"
                onClick={() => handleMarkAll(bulkLevel)}
                onMouseLeave={() => setMarkAllArmed(false)}
                disabled={bulkSaving}
                title={`Select ${bulkLevel.label} for every shown student without a grade. Nothing is sent until you publish.`}
              >
                {markAllArmed ? `Click again to mark all ${bulkLevel.label}` : `Mark all ${bulkLevel.label}`}
              </button>
            )}
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
