import { useState, useEffect, useRef } from 'react';
import { useHelpPop } from '../HelpDot.jsx';
import { Link } from 'react-router-dom';
import { setSuggestionState, writeMasteryScores, writeMasteryComment, getDraftsForAssignment, getTriagePair, saveRowLevels, setGradeFlag } from '../../services/api.js';
import { draftBaseline } from '../../lib/assessmentDraft.js';
import { rowScores, isRowKey, rowName } from '../../lib/feedbackRows.js';
import { makeDraftSaver } from '../../lib/assessmentDraftSaver.js';
import { useUndoableText } from '../../hooks/useUndoableText.js';
import { resolveRubricScores } from '../../lib/rubricSuggestions.js';
import { rubricAverage } from '../../lib/rubricAverage.js';
import { studentFullName, preferredFirstName } from '../../lib/studentNames.js';
import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../../lib/masteryLevels.js';
import { useProficiencyScale } from '../../hooks/useProficiencyScale.js';
import RubricDescriptorGrid from '../RubricDescriptorGrid.jsx';
import { buildDescriptorRows } from '../../lib/rubricDescriptorRows.js';
import ResubmitControl from '../ResubmitControl.jsx';
import AiSparkle from '../AiSparkle.jsx';
import SchoologyLink from '../SchoologyLink.jsx';
import AttemptLink from '../quiz/AttemptLink.jsx';
import QuizResultLine from '../quiz/QuizResultLine.jsx';
import SubmissionStatusPill from '../SubmissionStatusPill.jsx';
import SubmissionTimeline from '../SubmissionTimeline.jsx';
import SubmissionComments from '../SubmissionComments.jsx';
import SubmissionFiles, { hasNativeSubmission } from '../SubmissionFiles.jsx';
import ExtendControl from '../ExtendControl.jsx';
import ReferControl from '../ReferControl.jsx';
import FlagsMenu from '../FlagsMenu.jsx';
import ScaleLevelPicker from '../ScaleLevelPicker.jsx';
import FlagSymbol from '../FlagSymbol.jsx';
import ScoreLabel from './ScoreLabel.jsx';
import { missingView } from '../../lib/missingView.js';
import { gradeLabel } from '../../lib/gradeLabel.js';
import { reasonText, reasonTone, TONE_VARS } from '../../lib/assessmentFilters.js';
import { localIsoDate, formatDate } from '../../lib/formatDate.js';
import { addUpdateLine } from '../../lib/commentUpdate.js';
import { workLinkText } from '../../lib/workLink.js';
import { briefFlags, textSignature } from '../../lib/reviewerFlags.js';
import { receivedLine, composeComment, lineDate } from '../../lib/statusLines.js';
import { FLAGS, isFlag, isExempt, isFinalFlag, isMarker, flagEffect } from '../../lib/flags.js';
import { GRADE_WRITTEN_PATCH, resubmissionFieldsPatch, flagClearedPatch, shownCommentStatus } from '../../lib/cardPatches.js';
import { canEditPoints, parsePoints } from '../../lib/pointsTask.js';
import { categoryLabels } from '../../lib/categoryAbbr.js';
import { TopicSource } from '../CategoryTag.jsx';

// The rubric-locked badge takes the flag's color (#40). Only the final flags lock the rubric:
// Exempt green, Missing red.
const LOCK_BADGE = { 1: 'badge-green', 3: 'badge-red' };
// Suggestion accent — fuchsia CSS tokens (matches descriptor grid's --ai-suggest).
const SUGGEST = { fill: 'var(--ai-suggest-wash)', ring: 'var(--ai-suggest)', glyph: 'var(--ai-suggest)' };
// Sentinel stored in pending[topicId] to stage a synced final for removal (Slice 2).
const REMOVE = '__remove__';
// pending key for a score-scale grade (#41): an unaligned assignment graded on
// a plain Schoology scale has one level for the whole assignment, not per topic.
const SCALE = '__scale__';
// pending key for the points typed on a points-only task (#181): the box's text, as typed.
const POINTS = '__points__';

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

// ── Per-student rubric card ──────────────────────────────────────────────────

// `mode` (#176): 'edit' (the assessment page) or 'view', the read-only card the student page and the
// gradebook pop-up draw for every task. A view card draws what is published: no editor, no draft
// saver, no autosave or listeners, nothing reported to a page. `onEdit` gives it an Edit button; in
// edit mode `onDone` gives a Done button that settles the draft save first. `hasDraft` marks a view
// card whose task holds an unpublished draft. `heading` replaces the student's name link (false: none).
// `scales` (the student page's grading_scales, { [id]: { levels } }) names a points-only task's score
// on a named Schoology scale that `scoreScale` does not cover; without it the score reads in points.
// `showDue` puts the due date at the head of the submission timeline, where no page header shows it.
// The card remounts when its mode changes, so edit mode starts from the props it is given then (the
// fresh grade, the draft) and its saver and listeners start and stop with it.
export default function StudentRubricCard(props) {
  const mode = props.mode === 'view' ? 'view' : 'edit';
  return <GradeCard key={mode} {...props} mode={mode} />;
}

