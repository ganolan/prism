import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import LargerScreenNote from '../components/LargerScreenNote.jsx';
import { useParams, Link, useSearchParams, Navigate, useLocation } from 'react-router-dom';
import { getMasteryForAssignment, getSyncRun, getQuizGroupFor, getSubmissionLinks, getFeedbackForAssignment, getAssessmentAnalysis, syncMasteryForAssignment, getRubricForAssignment, getRubricConfig, getDraftsForAssignment, getSettings, loadQuizResults, rebuildQuizOverall, getAssignmentCommentSummaries, getAssignmentFileSummaries } from '../services/api.js';
import { cardInputs, usesFeedbackRows } from '../lib/cardInputs.js';
import StudentRubricCard from '../components/gradeCard/StudentRubricCard.jsx';
import { useCardBatch } from '../hooks/useCardBatch.js';
import { resolveRubricScores, distributionByTopic } from '../lib/rubricSuggestions.js';
import { useDataVersion } from '../hooks/useDataVersion.jsx';
import { LEVELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';
import RubricManagerModal from '../components/RubricManagerModal.jsx';
import AiSparkle from '../components/AiSparkle.jsx';
import SchoologyLink from '../components/SchoologyLink.jsx';
import PublishToggle from '../components/PublishTask.jsx';
import QuizChip from '../components/quiz/QuizChip.jsx';
import QuizSetupModal from '../components/quiz/QuizSetupModal.jsx';
import QuestionsTab from '../components/quiz/QuestionsTab.jsx';
import FreeResponseTab from '../components/quiz/FreeResponseTab.jsx';
import QuizLoadWarnings from '../components/quiz/QuizLoadWarnings.jsx';
import { useAttemptLinks } from '../hooks/useAttemptLinks.js';
import { useQuizGroup } from '../hooks/useQuizGroup.js';
import { useQuizResults } from '../hooks/useQuizResults.js';
import AssessmentFilterBar from '../components/AssessmentFilterBar.jsx';
import { passesFilters, studentReasons, REASONS, filterGroups, parseFilterParam } from '../lib/assessmentFilters.js';
import { useStickyTab } from '../hooks/useStickyTab.js';
import { formatDateTime } from '../lib/formatDate.js';
import { workLinksStatusText } from '../lib/workLink.js';
import { lineDate } from '../lib/statusLines.js';
import { isFinalFlag } from '../lib/flags.js';
import { afterRefresh } from '../lib/assessmentFreshness.js';
import SyncStatus from '../components/SyncStatus.jsx';
import SyncHelp from '../components/SyncHelp.jsx';
import { useHelpPop } from '../components/HelpDot.jsx';
import { useSyncFacts } from '../hooks/useSyncFacts.js';
import { useBackgroundSync } from '../hooks/useBackgroundSync.js';
import SyncDialog from '../components/SyncDialog.jsx';
import { usePrivateDetails } from '../lib/privateDetails.js';
import { PrivateHidden } from '../components/PrivateDetails.jsx';

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

const RUN_POLL_MS = 1000;

// Follow a queue run by its id until it is no longer waiting or running → the run (with its
// summary), or null once `wanted()` says nobody is looking any more. `wanted` is checked after
// every wait too, so a page that was left makes no further request.
async function waitForRun(runId, wanted) {
  for (;;) {
    const run = await getSyncRun(runId);
    if (!['queued', 'running', 'held'].includes(run.status)) return run;
    if (!wanted()) return null;
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
    if (!wanted()) return null;
  }
}

// #197: every part of the assessment page is private (grades, comments, submissions, results), so with
// Private details off only the way back to the course and the PrivateHidden box are in the page. The
// page itself unmounts: each grade card in edit mode saves its draft as it unmounts, and turning the
// switch on again mounts a fresh page that reads the task, its drafts included.
// A linked quiz's tab content sits in the panel its active tab joins (#194); without a quiz, as it is.
function QuizTabPanel({ on, first, children }) {
  if (!on) return children;
  return <div className={`tab-panel${first ? ' tab-panel--first' : ''}`}>{children}</div>;
}

export default function AssessmentSummaryPage() {
  const [privateOn] = usePrivateDetails();
  const { id: courseId } = useParams();
  if (privateOn) return <AssessmentSummaryBody />;
  return (
    <div className="fade-in">
      <Link to={`/course/${courseId}`} className="link" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>← Back to course</Link>
      <PrivateHidden className="private-hidden--page" title="This assessment's grades, comments and submissions are private." />
    </div>
  );
}

function AssessmentSummaryBody() {
  const { id: courseId, assignmentId } = useParams();
  const dataVersion = useDataVersion();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [followRun, setFollowRun] = useState(null); // the chip opens the progress on this run
  const [refreshResult, setRefreshResult] = useState(null);
  const [feedbackByStudent, setFeedbackByStudent] = useState({});
  const [draftByStudent, setDraftByStudent] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Per-student OneDrive work links for lti_submission assignments (#120).
  // Loaded after the page (the server drives a browser, so it takes seconds).
  const [workLinks, setWorkLinks] = useState({ status: null, links: {} });
  const workLinksNote = workLinksStatusText(workLinks);
  const [commentSummaries, setCommentSummaries] = useState(null);
  const commentPoll = useRef(null);
  // Native dropbox file chips (#107): cached counts only; a chip reads the
  // student's files from Schoology when opened. null = the feature is off.
  const [fileSummaries, setFileSummaries] = useState(null);
  // Bumped per lookup; a response for a superseded lookup (e.g. the teacher
  // moved to another assignment mid-fetch) is dropped, so a card can never
  // link to a different assignment's file.
  const workLinksReq = useRef(0);
  // Each student's attempt on a linked or combined Schoology test (linked quizzes, phase 1).
  const location = useLocation();
  const { group: quizGroup, setGroup: setQuizGroup, enabled: quizzesEnabled } = useQuizGroup(assignmentId);
  // Attempt links refresh after Load results (the group's loaded_at changes).
  const attemptLinks = useAttemptLinks({ assignmentId, reloadKey: `${dataVersion}|${quizGroup?.loaded_at ?? ''}` });
  const [quizTab, setQuizTab] = useStickyTab('assessment-quiz', 'grading', { param: 'tab' });
  const [quizResultsKey, setQuizResultsKey] = useState(0);
  // Only on the linked result task; refetched after a load, an FRQ change on the other tabs, or an update.
  const quizResults = useQuizResults({
    groupId: quizGroup?.id ?? null,
    enabled: !!quizGroup?.result,
    reloadKey: `${dataVersion}|${quizGroup?.loaded_at ?? ''}|${quizGroup?.comment_template ?? ''}|${quizTab}|${quizResultsKey}`,
  });
  // Update numbers: refetch only the suggestions and the quiz line, so the cards stay mounted and the
  // teacher keeps their place (a full load() would show Loading... and scroll to the top).
  async function handleRebuildQuiz(studentId) {
    await rebuildQuizOverall(quizGroup.id, studentId);
    setQuizResultsKey(k => k + 1);
    const feedback = await getFeedbackForAssignment(assignmentId).catch(() => null);
    if (feedback) setFeedbackByStudent(feedback);
  }
  const [quizSetupOpen, setQuizSetupOpen] = useState(false);
  const [quizLoad, setQuizLoad] = useState({ busy: false, message: null });
  // The group id currently on screen; a Load results response for another
  // group (the teacher navigated mid-load) is dropped.
  const quizGroupIdRef = useRef(null);
  quizGroupIdRef.current = quizGroup?.id ?? null;
  useEffect(() => { setQuizLoad({ busy: false, message: null }); }, [quizGroup?.id]);
  useEffect(() => () => { quizGroupIdRef.current = null; }, []);
  // The load is a run in the server's sync queue. It answers at once when the run finishes within
  // its wait; otherwise 202 { runId }, and the button follows that run until it is finished.
  async function handleLoadQuiz() {
    const groupId = quizGroup.id;
    setQuizLoad({ busy: true, message: null });
    try {
      let r = await loadQuizResults(groupId);
      if (r.runId != null) {
        const run = await waitForRun(r.runId, () => quizGroupIdRef.current === groupId);
        if (!run) return;
        if (run.summary?.quizError) throw new Error(run.summary.quizError.message);
        if (!run.summary?.quiz) throw new Error('The load did not finish: try again');
        // The run succeeded: a failed read of the group afterwards must not turn that into an error.
        // The line below still says "loaded"; the group refreshes on the next visit.
        const fresh = await getQuizGroupFor(assignmentId).then((x) => x.group, () => null);
        r = { summary: run.summary.quiz, group: fresh };
      }
      if (quizGroupIdRef.current !== groupId) return;
      if (r.group) setQuizGroup(r.group);
      const failed = r.summary.failed?.length ? `, ${r.summary.failed.length} failed` : '';
      setQuizLoad({ busy: false, message: `${r.summary.attempts} attempts loaded${failed}` });
    } catch (e) {
      if (quizGroupIdRef.current !== groupId) return;
      setQuizLoad({ busy: false, message: e.message });
    }
  }

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
  // ?filter=to_grade,draft (triage links) preselects pills; a new task or link resets them.
  const [urlParams] = useSearchParams();
  const filterParam = urlParams.get('filter');
  const [activeFilters, setActiveFilters] = useState(() => parseFilterParam(filterParam));
  useEffect(() => { setActiveFilters(parseFilterParam(filterParam)); }, [filterParam, assignmentId]);
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

  const visibilityPop = useHelpPop();
  // "Discard all" is destructive across every student, so it requires a second
  // confirming click (armed → confirm). Disarms on mouse-leave or after firing.
  const [discardAllArmed, setDiscardAllArmed] = useState(false);
  // "Mark all <level>" for a score-scale assignment (#41) — also a two-click confirm.
  const [markAllArmed, setMarkAllArmed] = useState(false);

  // Patch a single student in place after its card saves, instead of reloading
  // the whole page (#50). Avoids the "Loading..." flash that unmounted every
  // card on every save during a grading run.
  const handleCardSaved = useCallback((uid, patch) => {
    setData(prev => (prev ? {
      ...prev,
      students: prev.students.map(s => (s.schoology_uid === uid ? { ...s, ...patch } : s)),
    } : prev));
  }, []);

  // After a flag write (#40): this student's fresh row from the page's own read, patched in place
  // (the other cards keep their state). → the fresh student, or null when the read failed.
  // A failed read throws (the card's Flags pill then says the page could not refresh).
  const handleRefreshPair = useCallback(async (uid) => {
    const next = await getMasteryForAssignment(courseId, assignmentId);
    const fresh = next?.students?.find((s) => s.schoology_uid === uid) || null;
    if (fresh) handleCardSaved(uid, fresh);
    return fresh;
  }, [courseId, assignmentId, handleCardSaved]);

  // The "Send all" bar's state and batch (#51), shared with the Attempts tab (#200).
  const {
    pendingByUid, displayByUid, cardsRef, bulkSaving, bulkResult, setBulkResult,
    onPendingChange: handlePendingChange, onDisplayChange: handleDisplayChange, registerCard, unregisterCard, publishAll,
  } = useCardBatch({ courseId, students: data?.students, onSaved: handleCardSaved });

  // A card has an unpublished Prism draft while it reports pending changes. Every
  // card stays mounted (filtered-out cards are only hidden), so this covers them all.
  const hasDraft = useCallback((st) => Boolean(pendingByUid[st.schoology_uid]), [pendingByUid]);
  // Who the filter shows is worked out when the filter changes (or the data reloads,
  // or the teacher asks), not on every save: a card stays in view while it is being
  // worked on, even once its reason is resolved.
  const [filterEpoch, setFilterEpoch] = useState(0);
  const commentSummaryOf = useCallback((st) => commentSummaries?.[st.id] || null, [commentSummaries]);
  const filterCtx = data ? { assignment: data.assignment, topics: data.topics, hasDraft, commentSummaryOf } : null;
  const shownUids = useMemo(() => {
    if (!data || activeFilters.size === 0) return null;
    return new Set(data.students.filter(st => passesFilters(st, activeFilters, filterCtx)).map(st => st.schoology_uid));
  }, [activeFilters, filterEpoch, data?.assignment]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each card reports its draft once mounted, after the data arrives: work the filter
  // out again then, so a link to "Draft not published" finds the drafts.
  useEffect(() => { if (data) setFilterEpoch(n => n + 1); }, [data?.assignment]); // eslint-disable-line react-hooks/exhaustive-deps
  // The submission-comment summaries arrive after the data: work the filter out again
  // then too, so a link to "Unread comment" finds them.
  const commentsLoaded = commentSummaries !== null;
  useEffect(() => { if (commentsLoaded) setFilterEpoch(n => n + 1); }, [commentsLoaded]);
  const isShown = (uid) => !shownUids || shownUids.has(uid);
  // Shown cards whose reasons no longer match (resolved since the filter ran).
  const resolvedCount = shownUids && data
    ? data.students.filter(st => shownUids.has(st.schoology_uid) && !passesFilters(st, activeFilters, filterCtx)).length
    : 0;

  // The class-wide bar acts on the cards shown. Publish all counts the cards it would send;
  // Discard all and the unsaved count include levels a final flag holds back (#177).
  const totalPending = Object.keys(pendingByUid).filter(isShown).filter(u => pendingByUid[u] === 'publish').length;
  const totalUnsaved = Object.keys(pendingByUid).filter(isShown).length;

  // Class-wide visibility aggregate for the bulk "show all to students" toggle. A card with no
  // comment reports null (it has no Display, #184) and is left out.
  const visUids = Object.keys(displayByUid).filter(isShown).filter(u => displayByUid[u] !== null);
  const noComments = visUids.length === 0;
  const visibleCount = visUids.filter(u => displayByUid[u]).length;
  const allVisible = visUids.length > 0 && visibleCount === visUids.length;
  const noneVisible = visibleCount === 0;
  const mixedVisible = !allVisible && !noneVisible;

  // Push a visibility value to every card (each marks itself pending only if the
  // value differs from its synced state). Used by the bulk toggle.
  function handleSetAllVisible(value) {
    for (const uid of Object.keys(cardsRef.current).filter(isShown)) cardsRef.current[uid]?.setDisplay?.(value);
  }

  const handleSendAll = () => publishAll(isShown);

  // Stage the scale's bulk level (e.g. Completed) on every shown card with no
  // grade yet (#41). Nothing is written: the teacher reviews, then publishes.
  function handleMarkAll(level) {
    if (!markAllArmed) { setMarkAllArmed(true); return; }
    setMarkAllArmed(false);
    let staged = 0;
    for (const [uid, card] of Object.entries(cardsRef.current)) {
      if (isShown(uid) && card?.stageScaleLevel?.(level.code)) staged++;
    }
    setBulkResult(staged
      ? `Marked ${staged} student${staged !== 1 ? 's' : ''} ${level.label}: review, then publish`
      : `Every shown student already has a grade`);
  }

  // Stage every shown card's agent scale suggestion (#41, PrisMCP scale_level)
  // that differs from its grade. Staging only — the teacher still publishes.
  function handleAcceptAllSuggestions() {
    let staged = 0;
    for (const [uid, card] of Object.entries(cardsRef.current)) {
      if (isShown(uid) && card?.acceptScaleSuggestion?.()) staged++;
    }
    setBulkResult(`Accepted ${staged} suggestion${staged !== 1 ? 's' : ''}: review, then publish`);
  }

  // Revert every card with unsaved changes back to its synced state (#51 sibling
  // of Send all). First click arms a confirm; the second click actually discards.
  // Each pending card discards its own local draft; the cards' pending-change
  // reports then clear pendingByUid.
  function handleDiscardAll() {
    const uids = Object.keys(pendingByUid).filter(isShown);
    if (uids.length === 0) return;
    if (!discardAllArmed) { setDiscardAllArmed(true); return; }
    setDiscardAllArmed(false);
    for (const uid of uids) cardsRef.current[uid]?.discard?.();
    setBulkResult(null);
  }

  // quiet: no "Loading" screen (a background refresh swapping in newer data keeps the cards mounted).
  function load({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    Promise.all([
      getMasteryForAssignment(courseId, assignmentId),
      getFeedbackForAssignment(assignmentId).catch(() => ({})),
      getAssessmentAnalysis(assignmentId).catch(() => null),
      getDraftsForAssignment(assignmentId).catch(() => ({})),
      // With the rest, so a card never mounts without its feedback rows.
      // Best-effort: a missing rubric never blocks the grade grid.
      getRubricForAssignment(assignmentId).catch(() => null),
    ])
      .then(([mastery, feedback, analysisRow, drafts, rubric]) => {
        setData(mastery);
        setNewerInSchoology(false);
        setRubricData(rubric || null);
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
      .then(r => settle({ status: r.status, provider: r.provider || null, links: r.links || {} }))
      .catch(() => settle({ status: 'error', links: {} }));
  }

  // Sync Assignment: a forced task run in the server's queue (the task's details, submissions,
  // grades, comment threads, then its mastery); the chip follows it and the page reloads at the end.
  async function handleRefresh() {
    setRefreshResult(null);
    if (data?.assignment?.is_lti_submission) loadWorkLinks({ refresh: true });
    try {
      const r = await syncMasteryForAssignment(courseId, assignmentId);
      backgroundSync.follow(r.runId);
    } catch (err) {
      setRefreshResult(`Error: ${err.message}`);
    }
  }

  useEffect(() => { load(); }, [courseId, assignmentId, dataVersion]);

  // Background sync: after the page loads, the server syncs this task in full when it was last synced
  // (or tried) over 10 minutes ago. When a sync of it ends, newer data swaps in only when no card has
  // unsaved changes; otherwise a banner asks for a save or discard first, since a reload would drop a
  // draft that no longer matches Schoology. An archived course is only re-read by Sync Assignment.
  const dataRef = useRef(null);
  dataRef.current = data;
  const pendingRef = useRef(pendingByUid);
  pendingRef.current = pendingByUid;
  const [newerInSchoology, setNewerInSchoology] = useState(false);
  async function afterMasteryRefresh() {
    const next = await getMasteryForAssignment(courseId, assignmentId).catch(() => null);
    const step = afterRefresh(dataRef.current, next, pendingRef.current);
    if (step === 'ask') setNewerInSchoology(true);
    else if (step === 'reload') load({ quiet: true });
    // The label follows every sync, even one that changed nothing on the cards (or one waiting on
    // a save): only the task's sync times and removal are taken over here.
    if (next?.assignment && step !== 'reload') {
      const { task_synced_at: taskSyncedAt, task_sync_attempted_at: attemptedAt, removed_at: removedAt } = next.assignment;
      setData((d) => (d ? { ...d, assignment: { ...d.assignment, task_synced_at: taskSyncedAt, task_sync_attempted_at: attemptedAt, removed_at: removedAt } } : d));
    }
  }
  const syncFacts = useSyncFacts(); // whether the night's refresh is on, for the Synced time's help
  const backgroundSync = useBackgroundSync(
    data && !data.course?.archived ? { kind: 'task', courseId: Number(courseId), assignmentId: String(assignmentId) } : null,
    {
      onDone: async (status, runId) => {
        await afterMasteryRefresh();
        // The comment threads the run started are read in the background: look again when they should be done.
        const queued = (await getSyncRun(runId).catch(() => null))?.summary?.comments?.queued ?? 0;
        clearTimeout(commentPoll.current);
        if (queued > 0) commentPoll.current = setTimeout(() => loadCommentSummaries(false), Math.min(60000, queued * 700 + 2000));
        else loadCommentSummaries(false);
      },
    },
  );

  // Submission comment badges. The first read also queues a background read of
  // the submitted cells; one later re-read picks up what it found. null = the
  // feature is off or unreachable, so no chips show.
  function loadCommentSummaries(refresh) {
    Promise.resolve().then(() => getAssignmentCommentSummaries(assignmentId, { refresh }))
      .then((r) => {
        setCommentSummaries(r.students || {});
        if (refresh && r.refresh?.queued > 0) {
          clearTimeout(commentPoll.current);
          commentPoll.current = setTimeout(() => loadCommentSummaries(false), Math.min(60000, r.refresh.queued * 700 + 2000));
        }
      })
      .catch(() => {});
  }
  useEffect(() => {
    setCommentSummaries(null);
    loadCommentSummaries(true);
    return () => clearTimeout(commentPoll.current);
  }, [assignmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleCommentSummary = useCallback((studentId, summary) => {
    setCommentSummaries((prev) => ({ ...(prev || {}), [studentId]: summary }));
  }, []);
  useEffect(() => {
    let active = true;
    setFileSummaries(null);
    Promise.resolve().then(() => getAssignmentFileSummaries(assignmentId))
      .then((r) => { if (active) setFileSummaries(r.students || {}); })
      .catch(() => {});
    return () => { active = false; };
  }, [assignmentId]);
  const handleFileSummary = useCallback((studentId, summary) => {
    setFileSummaries((prev) => ({ ...(prev || {}), [studentId]: summary }));
  }, []);

  const isLti = !!data?.assignment?.is_lti_submission;
  useEffect(() => {
    workLinksReq.current++;
    setWorkLinks({ status: null, links: {} });
    if (isLti) loadWorkLinks();
  }, [courseId, assignmentId, isLti]); // eslint-disable-line react-hooks/exhaustive-deps

  // The reporting-category colour palette (Task 13); the attached rubric loads
  // in load(). Best-effort: a config failure never blocks the grade grid.
  useEffect(() => {
    let active = true;
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
    if (shownUids && !shownUids.has(s.schoology_uid)) setActiveFilters(new Set());
    setHighlightId(focusStudentId);
    requestAnimationFrame(() => document.getElementById(`student-card-${focusStudentId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }));
    const t = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(t);
  }, [focusStudentId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;
  if (quizGroup && quizGroup.canonical_schoology_id && String(quizGroup.canonical_schoology_id) !== String(assignmentId)) {
    return <Navigate replace to={`/course/${courseId}/assessment/${quizGroup.canonical_schoology_id}${location.search}`} />;
  }

  const { assignment, topics, students } = data;
  const scoreScale = data.scoreScale || null;
  const bulkLevel = scoreScale?.bulkLevel ? scoreScale.levels.find(l => l.code === scoreScale.bulkLevel) : null;
  const hasAnalysis = Object.keys(feedbackByStudent).length > 0 || !!analysis;
  // One banner for suggestions made from old data (#131). The server decides which are stale
  // (data_stale: the data was over 10 minutes older than the suggestion; never a teacher's own
  // grade); the banner names the oldest, and data_as_of 'never' (made before the task was ever
  // synced) is older than any time.
  const staleSuggestions = Object.values(feedbackByStudent).filter(f => f.data_stale);
  const neverSynced = staleSuggestions.some(f => f.data_as_of === 'never');
  const oldestStaleDataTime = staleSuggestions.map(f => f.data_as_of).filter(t => t && t !== 'never').sort()[0] ?? null;

  const alignedTopics = topics;
  // The card's inputs, shared with every other place the card is shown (lib/cardInputs.js).
  const hasFeedbackRows = usesFeedbackRows(scoreScale, rubricData);
  const { topics: cardTopics, rubric: cardRubric } = cardInputs({ topics, scoreScale, rubricData, student: null });
  const cardStudent = (s) => cardInputs({ topics, scoreScale, rubricData, student: s }).student;
  // Agent suggestions still open, on an unlocked student: a scale level that
  // differs from the grade, or (feedback rows) a row level that differs from
  // the row's final.
  const openScaleSuggestions = scoreScale ? students.filter(s => {
    if (isFinalFlag(s.exception)) return false; // a marker takes suggestions: it is graded straight through
    const parsed = feedbackByStudent[s.id]?.feedback_parsed;
    const lv = parsed?.scale_level;
    if (lv && lv !== s.scale_level) return true;
    if (!hasFeedbackRows) return false;
    const scores = cardStudent(s).scores;
    return Object.entries(resolveRubricScores(parsed?.rubric_scores, cardTopics))
      .some(([topicId, level]) => scores?.[topicId]?.grade !== level);
  }).length : 0;
  const shownCount = shownUids ? shownUids.size : students.length;
  // The selected pills, named for the empty-filter message.
  const pillLabels = Object.fromEntries([
    ...Object.entries(REASONS).map(([id, r]) => [id, r.label]),
    ...filterGroups(assignment).flatMap(g => g.pills.map(p => [p.id, p.label])),
  ]);
  const activeLabels = [...activeFilters].map(id => pillLabels[id] || id);

  return (
    <div className="fade-in">
      <LargerScreenNote />
      {/* With a linked quiz's tabs, the active tab joins the panel right under this header (#194). */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)',
        marginBottom: quizGroup ? 0 : '1.25rem', padding: quizGroup ? '0.55rem 0 0' : '0.55rem 0',
        borderBottom: quizGroup ? 'none' : '1px solid var(--border)',
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
          {/* The due date stands out on its own (17/10/2026): the cards' timelines leave
              it out and say only how late each submission was. */}
          {assignment.due_date && (
            <span className="due-chip" title="Due date in Schoology">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
              </svg>
              Due {lineDate(assignment.due_date.slice(0, 10))} {assignment.due_date.slice(11, 16)}
            </span>
          )}
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
          {/* Publish or unpublish the task on Schoology (#184), where Prism can write. An unpublished
              task hides every grade and comment on it, which Triage counts as feedback hidden. */}
          {data.course?.writable === true && assignment.id != null && (
            <PublishToggle courseId={data.course.id} assignment={assignment}
              onChange={(published) => setData((d) => (d ? { ...d, assignment: { ...d.assignment, published } } : d))} />
          )}
          {/* #58: when this task last had a full sync, and the button for one now; the check line is
              the page's own background read (#52, #108). */}
          <SyncStatus
            label="Sync Assignment"
            syncedAt={assignment.task_synced_at}
            archived={Boolean(data.course?.archived)}
            sync={backgroundSync}
            onSync={handleRefresh}
            onOpen={(runId) => setFollowRun(runId)}
            help={<SyncHelp button="Sync Assignment" nightly={syncFacts.nightlyData?.nightly ?? false} archived={Boolean(data.course?.archived)} />}
          />
          {followRun != null && (
            // No onSyncComplete: the chip's run is the hook's, whose onDone reloads past the unsaved-draft guard.
            <SyncDialog followRunId={followRun} onClose={() => setFollowRun(null)} />
          )}
          {refreshResult && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>{refreshResult}</span>
          )}
          {assignment.removed_at && (
            <div className="alert alert-warning" role="alert" style={{ flexBasis: '100%' }}>This task was deleted in Schoology.</div>
          )}
          {newerInSchoology && (
            <div className="alert alert-warning" role="alert" style={{ flexBasis: '100%' }}>
              Schoology has newer levels or comments for this assignment. Save or discard your changes, then reload to see them.{' '}
              <button type="button" className="secondary" onClick={() => load()}>Reload</button>
            </div>
          )}
          {workLinksNote && (
            <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }} title={workLinksNote.title}>
              {workLinksNote.text}
            </span>
          )}

          {/* Rubric view toggle (Task 13) — Descriptors (default) shows the
              student-language descriptor prose per level; Compact falls back to
              the dense level-code table. Hidden for a score scale (#41), whose
              one-row picker has no compact form, unless it has feedback rows. */}
          {(!scoreScale || hasFeedbackRows) && (
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

          {quizzesEnabled && (assignment.is_test === 1 || quizGroup) && (
            <>
              <button className="secondary" style={{ fontSize: '0.78rem' }} onClick={() => setQuizSetupOpen(true)}>Quiz setup…</button>
              {quizGroup && (
                <>
                  <QuizChip group={quizGroup} />
                  <button className="secondary" style={{ fontSize: '0.78rem' }} disabled={quizLoad.busy} onClick={handleLoadQuiz}>
                    {quizLoad.busy ? 'Loading results…' : 'Load results'}
                  </button>
                  <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>
                    {quizLoad.message || (quizGroup.loaded_at ? `loaded ${formatDateTime(`${quizGroup.loaded_at.replace(' ', 'T')}Z`)}` : 'not loaded')}
                  </span>
                </>
              )}
            </>
          )}

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
          onSetMany={(ids, on) => setActiveFilters(prev => {
            const next = new Set(prev);
            for (const id of ids) { if (on) next.add(id); else next.delete(id); }
            return next;
          })}
          onClear={() => setActiveFilters(new Set())}
          hasDraft={hasDraft}
          commentSummaryOf={commentSummaryOf}
          shown={shownCount}
          total={students.length}
          footer={resolvedCount > 0 && (
            <>
              {'. '}{resolvedCount} no longer {resolvedCount === 1 ? 'matches' : 'match'}.{' '}
              <button type="button" className="filter-btn-link" onClick={() => setFilterEpoch(n => n + 1)}>Update the list</button>
            </>
          )}
        />
        {quizGroup && <QuizLoadWarnings group={quizGroup} students={students} />}
        {quizGroup && (
          <div role="tablist" aria-label="Quiz views" className="tab-row tab-row--joined" style={{ marginTop: '0.4rem' }}>
            <button role="tab" aria-selected={quizTab === 'grading'} className={`tab-btn${quizTab === 'grading' ? ' active' : ''}`} onClick={() => setQuizTab('grading')}>Grading</button>
            <button role="tab" aria-selected={quizTab === 'questions'} className={`tab-btn${quizTab === 'questions' ? ' active' : ''}`} onClick={() => setQuizTab('questions')}>Questions</button>
            {quizGroup.frq_count > 0 && (
              <button role="tab" aria-selected={quizTab === 'frq'} className={`tab-btn${quizTab === 'frq' ? ' active' : ''}`} onClick={() => setQuizTab('frq')}>Free response</button>
            )}
          </div>
        )}
      </div>

      <QuizTabPanel on={Boolean(quizGroup)} first={quizTab === 'grading'}>
      {quizGroup && quizTab === 'questions' ? (
        <QuestionsTab groupId={quizGroup.id} courseId={quizGroup.course_id} reloadKey={quizGroup.loaded_at} />
      ) : quizGroup && quizTab === 'frq' && quizGroup.frq_count > 0 ? (
        <FreeResponseTab groupId={quizGroup.id} reloadKey={quizGroup.loaded_at} />
      ) : students.length === 0 ? (
        <div className="card">
          <p className="text-muted">No students found. Run a mastery sync for this course first.</p>
        </div>
      ) : (
        <>
          {staleSuggestions.length > 0 && (
            <div className="alert alert-warning" role="alert">
              {neverSynced
                ? 'AI suggestions were made before this task was ever synced. Sync Assignment, then grade again for current data.'
                : `AI suggestions were made from data as of ${formatDateTime(oldestStaleDataTime)}. Sync Assignment, then grade again for current data.`}
            </div>
          )}
          {shownCount === 0 && (
            <div className="card">
              <p className="text-muted" style={{ marginTop: 0 }}>No students match {activeLabels.length <= 3 ? activeLabels.join(' + ') : 'the selected filters'}.</p>
              <button type="button" className="secondary btn-sm" onClick={() => setActiveFilters(new Set())}>Clear filters</button>
            </div>
          )}
          {/* Every card stays mounted (a hidden card keeps its unsaved draft and still
              reports it); the filter only hides the cards it leaves out. */}
          {students.map((student) => (
            <div key={student.schoology_uid} hidden={!isShown(student.schoology_uid)}>
            <StudentRubricCard
              reasons={studentReasons(student, filterCtx)}
              student={cardStudent(student)}
              topics={cardTopics}
              courseId={courseId}
              assignmentId={assignmentId}
              assignmentRow={assignment}
              feedbackRow={feedbackByStudent[student.id] || null}
              draftRow={draftByStudent[student.id] || null}
              rubric={cardRubric}
              viewMode={viewMode}
              rubricPalette={rubricPalette}
              submissionLink={workLinks.links[student.schoology_uid] || null}
              attemptLink={attemptLinks[student.id] || null}
              quizResult={quizResults[student.id] || null}
              onRebuildQuiz={handleRebuildQuiz}
              commentsEnabled={commentSummaries !== null}
              commentSummary={commentSummaries?.[student.id] || null}
              onCommentSummary={handleCommentSummary}
              filesEnabled={fileSummaries !== null}
              fileSummary={fileSummaries?.[student.id] || null}
              onFileSummary={handleFileSummary}
              scoreScale={scoreScale}
              resubmitLessonsDefault={resubmitLessonsDefault}
              // Writes only where Prism may write the course (not archived, excluded or a linked
              // set, #178): the server's own rule, so no control is shown that it would refuse.
              resubmitEnabled={data.course?.writable === true}
              highlight={highlightId === student.id}
              onSaved={handleCardSaved}
              onRefreshPair={handleRefreshPair}
              onPendingChange={handlePendingChange}
              onDisplayChange={handleDisplayChange}
              registerCard={registerCard}
              unregisterCard={unregisterCard}
            />
            </div>
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
              aria-label="Comment visibility for all students"
              onMouseEnter={visibilityPop.handlers.onMouseEnter}
              onMouseLeave={visibilityPop.handlers.onMouseLeave}
              onFocus={visibilityPop.handlers.onFocus}
              onBlur={visibilityPop.handlers.onBlur}
              onClick={() => handleSetAllVisible(!allVisible)}
              disabled={bulkSaving || noComments}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                boxSizing: 'border-box', height: '2rem',
                border: '1px solid var(--border)', borderRadius: 7,
                padding: '0 0.6rem', background: 'var(--card-bg)',
                color: 'var(--text-muted)', cursor: bulkSaving || noComments ? 'default' : 'pointer',
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
              <span style={{ display: 'inline-block', width: '5.6rem', textAlign: 'left', whiteSpace: 'nowrap' }}>
                {noComments ? 'No comments' : allVisible ? 'All shown' : noneVisible ? 'All hidden' : 'Mixed'}
              </span>
            </button>
            {visibilityPop.popover('Show or hide every comment. This switch does not hide grades.')}

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
              disabled={bulkSaving || totalUnsaved === 0}
              title="Discard all unsaved changes across every student"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.4rem 0.75rem', borderRadius: 7,
                border: `1px solid ${totalUnsaved > 0 ? 'var(--danger)' : 'var(--border)'}`,
                background: discardAllArmed ? 'var(--danger)' : (totalUnsaved > 0 ? 'var(--danger-bg)' : 'var(--card-bg)'),
                color: discardAllArmed ? '#fff' : (totalUnsaved > 0 ? 'var(--danger)' : 'var(--border)'),
                cursor: (totalUnsaved > 0 && !bulkSaving) ? 'pointer' : 'default',
                fontSize: '0.8rem', fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {discardAllArmed ? 'Click again to confirm' : 'Discard all'}
            </button>
            {!bulkSaving && totalUnsaved > 0 && (
              <span className="text-sm text-muted">
                {totalUnsaved} student{totalUnsaved !== 1 ? 's' : ''} with unsaved changes
              </span>
            )}
            {bulkResult && (
              <span className="text-sm text-muted">{bulkResult}</span>
            )}
          </div>
        </>
      )}
      </QuizTabPanel>

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
              topics={cardTopics}
              feedbackRows={Object.values(feedbackByStudent)}
              analysis={analysis?.analysis_parsed || null}
            />
          </div>
        </>
      )}

      <QuizSetupModal
        open={quizSetupOpen}
        courseId={courseId}
        currentAssignment={{ schoology_assignment_id: String(assignmentId), title: assignment.title }}
        group={quizGroup}
        onClose={() => setQuizSetupOpen(false)}
        onChanged={(g) => { setQuizGroup(g); setQuizSetupOpen(false); }}
        onUpdated={(g) => setQuizGroup(g)}
      />

      <RubricManagerModal
        open={rubricModalOpen}
        onClose={() => setRubricModalOpen(false)}
        courseId={courseId}
        assignmentId={assignmentId}
        topics={alignedTopics}
        unaligned={!!scoreScale}
        attachment={rubricData}
        onChanged={reloadRubric}
      />
    </div>
  );
}