// `meeting` (a student conference, #176): the card is shown to the student, so it hides the photo and
// every AI suggestion (reviewer notes, suggested cells and levels, the suggested narrative).
function GradeCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow: feedbackRowGiven, mode, heading, hasDraft = false, onEdit = null, onDone = null, meeting = false, draftRow = null, rubric = null, viewMode = 'descriptors', rubricPalette = {}, submissionLink = null, attemptLink = null, quizResult = null, onRebuildQuiz = null, commentsEnabled = false, commentSummary = null, onCommentSummary = null, filesEnabled = false, fileSummary = null, onFileSummary = null, scoreScale = null, scales = null, showDue = false, resubmitLessonsDefault = 3, resubmitEnabled = true, highlight = false, reasons = [], onSaved, onRefreshPair = null, onPendingChange, onDisplayChange, registerCard, unregisterCard }) {
  // The category of each topic row as its short label, full name on hover (#196).
  const topicLabels = categoryLabels((topics || []).map((t) => t.category_title));
  const scale = useProficiencyScale();
  const isView = mode === 'view';
  // A meeting shows no AI suggestion: with no feedback row there is nothing to suggest from.
  const feedbackRow = meeting ? null : feedbackRowGiven;
  // The card's action-panel row (ActionPanel portals into it).
  const [panelHost, setPanelHost] = useState(null);
  const loadedDisplay = student.comment_status === 1;
  // Per-card DB draft saver (replaces the former localStorage key). Created on first use, which is
  // only ever in edit mode: a view card never starts one.
  const saverRef = useRef(null);
  function draftSaver() {
    if (!saverRef.current) {
      saverRef.current = makeDraftSaver(
        { assignmentId, studentId: student.id, enrollmentId: student.enrollment_id },
        { delay: 500 }
      );
    }
    return saverRef.current;
  }
  // Set true by discrete handlers (proficiency / display) so the next autosave
  // flushes immediately instead of debouncing.
  const flushNextRef = useRef(false);
  // Signature of the synced Schoology values this card was rendered against.
  // A stored draft is only valid while this is unchanged (#47).
  // Feedback rows (spec 2026-10-13): a score-scale task whose `topics` are the
  // attached rubric's criteria. Row levels stay in Prism; only the overall
  // scale level is published.
  const hasFeedbackRows = !!scoreScale && topics.length > 0;
  // A points-only task (#181): the edit card has a points box (not on a test or quiz, which
  // Schoology scores).
  const pointsTask = !isView && canEditPoints(assignmentRow, topics, scoreScale);
  // On a score-scale task the baseline never depends on the rows (topics): it
  // reads the row finals directly, so a draft stays valid while the rubric
  // loads and after one is attached (a draft saved before has no row finals).
  // The score is part of it wherever the card can write one, so typed points over a
  // score Schoology has since changed are dropped (#47).
  const currentBaseline = draftBaseline(student, scoreScale ? [] : topics, {
    includeScore: !!scoreScale || pointsTask,
    rowLevels: scoreScale ? student.row_levels : undefined,
  });

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
    applyComment(normalizePastedText(narrativeSuggestion), { step: true });
    handleSuggestion('used');
  }

  // Restore any unsaved draft for this card from localStorage (#47). Read once
  // on mount; a restored draft means the teacher already interacted with the
  // card, so auto-flip starts disarmed. A draft whose `base` no longer matches
  // the synced data is stale — Schoology changed underneath it — so it is
  // discarded and the synced values (the source of truth) win.
  // A view card draws what is published, so it restores no draft (hasDraft marks one).
  const [restoredDraft] = useState(() => {
    if (isView || !draftRow) return null;
    // Stale: Schoology changed underneath the draft (#47). Ignore it; the mount
    // effect below deletes the orphaned server row.
    if (draftRow.base !== currentBaseline) return null;
    return draftRow;
  });
  const draftWasStale = Boolean(draftRow && draftRow.base !== currentBaseline);

  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState(() => restoredDraft?.pending ?? {});
  // The comment keeps its own undo history (#75): the box writes its value on
  // paste, the chip line and Use suggestion, which breaks the browser's undo.
  // setComment (Discard, a rebase after Ask/Extend, a legacy draft) resets the
  // history; applyComment records a step.
  const commentHistory = useUndoableText(
    () => restoredDraft?.comment ?? (student.grade_comment || '')
  );
  const comment = commentHistory.value;
  const setComment = commentHistory.reset;
  // Display to student covers the comment only, never the grade (#184, a student's view checked
  // 25 Oct 2026), and Schoology keeps no Display for an empty comment (#183). So with no comment
  // the card shows "No comment", and Display neither changes nor counts as a pending change.
  const hasComment = comment !== '';
  const displayPop = useHelpPop();
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

  // A final flag (Exempt or Missing, #40) locks the rubric grid: the student is not graded on this
  // task while it is set. Comments and the Display-to-student toggle stay editable: Schoology
  // allows those for flagged students, and they add important context for students/parents.
  // A marker (Late, Incomplete, Absent) keeps the rubric open: the teacher grades straight through
  // it, and publishing the grade clears the flag in Schoology (markerNote says so above the rubric).
  const isRubricLocked = isFinalFlag(student.exception);
  const exceptionLabel = isRubricLocked ? FLAGS[Number(student.exception)].name : null;
  const markerNote = isMarker(student.exception) ? `Grading this work clears ${FLAGS[Number(student.exception)].name}.` : null;
  // The grade Prism kept when a flag removed it (#40; GET /api/mastery/.../assignment saved_grade),
  // while it waits to be restored. A final flag's locked rubric shows it grayed, with the caption;
  // with no flag set, the card offers "Restore saved grade". A marker's rubric stays live.
  const savedGrade = student.saved_grade || null;
  const showSaved = isRubricLocked && savedGrade != null;
  const shownScores = showSaved
    ? (hasFeedbackRows ? rowScores(savedGrade.rows) : Object.fromEntries(Object.entries(savedGrade.topics || {}).map(([id, grade]) => [id, { grade }])))
    : student.scores;
  const shownScaleLevel = showSaved ? (savedGrade.scale_level ?? null) : (student.scale_level ?? null);
  // Work marked Missing: IE (or the real levels) on every topic or row, and a line saying which
  // (a display transform; nothing is written). It draws what the grid draws, so the saved copy's
  // levels count as the levels there are.
  const pointsOnly = topics.length === 0 && !scoreScale;
  const gridDrawn = topics.length > 0 && (!scoreScale || hasFeedbackRows);
  const missing = gridDrawn
    ? missingView(student.exception, Object.fromEntries(topics.map((t) => [t.id, shownScores?.[t.id]?.grade ?? null])), { rows: hasFeedbackRows })
    : null;
  const shownGrade = (topicId) => (missing ? missing.grades[topicId] : shownScores?.[topicId]?.grade) || null;
  // The Missing symbol in each cell shown as IE (not beside real levels).
  const iePlaceholder = missing && !missing.hasLevels
    ? <FlagSymbol code={3} size="inline" firstName={preferredFirstName(student)} aligned={false} /> : null;
  const savedOn = savedGrade?.savedAt ? lineDate(localIsoDate(new Date(`${String(savedGrade.savedAt).replace(' ', 'T')}Z`))) : null;
  const offerRestore = savedGrade != null && !isFlag(student.exception);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(false); // the inline confirm over a draft

  // Comment publish state, verified against the synced Schoology value mirrored
  // in the local DB (grades.grade_comment → student.grade_comment). After a
  // successful publish the card patches grade_comment to the new text, so:
  //   published = current text is non-empty AND equal to the synced value;
  //   dirty     = current text differs from the synced value (unsaved edit).
  const syncedComment = student.grade_comment || '';
  const commentDirty = comment !== syncedComment;
  const commentPublished = comment.trim() !== '' && !commentDirty;

  // The rubric average of the effective rows (staged over final). Staged as the
  // overall by itself only while nothing is published (spec 2026-10-13 §4). The
  // automatic stage never turns the comment visible: only an explicit overall
  // pick or a typed comment does.
  const effectiveRows = {};
  if (hasFeedbackRows) {
    for (const t of topics) {
      const v = (t.id in pending) ? pending[t.id] : student.scores?.[t.id]?.grade;
      if (v && v !== REMOVE) effectiveRows[rowName(t.id)] = v;
    }
  }
  const average = hasFeedbackRows ? rubricAverage(scoreScale, topics.map((t) => rowName(t.id)), effectiveRows) : { level: null, reason: null };
  // Never on a final flag (Exempt, Missing): no grade is written over it.
  const autoScale = !isView && hasFeedbackRows && !isRubricLocked && student.scale_level == null && pending[SCALE] == null ? average.level : null;
  const stagedScale = scoreScale ? (pending[SCALE] ?? autoScale) : null;
  const averageLabel = average.level ? scoreScale.levels.find((l) => l.code === average.level)?.label : null;
  const currentOverall = pending[SCALE] ?? autoScale ?? student.scale_level ?? null;
  // Typed points (#181): the number to write, or null; text that is not a number of 0 or more
  // blocks the publish.
  const typedPoints = pointsTask ? (pending[POINTS] ?? null) : null;
  const stagedPoints = typedPoints != null ? parsePoints(typedPoints) : null;
  const pointsInvalid = typedPoints != null && stagedPoints == null;
  const maxPoints = assignmentRow?.max_points ?? null;
  // The score this save writes with the comment: the staged level's points (#41) or the typed points.
  const gradePoints = () => (scoreScale ? (stagedScale ? scalePointsFor(stagedScale) : null) : stagedPoints);
  // "Use the rubric average": drop a different pick (the average then stages by
  // itself while nothing is published), or stage the average over a published level.
  function useRubricAverage() {
    flushNextRef.current = true;
    setPending((p) => {
      const n = { ...p };
      if (average.level === student.scale_level || student.scale_level == null) delete n[SCALE];
      else n[SCALE] = average.level;
      return n;
    });
  }

  // Count every distinct unsaved change: each changed rubric topic, plus the
  // comment edit, plus a manual display-to-student toggle, plus an overall the
  // rubric average staged by itself. Drives the "N pending change(s)" badge so a
  // visibility flip or comment edit is reflected too.
  const pendingCount = (
    Object.keys(pending).length +
    (autoScale ? 1 : 0) +
    (commentDirty ? 1 : 0) +
    ((displayTouched && hasComment && display !== loadedDisplay) ? 1 : 0)
  );
  const hasPendingChanges = pendingCount > 0;
  // Under a final flag, staged levels (topics, rows, the overall) wait for the flag to be cleared,
  // so a publish sends only the comment and Display (#177): "Publish the comment only".
  const commentOrDisplayChanged = commentDirty || display !== loadedDisplay;
  const heldLevels = isRubricLocked && Object.keys(pending).length > 0;
  const canPublish = isRubricLocked ? commentOrDisplayChanged : (hasPendingChanges && !pointsInvalid);
  // A save that touches only feedback rows stays in Prism (no Schoology call), so its
  // button reads "Save in Prism"; the condition mirrors handleSave's overallChanged.
  const rowsOnlySave = !isRubricLocked && hasFeedbackRows && stagedScale == null
    && comment === (student.grade_comment || '') && display === loadedDisplay
    && rowLevelsToSave() != null;

  // Track whether this card has ever held a draft, so an untouched card does NOT
  // fire a spurious DELETE on first mount (only a real draft→clear transition does).
  const didDraftRef = useRef(Boolean(restoredDraft));

  // Mirror unsaved work to the DB. React state stays the instant UI source of
  // truth; this autosave is fire-and-forget. Typing debounces (~500ms); a
  // discrete proficiency/display change flushes immediately (flushNextRef).
  useEffect(() => {
    if (isView) return;
    const saver = draftSaver();
    if (hasPendingChanges) {
      didDraftRef.current = true;
      saver.save(
        { pending, comment, display, displayTouched, base: currentBaseline },
        { immediate: flushNextRef.current }
      );
    } else if (didDraftRef.current) {
      // Honor flushNextRef so a discrete clear (discard / toggle-off) deletes the
      // server row immediately; a debounced remove is sent on unmount (settle), but
      // not on page-hide (the beacon carries saves only).
      saver.remove({ immediate: flushNextRef.current });
    }
    flushNextRef.current = false;
  }, [hasPendingChanges, pending, comment, display, displayTouched, currentBaseline]);

  // Flush a pending save on tab-hide (sendBeacon) and on SPA unmount (keepalive); on unmount a
  // queued delete is sent too (settle), so a change undone just before Done, a collapse or closing
  // the pop-up leaves no stray draft. Delete a stale server draft once on mount.
  useEffect(() => {
    if (isView) return undefined;
    const saver = draftSaver();
    if (draftWasStale) saver.remove({ immediate: true });
    const onPageHide = () => saver.flush({ beacon: true });
    const onVisibility = () => { if (document.visibilityState === 'hidden') saver.flush({ beacon: true }); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      saver.flush({ keepalive: true });
      saver.settle();
      saver.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time migration of a pre-DB localStorage draft for this card. If the
  // browser still holds the old key and the server has no draft, seed React
  // state from it (the autosave effect then persists it) and clear localStorage.
  useEffect(() => {
    if (isView || draftRow) return;
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
  const heldRef = useRef(false);
  heldRef.current = heldLevels;
  const setDisplayRef = useRef(null);
  setDisplayRef.current = applyDisplay;
  const stageRef = useRef(null);
  stageRef.current = stageScaleLevel;
  const acceptRef = useRef(null);
  acceptRef.current = acceptScaleSuggestion;

  // 'publish' while Publish all has something to send for this card; 'held' while its only
  // changes are levels a final flag holds back (#177), so the bar does not count it.
  const pendingState = canPublish ? 'publish' : (hasPendingChanges ? 'held' : false);
  useEffect(() => {
    if (isView) return;
    onPendingChange?.(student.schoology_uid, pendingState);
  }, [isView, pendingState, student.schoology_uid, onPendingChange]);

  // Report this card's current visibility up so the page bar's "show all to
  // students" toggle can reflect the class-wide aggregate (all / none / mixed).
  // null: no comment, so this card has no Display and is left out of the aggregate.
  useEffect(() => {
    if (isView) return;
    onDisplayChange?.(student.schoology_uid, hasComment ? display : null);
  }, [isView, display, hasComment, student.schoology_uid, onDisplayChange]);

  useEffect(() => {
    if (isView) return undefined;
    const uid = student.schoology_uid;
    registerCard?.(uid, {
      getEntry: () => entryRef.current(),
      applyResult: (ok, result) => applyRef.current(ok, result),
      discard: () => discardRef.current(),
      holdsLevels: () => heldRef.current,
      setDisplay: (v) => setDisplayRef.current(v),
      stageScaleLevel: (code) => stageRef.current(code),
      acceptScaleSuggestion: () => acceptRef.current(),
    });
    return () => unregisterCard?.(uid);
  }, [isView, student.schoology_uid, registerCard, unregisterCard]);

  // Apply a new comment value, auto-flipping the display toggle ON the first
  // time a virgin record's comment goes empty → non-empty. Shared by the
  // textarea's onChange and onPaste handlers. step: one undo step by itself
  // (paste, chip line, Use suggestion); otherwise typing, grouped.
  function applyComment(next, { step = false } = {}) {
    if (autoFlipArmed && comment === '' && next !== '') {
      setDisplay(true);
      setAutoFlipArmed(false);
    }
    commentHistory.set(next, { step });
  }

  // "Add update" (#176): a dated line above the comment, below any Prism status line, for a grade
  // appeal. The cursor lands after the colon, once React has put the new text in the textarea.
  const commentBoxRef = useRef(null);
  const pendingCursorRef = useRef(null);
  function placeCursor(pos) {
    const el = commentBoxRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  }
  useEffect(() => {
    if (pendingCursorRef.current == null) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    placeCursor(pos);
  }, [comment]);
  function addUpdate() {
    const own = student.status_line?.line || null;
    const topLine = topLineIs(comment, insertedLine) ? insertedLine : (topLineIs(comment, own) ? own : null);
    const result = addUpdateLine(comment, topLine, formatDate(new Date()));
    if (!result) return;
    if (result.text === comment) { placeCursor(result.cursor); return; }
    pendingCursorRef.current = result.cursor;
    applyComment(result.text, { step: true });
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
    applyComment(composeComment(comment, stored, line), { step: true });
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
    applyCardChange({ resubmission, resubmit_flag: resubmission?.request ? { id: resubmission.request.id } : null, ...(extra || {}) }, commentChange);
    // The card's Needs action / Watch reasons (resubmission pending / overdue) follow the ask.
    if (assignmentRow?.id) getTriagePair(student.id, assignmentRow.id).then(handlePairChange).catch(() => {});
  }

  // The card's Extend control: the pair's fresh timeline + what the status line did;
  // then the Overdue work row (an extension can take the student off it).
  function handleExtensionChange(timeline, commentChange = null) {
    applyCardChange(timeline ? { timeline } : {}, commentChange);
    if (assignmentRow?.id) getTriagePair(student.id, assignmentRow.id).then(handlePairChange).catch(() => {});
  }

  // Refer / Waive / Undo (and after an extension): { timeline, late_work } for this student.
  function handlePairChange(state) {
    if (state) onSaved?.(student.schoology_uid, { timeline: state.timeline, late_work: state.late_work, attention: state.attention });
  }

  // After a flag write (#40): the page refetches this student (flag, score, levels, comment,
  // status line, saved copy, timeline), the comment editor follows the line the flag wrote or
  // removed (an unsaved edit keeps the teacher's text with the line swapped on top), and a restored
  // copy becomes the card's staged draft.
  // A final flag (Exempt, Missing) locks the rubric: staged levels (topics, rows, the overall) stay
  // as the card's draft, a publish sends only the comment and Display (#177), and the card says so.
  // A failed refetch throws, so the Flags pill says the page could not refresh.
  async function handleFlagChange(result) {
    const fresh = onRefreshPair ? await onRefreshPair(student.schoology_uid) : null;
    if (onRefreshPair && !fresh) throw new Error('The page could not refresh.');
    if (fresh) {
      const newLine = fresh.status_line?.line || '';
      if (commentDirty) {
        const onTop = topLineIs(comment, insertedLine) ? insertedLine : (student.status_line?.line || null);
        setComment(composeComment(comment, onTop, newLine));
      } else {
        setComment(fresh.grade_comment || '');
      }
      setInsertedLine(null);
      if (!displayTouched) setDisplay(fresh.comment_status === 1);
      flushNextRef.current = true;
    }
    // A view card shows what is published; the restored draft waits for edit mode.
    if (!isView && result?.restored?.draft) {
      const drafts = await getDraftsForAssignment(assignmentId, { studentId: student.id }).catch(() => null);
      const d = drafts?.[student.id];
      if (d) {
        flushNextRef.current = true;
        setPending(d.pending || {});
        if (typeof d.comment === 'string') setComment(d.comment);
        if (typeof d.display === 'boolean') setDisplay(d.display);
        setDisplayTouched(Boolean(d.displayTouched));
        setAutoFlipArmed(false);
      }
    }
  }

  // "Restore saved grade": no flag is set and a copy waits (the flag was cleared with the box
  // unticked). Code 0 over no flag restores the copy into the draft without a Schoology write.
  // The restore replaces the card's draft, so over staged changes it asks first, inside the card.
  async function restoreSavedGrade({ confirmed = false } = {}) {
    if (hasPendingChanges && !confirmed) { setConfirmRestore(true); return; }
    setConfirmRestore(false);
    setRestoring(true);
    setRestoreError(null);
    let result;
    try {
      // A debounced draft save landing after the restore would overwrite the restored draft.
      await draftSaver().settle();
      result = await setGradeFlag({
        studentId: student.id, assignmentId: assignmentRow.id, code: 0,
        expected: { exception: Number(student.exception) || 0, score: student.score ?? null, comment: student.grade_comment || '' },
        reason: null, restore: true,
      });
    } catch (err) {
      setRestoreError(err.message);
      setRestoring(false);
      return;
    }
    if (result?.restored?.error) setRestoreError(result.restored.error);
    try {
      await handleFlagChange(result);
    } catch {
      setRestoreError('Saved, but the page could not refresh. Reload to see it.');
    } finally {
      setRestoring(false);
    }
  }

  // Patch the student and keep the comment editor in step with a published / removed
  // status line (shared by the resubmission and extension controls).
  function applyCardChange(patch, commentChange) {
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
        // A feedback row stays in Prism, so it never turns the comment visible.
        if (!hasFeedbackRows) armAutoFlip();
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
    if (!hasFeedbackRows) armAutoFlip();
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

  // The points box (#181). The text is staged as typed; typing the synced score back drops it.
  // Prism never removes a score: an emptied box over a score blocks the publish.
  function typePoints(text) {
    if (isRubricLocked) return;
    const synced = student.score == null ? '' : String(student.score);
    if (text === synced) {
      setPending((p) => { const n = { ...p }; delete n[POINTS]; return n; });
      return;
    }
    armAutoFlip();
    setPending((p) => ({ ...p, [POINTS]: text }));
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
  // Also stages the agent's row suggestions on a feedback-row task (each row
  // not already staged and differing from its final).
  function acceptScaleSuggestion() {
    if (isRubricLocked) return false;
    let staged = false;
    if (hasFeedbackRows) {
      const updates = {};
      for (const [topicId, level] of Object.entries(suggestedByTopic)) {
        if (topicId in pending || student.scores?.[topicId]?.grade === level) continue;
        updates[topicId] = level;
      }
      if (Object.keys(updates).length) { flushNextRef.current = true; setPending((p) => ({ ...p, ...updates })); staged = true; }
    }
    if (suggestedScaleLabel && suggestedScale !== student.scale_level && pending[SCALE] == null) {
      selectScaleLevel(suggestedScale);
      staged = true;
    }
    return staged;
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

  // After a publish: with no comment Schoology keeps Display off (#183), so the switch shows
  // that and holds no change. The publish's patch sets the same (shownCommentStatus).
  // `cleared`: the save's flagCleared, whose comment replaces the card's when a flag's line went.
  function settleDisplay(cleared = null) {
    const final = typeof cleared?.comment === 'string' ? cleared.comment : comment;
    if (final === '') { setDisplay(false); setDisplayTouched(false); }
  }

  // Set the display-to-student visibility. Shared by the per-card switch and the
  // page-level "show/hide all". Marks it a manual change so it counts as pending
  // (the pendingCount guard ignores it when value already equals the synced one).
  function applyDisplay(value) {
    if (!hasComment) return;
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

  // Feedback rows: row picks in `pending` → { criterion: level | null } (null = clear a final).
  function rowLevelsToSave() {
    const keys = Object.keys(pending).filter(isRowKey);
    if (!hasFeedbackRows || keys.length === 0) return null;
    return Object.fromEntries(keys.map((k) => [rowName(k), pending[k] === REMOVE ? null : pending[k]]));
  }
  // The student's row levels after a save: synced finals with the saved picks
  // merged over them (null clears one), for the in-place patch.
  function savedRowLevels(rowLevels) {
    const out = {};
    for (const t of topics) { const g = student.scores?.[t.id]?.grade; if (g) out[rowName(t.id)] = g; }
    for (const [n, l] of Object.entries(rowLevels || {})) { if (l == null) delete out[n]; else out[n] = l; }
    return out;
  }

  // This card's batched "Send all" entry + its in-place patch, or null when
  // nothing is unsaved. Same writes as handleSave, expressed as data for the
  // page to collapse into one request (#51).
  function buildSendEntry() {
    if (isRubricLocked) {
      // A final flag: the comment and Display only; staged levels stay as the draft (#177).
      if (!commentOrDisplayChanged) return null;
      return {
        entry: {
          uid: student.schoology_uid, enrollmentId: student.enrollment_id, assignmentId,
          scores: null, ...(scoreScale ? { grade: null } : {}),
          comment: { comment, commentStatus: display, ...statusLineFields() },
        },
        patch: { grade_comment: comment, comment_status: shownCommentStatus(comment, display), ...statusLinePatch() },
      };
    }
    if (pointsInvalid) return null;
    const scaleCode = stagedScale;
    const points = gradePoints();
    const hasScoreChanges = !scoreScale && !pointsTask && Object.keys(pending).length > 0;
    const hasCommentChange = comment !== (student.grade_comment || '');
    const hasDisplayChange = display !== loadedDisplay;
    if (!hasScoreChanges && points == null && !hasCommentChange && !hasDisplayChange && !rowLevelsToSave()) return null;
    if (scoreScale || pointsTask) {
      const rowLevels = rowLevelsToSave();
      const overallChanged = points != null || hasCommentChange || hasDisplayChange;
      if (!overallChanged && !rowLevels) return null;
      return {
        entry: {
          uid: student.schoology_uid,
          enrollmentId: student.enrollment_id,
          assignmentId,
          scores: null,
          // Typed points carry the score the card was drawn from: the server refuses them over a
          // score that changed in Schoology since (#181).
          grade: points != null ? { points, ...(pointsTask ? { expected: student.score ?? null } : {}) } : null,
          // One PUT carries grade + comment + visibility, so the comment rides
          // along; a rows-only entry sends nothing to Schoology.
          comment: overallChanged ? { comment, commentStatus: display, ...statusLineFields() } : null,
          ...(rowLevels ? { rowLevels } : {}),
        },
        patch: {
          ...(points != null ? { score: points, ...(scaleCode ? { scale_level: scaleCode } : {}), ...GRADE_WRITTEN_PATCH } : {}),
          ...(rowLevels ? { row_levels: savedRowLevels(rowLevels) } : {}),
          ...(overallChanged ? { grade_comment: comment, comment_status: shownCommentStatus(comment, display), ...statusLinePatch() } : {}),
        },
      };
    }
    const scores = (hasScoreChanges && assignmentRow && scale.ready) ? {
      gradeInfo: buildGradeInfo(),
      gradingPeriodId: assignmentRow.mastery_grading_period_id,
      gradingCategoryId: assignmentRow.mastery_grading_category_id,
    } : null;
    return {
      entry: {
        uid: student.schoology_uid,
        enrollmentId: student.enrollment_id,
        assignmentId,
        // `scores` guards on scale.ready: if the scale hasn't loaded yet, levelToPoints
        // returns null for every topic, so buildGradeInfo() produces {} (all
        // topics skipped). Schoology's /observations write REPLACES the full
        // observation set, so posting an empty gradeInfo would wipe all scores.
        // Defer the score write instead of posting a destructive empty set.
        // The per-card Save button uses the same discriminator (!scale.ready →
        // disabled), so this mirrors that behaviour for the batch path.
        // NOTE: an empty gradeInfo when scale.ready IS true is a valid "clear
        // all topics" intent — do not use gradeInfo emptiness as the skip signal.
        scores,
        comment: (hasCommentChange || hasDisplayChange) ? { comment, commentStatus: display, ...statusLineFields() } : null,
        // Levels over a marker with the comment unchanged (#40): the server settles the marker
        // (retires the saved copy, takes the flag's line off the FRESH comment) and never writes
        // the card's comment, which may be stale.
        ...(scores && !(hasCommentChange || hasDisplayChange) && isMarker(student.exception) ? { settleMarker: true } : {}),
      },
      patch: {
        scores: buildSavedScores(), ...(scores ? GRADE_WRITTEN_PATCH : {}), grade_comment: comment, comment_status: shownCommentStatus(comment, display),
        ...statusLinePatch(),
      },
    };
  }

  // Update this card's own UI after the page's batch lands. The page applies the
  // in-place data patch itself (handleCardSaved) — here we only own the badge,
  // pending reset, and draft clear (mirrors handleSave's success/error tail).
  function applySendResult(ok, result = null) {
    if (ok) {
      // A grade over a marker: Prism took the flag's line off the comment (#40).
      if (typeof result?.flagCleared?.comment === 'string') setComment(result.flagCleared.comment);
      // Published, with a part that was not: the marker not settled, or its line still in the comment.
      const warning = result?.warning || result?.flagCleared?.lineError || null;
      setSaveResult(warning ? `error: ${warning}` : 'saved');
      // Levels held by a final flag stay staged; the autosave keeps them as the draft (#177).
      if (!heldLevels) {
        setPending({});
        draftSaver().remove({ immediate: true });
      }
      setInsertedLine(null);
      settleDisplay(result?.flagCleared);
      commentHistory.clearHistory(); // undo never crosses a publish (#75)
      setNotesCollapsed(true); // published via bulk → tuck the reviewer notes away
    } else if (result?.published) {
      // The grade and comment are in Schoology; only the feedback rows did not save in Prism. Keep
      // just the row picks staged to save again.
      setPending((p) => Object.fromEntries(Object.entries(p).filter(([k]) => isRowKey(k))));
      setInsertedLine(null);
      settleDisplay();
      commentHistory.clearHistory();
      setSaveResult(`error: ${result.error}`);
    } else {
      setSaveResult(result?.error ? `error: ${result.error}` : 'error: send failed');
    }
  }

  // A final flag (Exempt, Missing): publish the comment and Display only. Staged levels stay
  // staged, and the autosave keeps them as the card's draft until the flag is cleared (#177).
  async function publishCommentOnly() {
    const saved = await writeMasteryComment(courseId, {
      enrollmentId: student.enrollment_id, assignmentId, comment, commentStatus: display, ...statusLineFields(),
    });
    setSaveResult('saved');
    if (!heldLevels) draftSaver().remove({ immediate: true });
    setInsertedLine(null);
    settleDisplay();
    commentHistory.clearHistory(); // undo never crosses a publish (#75)
    onSaved?.(student.schoology_uid, {
      grade_comment: comment,
      comment_status: shownCommentStatus(comment, display),
      ...resubmissionFieldsPatch(saved?.resubmissionFields),
      ...statusLinePatch(),
    });
    setNotesCollapsed(true);
    return true;
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      if (isRubricLocked) return await publishCommentOnly();
      const scaleCode = stagedScale;
      const points = gradePoints();
      const hasScoreChanges = !scoreScale && !pointsTask && Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');
      const hasDisplayChange = display !== loadedDisplay;

      if (scoreScale || pointsTask) {
        // Score-scale grade (#41) or typed points (#181): grade + comment + visibility in one
        // write. Feedback rows ride along with it, or save alone (no Schoology call)
        // when only the rows changed.
        const rowLevels = rowLevelsToSave();
        const overallChanged = points != null || hasCommentChange || hasDisplayChange;
        // The score in the card's patch: what Schoology holds after a points write (read back).
        const scorePatch = (held) => (points != null
          ? { score: held !== undefined ? held : points, ...(scaleCode ? { scale_level: scaleCode } : {}), ...GRADE_WRITTEN_PATCH }
          : {});
        let saved = null;
        if (overallChanged) {
          try {
            saved = await writeMasteryComment(courseId, {
              enrollmentId: student.enrollment_id,
              assignmentId,
              comment,
              commentStatus: display,
              ...(points != null ? { points, ...(pointsTask ? { expectedScore: student.score ?? null } : {}) } : {}),
              ...(rowLevels ? { rowLevels } : {}),
              ...statusLineFields(),
            });
          } catch (err) {
            if (!err.published) throw err;
            // The grade and comment are in Schoology (the server retired any saved copy); only the
            // feedback rows did not save in Prism. Keep just the row picks staged to save again.
            setPending((p) => Object.fromEntries(Object.entries(p).filter(([k]) => isRowKey(k))));
            setInsertedLine(null);
            settleDisplay(err.flagCleared);
            commentHistory.clearHistory();
            onSaved?.(student.schoology_uid, {
              ...scorePatch(),
              grade_comment: comment,
              comment_status: shownCommentStatus(comment, display),
              ...resubmissionFieldsPatch(err.resubmissionFields),
              ...statusLinePatch(),
              ...flagClearedPatch(err.flagCleared),
            });
            if (typeof err.flagCleared?.comment === 'string') setComment(err.flagCleared.comment);
            setSaveResult(`error: ${err.message}`);
            return false;
          }
        } else if (rowLevels) {
          await saveRowLevels(assignmentId, student.schoology_uid, rowLevels);
        }
        // A grade over a marker whose line stayed in the comment, or points Schoology did not keep
        // as sent (#181): published, and the card says so.
        const savedWarning = saved?.flagCleared?.lineError || saved?.warning || null;
        setSaveResult(savedWarning ? `error: ${savedWarning}` : 'saved');
        setPending({});
        setInsertedLine(null);
        settleDisplay(saved?.flagCleared);
        commentHistory.clearHistory(); // undo never crosses a publish (#75)
        draftSaver().remove({ immediate: true });
        onSaved?.(student.schoology_uid, {
          ...scorePatch(saved?.score),
          ...(rowLevels ? { row_levels: savedRowLevels(rowLevels) } : {}),
          ...(overallChanged ? {
            grade_comment: comment,
            comment_status: shownCommentStatus(comment, display),
            ...resubmissionFieldsPatch(saved?.resubmissionFields),
            ...statusLinePatch(),
            ...flagClearedPatch(saved?.flagCleared),
          } : {}),
        });
        if (typeof saved?.flagCleared?.comment === 'string') setComment(saved.flagCleared.comment);
        if (overallChanged) setNotesCollapsed(true);
        return true;
      }

      // The pair's post-save resubmission state — from the last write that reported it.
      let fields = null;
      let rubricSaved = false;
      let scoreWarning = null; // the levels are in Schoology, but Prism's copy was not updated (#182)
      if (hasScoreChanges && assignmentRow) {
        const scored = await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo: buildGradeInfo(),
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        });
        fields = scored?.resubmissionFields ?? fields;
        scoreWarning = scored?.warning || null;
        rubricSaved = true;
      }

      let cleared = null;
      let warning = scoreWarning; // published, with a part that was not (shown as the card's error)
      if (hasCommentChange || hasDisplayChange) {
        let saved;
        try {
          saved = await writeMasteryComment(courseId, {
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
        } catch (err) {
          if (!rubricSaved) throw err;
          // The levels are in Schoology; only the comment is not. Keep the comment (and its draft)
          // to publish again, and stop showing the levels as pending.
          setPending({});
          onSaved?.(student.schoology_uid, { scores: buildSavedScores(), ...GRADE_WRITTEN_PATCH, ...resubmissionFieldsPatch(fields) });
          setSaveResult(`error: Levels published to Schoology; the comment was not saved (${err.message}). Publish again to send it.`);
          return false;
        }
        fields = saved?.resubmissionFields ?? fields;
        cleared = saved?.flagCleared ?? null;
      } else if (rubricSaved && isMarker(student.exception)) {
        // Levels over a marker with the comment unchanged (#40): the server settles the marker
        // (retires the saved copy, takes the flag's line off the FRESH comment) and writes no
        // comment of the card's, which may be stale.
        try {
          const settled = await writeMasteryComment(courseId, { enrollmentId: student.enrollment_id, assignmentId, settleMarker: true });
          fields = settled?.resubmissionFields ?? fields;
          cleared = settled?.flagCleared ?? null;
        } catch (err) {
          warning = `Levels published to Schoology; the flag's line was not removed from the comment (${err.message}). Sync, then check the comment.`;
        }
      }
      if (cleared?.lineError) warning = cleared.lineError; // "Published, but the flag's line was not removed ..."
      if (typeof cleared?.comment === 'string') setComment(cleared.comment);
      setSaveResult(warning ? `error: ${warning}` : 'saved');
      setPending({});
      setInsertedLine(null);
      settleDisplay(cleared);
      commentHistory.clearHistory(); // undo never crosses a publish (#75)
      // Explicit clear: the card stays mounted now, but the write effect runs
      // asynchronously — clear here so a fast bulk run can't race a stale key.
      draftSaver().remove({ immediate: true });
      onSaved?.(student.schoology_uid, {
        scores: buildSavedScores(),
        ...(rubricSaved ? GRADE_WRITTEN_PATCH : {}),
        grade_comment: comment,
        comment_status: shownCommentStatus(comment, display),
        ...resubmissionFieldsPatch(fields),
        ...statusLinePatch(),
        ...flagClearedPatch(cleared),
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

  // A resubmission that has arrived rings the card blue (the stronger signal; the status
  // pill reads "Resubmitted"), asked for or not.
  const resubmissionArrived = student.resubmission?.state === 'arrived' || !!student.resubmitted;
  // An unread comment shows once, on the comment chip (red dot); the Needs action
  // filter keeps its "Unread comment" pill.
  const headerReasons = reasons.filter((r) => !(r.id === 'resubmitted' && resubmissionArrived) && r.id !== 'unread_comment');

  // Descriptor view: order rows by criterion.position → mapped topic; topics with
  // no criterion fall after. Built only when a rubric is attached.
  const descriptorRows = buildDescriptorRows(topics, rubric);
  const cellStateFor = (topicId, l) => {
    const currentGrade = shownGrade(topicId);
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
  // The unpublished-draft mark: the comment's own in edit mode, the task's (hasDraft) in view mode.
  const draftMark = (
    <span style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--warning)' }}>
      ● Draft - not published
    </span>
  );
  // Done: the queued draft save lands first, so the view the parent draws next includes it.
  // A second click while the first settles is ignored, so onDone runs once.
  const doneInFlightRef = useRef(false);
  async function handleDone() {
    if (doneInFlightRef.current) return;
    doneInFlightRef.current = true;
    try {
      await draftSaver().settle();
      onDone();
    } finally {
      doneInFlightRef.current = false;
    }
  }

  return (
    <div
      id={`student-card-${student.id}`}
      className={highlight ? 'student-card--highlight' : undefined}
      style={{
        border: resubmissionArrived ? '1px solid var(--resubmit-ring)' : '1px solid var(--border)',
        boxShadow: resubmissionArrived ? '0 0 0 2px var(--badge-resubmit-bg)' : 'none',
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
        {!meeting && (student.picture_url ? (
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
        ))}
        {heading === undefined ? (
          <Link to={`/student/${student.id}`} className="link" style={{ fontWeight: 600, fontSize: '0.95rem', whiteSpace: 'nowrap' }}>
            {displayName(student)}
          </Link>
        ) : (heading || null)}
        <SubmissionStatusPill student={student} assignment={assignmentRow} aligned={!scoreScale && topics.length > 0} />
        {/* Why this student needs attention: the Needs action / Watch reasons, the same
            names as the filter pills above the cards. "Resubmitted" is left out: the
            status pill already says it (and the card has the blue ring). "Unread comment"
            is left out: the comment chip's red dot says it. */}
        {headerReasons.map((r) => {
          const v = TONE_VARS[reasonTone(r)] || TONE_VARS.neutral;
          return (
            <span key={r.id} className="reason-chip" data-reason={r.id}
              style={{ background: v.bg, color: v.text, boxShadow: `inset 0 0 0 1px ${v.text}` }}>
              {reasonText(r)}
            </span>
          );
        })}
        {/* The student's own copy: OneDrive, in progress or submitted (#120), or
            Google Drive once submitted (#142). */}
        {submissionLink && (
          <SchoologyLink
            url={submissionLink.url}
            label="Open"
            {...workLinkText(submissionLink, displayName(student))}
            style={{ fontSize: '0.78rem', fontWeight: 600 }}
          />
        )}
        {/* The student's own Schoology uploads, every revision (#107). */}
        {filesEnabled && hasNativeSubmission(assignmentRow, student) && (
          <SubmissionFiles assignmentId={assignmentId} studentId={student.id} studentName={displayName(student)}
            title={assignmentRow?.title} summary={fileSummary}
            onSummary={(s) => onFileSummary?.(student.id, s)} />
        )}
        {/* The student's attempt on a linked or combined Schoology test. */}
        <AttemptLink link={attemptLink} name={displayName(student)} />
        {/* The student's quiz numbers on a linked result task (linked quizzes, phase 3). */}
        <QuizResultLine result={quizResult} onRebuild={() => onRebuildQuiz(student.id)} />
        {/* The student's Schoology submission comment thread (2026-10-17): students
            often type their answers in the comment box. */}
        {commentsEnabled && (
          <SubmissionComments assignmentId={assignmentId} studentId={student.id} studentName={displayName(student)}
            title={assignmentRow?.title} summary={commentSummary}
            onSummary={(s) => onCommentSummary?.(student.id, s)} />
        )}
        {saveResult === 'saved' && (
          <span className="badge badge-green" style={{ fontSize: '0.68rem' }}>Saved ✓</span>
        )}
        {saveResult?.startsWith('error') && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }}>{saveResult}</span>
        )}
        {/* Right-aligned control cluster — pins the resubmit, extend and refer controls to the
            card's right edge so they sit on the same vertical plane across every
            card regardless of student-name length. */}
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        {/* Resubmission (triage) — ask with a deadline in school days; each action publishes a
            status line to the student's Schoology comment after a confirm (spec Amendment B).
            Not offered on an archived/excluded course (the server refuses those). */}
        {/* Extend (late work, or a missed test's make-up): before or after the due date.
            Summative or Schoology test only, in a current course, not for an exempt student. */}
        {/* Refer / Waive at the referral limit, the same row the dashboard's Overdue work shows. */}
        {/* A view card offers only the Flags menu (and Edit). */}
        {isView && hasDraft && draftMark}
        {!isView && resubmitEnabled && (
          <ReferControl student={student} assignmentId={assignmentRow?.id} panelHost={panelHost} onChange={handlePairChange}
            beforeWrite={() => draftSaver().settle()} onSchoologyChange={() => handleFlagChange(null)} />
        )}
        {/* Schoology's flags (#40): after Refer, before Extend. */}
        {resubmitEnabled && assignmentRow?.id && (
          <FlagsMenu
            student={{ id: student.id, firstName: preferredFirstName(student) }}
            assignmentId={assignmentRow.id}
            exception={student.exception}
            score={student.score ?? null}
            comment={student.grade_comment || ''}
            aligned={!scoreScale && topics.length > 0}
            panelHost={panelHost}
            beforeWrite={isView ? null : () => draftSaver().settle()}
            onChange={handleFlagChange}
          />
        )}
        {/* Hidden once the work is in (no deadline left to extend) and for Exempt (the student is not doing the task). */}
        {!isView && resubmitEnabled && (topics.length > 0 || assignmentRow?.is_test === 1) && !isExempt(student.exception)
          && student.timeline?.submission?.state !== 'submitted' && (
          <ExtendControl student={student} assignment={assignmentRow || {}} courseId={courseId} panelHost={panelHost} onChange={handleExtensionChange} />
        )}
        {!isView && resubmitEnabled && <ResubmitControl
          student={student}
          assignmentId={assignmentRow?.id}
          courseId={courseId}
          title={assignmentRow?.title}
          defaultLessons={resubmitLessonsDefault}
          panelHost={panelHost}
          onChange={handleResubmitChange}
        />}
        {isRubricLocked && (
          <span className={`badge ${LOCK_BADGE[student.exception]}`} style={{ fontSize: '0.68rem' }} title={`Flag set in Schoology. ${flagEffect(student.exception)}`}>
            {exceptionLabel}, rubric locked
          </span>
        )}
        {isView && onEdit && (
          <button type="button" className="secondary btn-sm" onClick={() => onEdit()}>Edit</button>
        )}
        </div>
      </div>

      {/* The open action's editor (Extend, Ask to resubmit, Waive) draws here, full width
          under the header, so the header's buttons never wrap (ActionPanel portal). */}
      <div ref={setPanelHost} className="card-action-panel" />

      {/* The full submission picture: due / extension, submitted when and how late
          (or the clock day it is missing on), resubmission, referral. */}
      {student.timeline && (
        <div style={{ padding: '0.45rem 1rem 0', paddingLeft: meeting ? '1rem' : 'calc(1rem + 70px + 0.75rem)' }}>
          <SubmissionTimeline timeline={student.timeline} showDue={showDue} />
        </div>
      )}

      {markerNote && <div className="flag-marker-note">{markerNote}</div>}
      {isRubricLocked && Object.keys(pending).length > 0 && (
        <div className="flag-marker-note">Your staged levels stay as a draft until the flag is cleared.</div>
      )}
      {showSaved && (
        <div className="flag-saved-caption">
          {`Saved before the flag${savedOn ? ` on ${savedOn}` : ''}. Clear the flag to restore it.`}
        </div>
      )}
      {offerRestore && !isView && (
        <div className="flag-saved-offer">
          <span>
            {`Grade saved in Prism${savedOn ? ` on ${savedOn}` : ''}: ${savedGrade.summary || 'a grade'}.`}
            {savedGrade.restoreSummary && ` Restoring puts back ${savedGrade.restoreSummary} as a draft.`}
            {savedGrade.notRestored?.length > 0 && ` Re-enter in Schoology: ${savedGrade.notRestored.join(', ')}.`}
          </span>
          {resubmitEnabled && assignmentRow?.id && savedGrade.restoreSummary && !confirmRestore && (
            <button type="button" className="ghost accent btn-sm" disabled={restoring} onClick={() => restoreSavedGrade()}>Restore saved grade</button>
          )}
          {confirmRestore && (
            <span className="flag-saved-offer__confirm" role="group" aria-label="Restore the saved grade">
              <span>{`Restoring replaces your draft on this card with the saved grade (${savedGrade.restoreSummary}).`}</span>
              <button type="button" className="primary btn-sm" disabled={restoring} onClick={() => restoreSavedGrade({ confirmed: true })}>Restore and replace your draft</button>
              <button type="button" className="ghost btn-sm" onClick={() => setConfirmRestore(false)}>Cancel</button>
            </span>
          )}
          {restoreError && <span className="flags-error text-sm" role="alert">{restoreError}</span>}
        </div>
      )}

      {missing && (
        <div className="flag-marker-note flag-marker-note--missing">
          <FlagSymbol code={3} size="inline" showName firstName={preferredFirstName(student)} aligned={missing.hasLevels}
            savedLevel={savedGrade?.summary ?? null} reasonLine={student.flag_line ?? null} />
          <span>{missing.line}</span>
        </div>
      )}

      {/* Rubric grid. A points-only task has no rubric to lock: its Score line (and a flag's
          symbol) stays fully visible. */}
      <div className={`grade-card__rubric${showDescriptors ? ' grade-card__rubric--descriptors' : ''}`} style={{
        overflowX: 'auto', padding: '0.75rem 1rem 0',
        opacity: isRubricLocked && !pointsOnly ? 0.45 : 1,
        pointerEvents: isRubricLocked && !pointsOnly ? 'none' : 'auto',
      }}>
        {pointsTask && !isRubricLocked && (
          // The points box (#181): published with the comment, read back from Schoology.
          <div className="grade-card__score">
            <label className="grade-card__score-label" htmlFor={`points-${assignmentId}-${student.schoology_uid}`}>Score:</label>
            <input
              id={`points-${assignmentId}-${student.schoology_uid}`}
              className={`grade-card__points-input${pointsInvalid ? ' grade-card__points-input--invalid' : ''}`}
              type="text" inputMode="decimal" autoComplete="off"
              value={typedPoints ?? (student.score == null ? '' : String(student.score))}
              onChange={(e) => typePoints(e.target.value)}
              aria-invalid={pointsInvalid || undefined}
            />
            {maxPoints != null && <span className="grade-card__points-max">/ {maxPoints}</span>}
            {pointsInvalid && <span className="grade-card__points-note grade-card__points-note--error">Enter a score of 0 or more.</span>}
            {!pointsInvalid && stagedPoints != null && maxPoints != null && stagedPoints > maxPoints && (
              <span className="grade-card__points-note">Over the maximum of {maxPoints}.</span>
            )}
          </div>
        )}
        {pointsOnly && !(pointsTask && !isRubricLocked) && (
          <div className="grade-card__score">
            <span className="grade-card__score-label">Score:</span>
            <ScoreLabel
              label={gradeLabel({
                score: student.score, max_points: assignmentRow?.max_points, exception: student.exception,
                grading_scale_id: assignmentRow?.grading_scale_id, scales,
              })}
              savedLevel={savedGrade?.summary ?? null} firstName={preferredFirstName(student)} reasonLine={student.flag_line ?? null}
            />
          </div>
        )}
        {hasFeedbackRows && (
          <div className="feedback-rows-label">Feedback rows: kept in Prism, not sent to Schoology</div>
        )}
        {!pointsOnly && (!scoreScale || hasFeedbackRows) && (showDescriptors ? (
          <RubricDescriptorGrid
            rows={descriptorRows}
            levels={LEVELS}
            cellState={cellStateFor}
            onSelect={isView ? undefined : selectLevel}
            palette={rubricPalette}
            levelHeaderColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].headerFill]))}
            levelBorderColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].finalBorder]))}
            levelDraftColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].draftFill]))}
            firstColumnLabel={hasFeedbackRows ? 'Criteria' : undefined}
            awardedMark={iePlaceholder}
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
                {hasFeedbackRows ? 'Criteria' : 'Measurement Topic'}
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
              const currentGrade = shownGrade(t.id);
              const pendingGrade = pending[t.id] ?? null;
              const suggestedLevel = suggestedByTopic[t.id] || null;

              return (
                <tr key={t.id}>
                  <td style={{
                    padding: '0.3rem 0.6rem', border: '1px solid var(--border)',
                    fontSize: '0.78rem', color: 'var(--text)',
                  }}>
                    {t.title}
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', opacity: 0.7 }}><TopicSource topic={t} labels={topicLabels} /></div>
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
                      cursor: isView ? 'default' : 'pointer',
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
                        onClick={isView ? undefined : () => selectLevel(t.id, l)}
                        title={isView ? undefined : `Set ${t.title} to ${LEVEL_LABELS[l]}`}
                      >
                        {showCode ? (
                          <span style={{ fontSize: '0.75rem', color: CELL_TEXT }}>
                            {l}
                          </span>
                        ) : null}
                        {isFinal && iePlaceholder && <span className="rubric-cell-mark">{iePlaceholder}</span>}
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
        ))}
        {hasFeedbackRows && (
          <div className="feedback-rows-overall-label">Overall: {scoreScale.name}, sent to Schoology</div>
        )}
        {scoreScale && (
          <>
            <ScaleLevelPicker
              scale={scoreScale}
              syncedCode={shownScaleLevel}
              pendingCode={stagedScale}
              suggestedCode={suggestedScaleLabel ? suggestedScale : null}
              locked={isRubricLocked || isView}
              // Under feedback rows the overall picker follows the Descriptors/Compact toggle.
              showDescriptors={!hasFeedbackRows || viewMode === 'descriptors'}
              onSelect={selectScaleLevel}
            />
            {/* No hint or button on a locked student (an exception): nothing can be staged there. */}
            {hasFeedbackRows && !isRubricLocked && !isView && (
              <div className="feedback-rows-average">
                {average.reason === 'insufficient_evidence' && pending[SCALE] == null && student.scale_level == null
                  ? 'A row is Insufficient Evidence: choose the overall level'
                  : average.level && currentOverall === average.level && student.scale_level == null
                    ? `Average of the rubric rows: ${averageLabel}`
                    : average.level && currentOverall !== average.level
                      ? <button className="ghost accent" onClick={useRubricAverage}>{`Use the rubric average (${averageLabel})`}</button>
                      : null}
              </div>
            )}
            {/* What the agent checked to suggest this level (teacher-facing). */}
            {suggestedScaleLabel && scaleEvidence && (
              <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--ai-suggest)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <AiSparkle size={12} />
                {`Suggested ${suggestedScaleLabel}: ${scaleEvidence}`}
              </div>
            )}
          </>
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
              {/* Use and Ignore act on the comment editor, which a view card does not draw. */}
              {!isView && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
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
              </div>}
            </div>
          )}
        </div>
      )}

      {/* A view card: the published comment as text (none drawn when there is none). */}
      {isView && syncedComment.trim() !== '' && (
        <div style={{ padding: '0.75rem 1rem' }}>
          <div className="grade-card__comment-view text-sm">
            <span className="grade-card__comment-label">Comment:</span>{syncedComment}
          </div>
        </div>
      )}

      {/* Overall Comment — the hero */}
      {!isView && <div style={{ padding: '0.75rem 1rem' }}>
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
          {commentDirty && draftMark}
          {comment.trim() && (
            <button
              type="button"
              className="ghost btn-sm"
              onClick={addUpdate}
              title="Add a dated update line above the comment, for example after a grade appeal"
            >
              Add update
            </button>
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
          ref={commentBoxRef}
          value={comment}
          onChange={e => applyComment(e.target.value)}
          onKeyDown={commentHistory.onKeyDown}
          onPaste={e => {
            const raw = e.clipboardData.getData('text/plain');
            if (!raw) return;
            e.preventDefault();
            const cleaned = normalizePastedText(raw);
            const el = e.target;
            const { selectionStart, selectionEnd } = el;
            const next = comment.slice(0, selectionStart) + cleaned + comment.slice(selectionEnd);
            applyComment(next, { step: true });
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
          {/* Display-to-student: eye icon + switch, no text label. With no comment there is
              nothing to display, so the card names that instead (#184). */}
          {hasComment ? (<>
          <button
            type="button"
            role="switch"
            aria-checked={display}
            aria-label="Display to student"
            onMouseEnter={displayPop.handlers.onMouseEnter}
            onMouseLeave={displayPop.handlers.onMouseLeave}
            onFocus={displayPop.handlers.onFocus}
            onBlur={displayPop.handlers.onBlur}
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
          {displayPop.popover('Show this comment to the student. This switch does not hide the grade.')}
          </>) : (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', alignSelf: 'stretch',
                boxSizing: 'border-box', border: '1px dashed var(--border)', borderRadius: 7,
                padding: '0 0.55rem', color: 'var(--text-muted)', fontSize: '0.78rem', whiteSpace: 'nowrap',
              }}
            >
              No comment
            </span>
          )}

          <button
            className="primary"
            onClick={handleSave}
            disabled={saving || !canPublish || (!isRubricLocked && !scoreScale && !pointsTask && !scale.ready)}
            title={heldLevels
              ? 'Publish the comment and Display to Schoology. Your staged levels stay as a draft until the flag is cleared.'
              : rowsOnlySave ? 'Save the feedback rows in Prism (nothing is sent to Schoology)' : 'Publish scores & comment to Schoology'}
          >
            {saving
              ? (rowsOnlySave ? 'Saving...' : 'Publishing...')
              : (heldLevels ? 'Publish the comment only' : rowsOnlySave ? 'Save in Prism' : 'Publish to Schoology')}
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

          {/* Done (a card edited in place, #176): back to the view, the draft kept. */}
          {onDone && (
            <button type="button" className="ghost" style={{ marginLeft: 'auto' }} onClick={handleDone}>Done</button>
          )}
        </div>
      </div>}
    </div>
  );
}
