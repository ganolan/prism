import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { formatDate, formatDateTime } from '../lib/formatDate.js';
import {
  getStudent, updateStudent, updateParentPhone,
  createNote, updateNote, deleteNote, startSync,
} from '../services/api.js';
import MasteryPerformanceSummary from '../components/MasteryPerformanceSummary.jsx';
import { useBackgroundSync } from '../hooks/useBackgroundSync.js';
import SyncStatus from '../components/SyncStatus.jsx';
import SyncHelp from '../components/SyncHelp.jsx';
import { useSyncFacts } from '../hooks/useSyncFacts.js';
import SyncDialog from '../components/SyncDialog.jsx';
import AssignmentFeedback from '../components/AssignmentFeedback.jsx';
import PsAlertReveal from '../components/PsAlertReveal.jsx';
import AttemptLink from '../components/quiz/AttemptLink.jsx';
import { useAttemptLinks } from '../hooks/useAttemptLinks.js';
import { useAttachedRubrics } from '../hooks/useAttachedRubrics.js';
import { useStudentWorkLinks, useStudentCommentSummaries, useStudentFileSummaries } from '../hooks/useStudentFeedbackLinks.js';
import SchoologyLink from '../components/SchoologyLink.jsx';
import SubmissionComments from '../components/SubmissionComments.jsx';
import SubmissionFiles, { hasNativeSubmission } from '../components/SubmissionFiles.jsx';
import HelpDot from '../components/HelpDot.jsx';
import { CLOCK_HELP, lateText } from '../lib/submissionTimeline.js';
import { gradeLabel, submissionStatus } from '../lib/gradeLabel.js';
import { useDataVersion, useBumpDataVersion } from '../hooks/useDataVersion.jsx';
import { formatGradeBadge } from '../lib/gradeLevel.js';
import { preferredFirstName } from '../lib/studentNames.js';

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e) {
    e.preventDefault();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      className="tap-target"
      onClick={handleCopy}
      title={label || 'Copy'}
      aria-label={label || 'Copy'}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        padding: label ? '0.15rem 0.3rem' : '0 0.2rem',
        color: copied ? 'var(--success)' : 'var(--text-muted)', lineHeight: 1,
        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
        fontSize: '0.75rem',
      }}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
      )}
      {label && <span>{copied ? 'Copied!' : label}</span>}
    </button>
  );
}

const NO_RUBRICS = { attachments: {}, palette: {} };

// The thread is worth a chip once the student handed something in, it is graded,
// or a read found comments: a chip on every untouched task would be noise.
const commentsWorthAChip = (g, summary) => !!summary || !!g.submission_type || Number(g.submitted_at) > 0
  || g.lti_submission_state === 'submitted' || g.score != null;

// `rubrics`: the attached rubrics for the page's assignments, fetched in one batch
// by StudentPage ({ attachments: { [aid]: attachment }, palette }). `workLinks`
// ({ [aid]: OneDrive link }), `commentSummaries` and `fileSummaries` ({ [aid]: summary },
// null when the feature is off) arrive after the page renders, this student's only.
export function CourseSection({
  course, grades, flagsByAssignment, studentUid, scales, studentName = 'the student', attemptLinks = {}, rubrics = NO_RUBRICS,
  studentId = null, workLinks = {}, commentSummaries = null, onCommentSummary = () => {},
  fileSummaries = null, onFileSummary = () => {},
  refreshKey = 0,
}) {
  const [expanded, setExpanded] = useState(true);
  // The page syncs its courses in the background and bumps `refreshKey` when a sync ends: the summary
  // reloads with it.

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button className="student-course__head" onClick={() => setExpanded(e => !e)}>
        <Link
          to={`/course/${course.id}`}
          className="link"
          style={{ fontWeight: 600, fontSize: '1rem' }}
          onClick={e => e.stopPropagation()}
        >
          {course.course_name}
        </Link>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 6,
          background: 'var(--bg-subtle)', border: '1px solid var(--border)',
          color: 'var(--text)', flexShrink: 0,
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.427 6.427a.75.75 0 0 1 1.06 0L8 8.94l2.513-2.513a.75.75 0 0 1 1.06 1.06l-3.043 3.044a.75.75 0 0 1-1.06 0L4.427 7.487a.75.75 0 0 1 0-1.06z"/>
          </svg>
        </span>
      </button>

      {expanded && (
        <div className="student-course__body">
          {/* Mastery Performance Summary (SBG grid) */}
          <div style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>
            <MasteryPerformanceSummary
              courseId={course.id}
              studentUid={studentUid}
              courseName={course.course_name}
              reloadKey={refreshKey}
            />
          </div>

          {/* One row per assignment: the name, then the shared feedback view, the
              same layout as the gradebook modal (#135). */}
          <table>
            <thead>
              <tr>
                <th>Assignment <HelpDot text={CLOCK_HELP(grades.find((g) => g.timeline)?.timeline.limit)} /></th>
              </tr>
            </thead>
            <tbody>
              {grades.map(g => {
                const topics = g.mastery?.topics || [];
                const assessmentHref = `/course/${g.course_id}/assessment/${g.schoology_assignment_id}`;
                const statusBadges = submissionStatus({
                  score: g.score,
                  exception: g.exception,
                  late: g.timeline?.submission?.late ?? g.late,
                  draft: g.draft,
                  submitted_at: g.submitted_at,
                  submission_type: g.submission_type,
                  is_lti_submission: g.is_lti_submission,
                  lti_submission_state: g.lti_submission_state,
                  due_date: g.due_date,
                  accepts_submissions: g.accepts_submissions,
                  is_test: g.is_test,
                });
                const aid = g.schoology_assignment_id;
                const attempt = attemptLinks[aid] || null;
                const workLink = workLinks[aid] || null;
                const summary = commentSummaries?.[aid] || null;
                const showComments = commentSummaries !== null && studentId != null && commentsWorthAChip(g, summary);
                // The student's own Schoology uploads, every revision (#107, #162).
                const showFiles = fileSummaries !== null && studentId != null && hasNativeSubmission(g, g);
                const links = (workLink || attempt || showComments || showFiles) ? (
                  <>
                    {workLink && (
                      <SchoologyLink
                        url={workLink.url}
                        label="Open"
                        ariaLabel={`Open ${studentName}'s work in OneDrive`}
                        title={`Open ${studentName}'s work in OneDrive: last edited ${formatDateTime(workLink.modifiedAt)}`}
                        style={{ fontSize: '0.78rem', fontWeight: 600 }}
                      />
                    )}
                    {showFiles && (
                      <SubmissionFiles assignmentId={aid} studentId={studentId} studentName={studentName}
                        title={g.assignment_title} summary={fileSummaries[aid] || null} onSummary={(s) => onFileSummary(aid, s)} />
                    )}
                    <AttemptLink link={attempt} name={studentName} />
                    {showComments && (
                      <SubmissionComments assignmentId={aid} studentId={studentId} studentName={studentName}
                        title={g.assignment_title} summary={summary} onSummary={(s) => onCommentSummary(aid, s)} />
                    )}
                  </>
                ) : null;
                return (
                  <tr key={`${g.course_id}-${g.assignment_id}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="text-sm" style={{ verticalAlign: 'top' }}>
                      {/* Name → the assignment's /assessment/ page, for every
                          assignment (as in the gradebook + Assessments tab):
                          unaligned work is graded there too (#41). */}
                      <div style={{ marginBottom: '0.35rem' }}>
                        <Link to={assessmentHref} className="link" style={{ fontWeight: 600 }}>
                          {g.assignment_title}
                        </Link>
                      </div>
                      <AssignmentFeedback
                        status={statusBadges}
                        flags={flagsByAssignment?.[g.assignment_id] || []}
                        resubmitted={g.resubmitted}
                        lateTitle={lateText(g.timeline)}
                        assignmentTitle={g.assignment_title}
                        links={links}
                        timeline={g.timeline}
                        timelineHelp={false}
                        due={g.due_date || '-'}
                        topics={topics}
                        attachment={rubrics.attachments[g.schoology_assignment_id] || null}
                        palette={rubrics.palette}
                        exception={g.exception}
                        score={topics.length > 0 ? null : gradeLabel({
                          score: g.score, max_points: g.assignment_max_points,
                          exception: g.exception, grading_scale_id: g.grading_scale_id, scales,
                        })}
                        comment={g.grade_comment}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// A parent's PowerSchool contact check (#66), present only with the powerschool_alerts
// feature on (no `contact`: every parent is shown and copied as before). Do not contact
// and deceased are family facts, kept behind Show alerts with the PowerSchool alerts;
// every guardian not cleared as contactable is left out of Copy all.
// See docs/design-language.md "PowerSchool alerts".
const REVEAL_ONLY = new Set(['do_not_contact', 'deceased']);
const isRevealOnly = (p) => REVEAL_ONLY.has(p.contact?.status);
const isCopyable = (p) => !!p.email && (!p.contact || p.contact.status === 'contactable');

function ParentCard({ parent, studentId, onUpdated, revealed = false }) {
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneVal, setPhoneVal] = useState(parent.phone || '');

  async function savePhone() {
    await updateParentPhone(studentId, parent.id, phoneVal.trim() || null);
    setEditingPhone(false);
    onUpdated();
  }

  const status = parent.contact?.status;
  // Not cleared: no mailto, tel or copy, so the address is never one click from an email.
  const restricted = !!status && status !== 'contactable';
  const revealOnly = isRevealOnly(parent);
  if (status === 'deceased' && !revealed) return null;
  const nameOnly = status === 'do_not_contact' && !revealed;

  return (
    <div style={{ padding: '0.5rem 0.65rem', background: 'var(--bg-subtle)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <p className="text-sm parent-name">
        <span style={{ fontWeight: 600 }}>{parent.first_name} {parent.last_name}</span>
        {revealed && status === 'contactable' && parent.contact.primary && <span className="badge badge-pink">Primary contact</span>}
      </p>
      {!nameOnly && (
        <>
          {restricted && parent.contact.reason && <p className="text-sm text-muted">{parent.contact.reason}</p>}
          {parent.email && (restricted ? (
            <p className="text-sm contact-email"><span className="contact-email-plain">{parent.email}</span></p>
          ) : (
            <p className="text-sm contact-email">
              <a href={`mailto:${parent.email}`} className="link">{parent.email}</a>
              <CopyButton text={parent.email} />
            </p>
          ))}
          {parent.relationship && <p className="text-sm text-muted">{parent.relationship}</p>}
          {revealOnly ? (
            parent.phone && <p className="text-sm" style={{ marginTop: '0.3rem' }}>{parent.phone}</p>
          ) : editingPhone ? (
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', alignItems: 'center' }}>
              <input
                type="tel" value={phoneVal} onChange={e => setPhoneVal(e.target.value)}
                placeholder="Phone number" className="parent-phone-input"
              />
              <button className="primary" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={savePhone}>Save</button>
              <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => { setEditingPhone(false); setPhoneVal(parent.phone || ''); }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem' }}>
              {parent.phone ? (
                <>
                  <p className="text-sm">{restricted ? parent.phone : <a href={`tel:${parent.phone}`} className="link">{parent.phone}</a>}</p>
                  <button className="ghost accent tap-target" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => setEditingPhone(true)}>Edit</button>
                </>
              ) : (
                <button className="ghost accent tap-target" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => setEditingPhone(true)}>+ Add Phone</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function StudentPage() {
  const { id } = useParams();
  const dataVersion = useDataVersion();
  const [student, setStudent] = useState(null);
  const [editing, setEditing] = useState(false);
  const [preferredVal, setPreferredVal] = useState('');
  const [loading, setLoading] = useState(true);

  const [addingNote, setAddingNote] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [noteCourseId, setNoteCourseId] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editNoteText, setEditNoteText] = useState('');

  const [photoEnlarged, setPhotoEnlarged] = useState(false);
  // The Show alerts reveal, shared by the alert badges and the guardian cards (#66).
  // Never remembered: it belongs to one student id, and is cleared when the page's student changes.
  const [alertsShownFor, setAlertsShownFor] = useState(null);
  useEffect(() => { setAlertsShownFor(null); }, [id]);

  useEffect(() => {
    if (!photoEnlarged) return;
    function onKey(e) { if (e.key === 'Escape') setPhotoEnlarged(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photoEnlarged]);

  function reload() {
    getStudent(id)
      .then(s => { setStudent(s); setPreferredVal(s.preferred_name_teacher || ''); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, [id, dataVersion]);

  // Background sync: the student's current courses, in full, when one was last synced (or tried) over
  // 10 minutes ago; when that run ends the page and every course summary reload. Sync Courses here
  // queues those courses now; the chip opens the progress of the run.
  const liveCourseIds = (student?.courses ?? []).filter((c) => !c.archived).map((c) => c.id);
  const [syncVersion, setSyncVersion] = useState(0);
  const [followRun, setFollowRun] = useState(null);
  const bumpDataVersion = useBumpDataVersion();
  const syncFacts = useSyncFacts(); // whether the night's refresh is on, for the Synced time's help
  const backgroundSync = useBackgroundSync(liveCourseIds.length ? { kind: 'courses', courseIds: liveCourseIds } : null, {
    onDone: () => { reload(); setSyncVersion((v) => v + 1); },
  });
  // A student with only archived courses (a past student): the button reads those courses again.
  const allCourses = student?.courses ?? [];
  const syncCourses = liveCourseIds.length ? allCourses.filter((c) => !c.archived) : allCourses;
  async function syncStudentCourses() {
    const r = await startSync({ courseIds: syncCourses.map((c) => c.id), syncBlocks: false }).catch(() => null);
    if (r?.runId != null) backgroundSync.follow(r.runId);
  }
  const oldestSynced = syncCourses.length && syncCourses.every((c) => c.course_synced_at)
    ? syncCourses.map((c) => c.course_synced_at).sort()[0] : null;

  // The student's attempts on linked or combined Schoology tests, by Schoology assignment id.
  const attemptLinks = useAttemptLinks({ studentId: id, reloadKey: dataVersion });
  // Attached rubrics (full descriptors) for every aligned assignment, one request (#135).
  // Every assignment is asked about, so an unaligned task's feedback rows come back
  // too (with this student's row levels only).
  const rubrics = useAttachedRubrics(
    (student?.grades || []).map((g) => g.schoology_assignment_id),
    dataVersion,
    { studentUid: student?.schoology_uid || null },
  );
  // After the page renders: this student's OneDrive copies, a few assignments at a
  // time, and their submission comment summaries (a background read refreshes them).
  const workLinks = useStudentWorkLinks(
    student?.id,
    (student?.grades || []).filter((g) => g.is_lti_submission).map((g) => g.schoology_assignment_id),
    dataVersion,
  );
  const [commentSummaries, setCommentSummary] = useStudentCommentSummaries(student?.id, dataVersion);
  // Their submitted-files chips (#162): cached counts, and a background read of their uploads.
  const [fileSummaries, setFileSummary] = useStudentFileSummaries(student?.id, dataVersion);

  async function handleSave() {
    const updated = await updateStudent(id, preferredVal.trim() || null);
    setStudent(prev => ({ ...prev, ...updated }));
    setEditing(false);
  }

  async function handleAddNote() {
    if (!newNote.trim()) return;
    await createNote({ student_id: parseInt(id), course_id: noteCourseId ? parseInt(noteCourseId) : null, content: newNote });
    setNewNote('');
    setNoteCourseId('');
    reload();
  }

  async function handleUpdateNote(noteId) {
    if (!editNoteText.trim()) return;
    await updateNote(noteId, { content: editNoteText });
    setEditingNoteId(null);
    reload();
  }

  async function handleDeleteNote(noteId) { await deleteNote(noteId); reload(); }

  if (loading) return <div className="loading">Loading...</div>;
  if (!student) return <div className="error-msg">Student not found</div>;

  const displayName = preferredFirstName(student);
  const legalFullName = `${student.first_name} ${student.last_name}`;
  const displayedFullName = `${displayName} ${student.last_name}`;
  const showLegalName = legalFullName !== displayedFullName;
  const assignmentFlagMap = {};
  for (const f of student.flags) {
    if (!f.assignment_id || f.resolved) continue;
    if (!assignmentFlagMap[f.assignment_id]) assignmentFlagMap[f.assignment_id] = [];
    assignmentFlagMap[f.assignment_id].push(f);
  }

  const titleName = displayedFullName;
  const alertsShown = alertsShownFor === student.id;
  const parents = student.parents || [];
  const revealOnlyCount = parents.filter(isRevealOnly).length;
  const copyableParents = parents.filter(isCopyable);
  const notCopied = parents.filter((p) => p.email && !isCopyable(p)).length;

  const gradesByCourse = {};
  for (const g of student.grades) {
    if (!gradesByCourse[g.course_id]) gradesByCourse[g.course_id] = [];
    gradesByCourse[g.course_id].push(g);
  }


  return (
    <div className="fade-in">
      {/* Profile + Family row */}
      <div className="card student-header">
        <div className="grid-2">
          {/* Profile */}
          <div>
            <div className="student-profile">
              {student.picture_url && (
                <img
                  src={student.picture_url} alt={displayName}
                  className="student-photo"
                  onClick={() => setPhotoEnlarged(true)}
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div className="student-profile__info">
                <div className="student-name-row">
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.2 }}>{titleName}</h2>
                  {student.grad_year && (() => {
                    const badge = formatGradeBadge(student.grad_year);
                    if (!badge) return null;
                    return (
                      <span className="badge badge-blue" title={`Graduating ${student.grad_year}`}>
                        {badge.label}
                      </span>
                    );
                  })()}
                  {student.email && student.email.includes('@') && (
                    <span className="text-sm text-muted" title="Student ID">ID: {student.email.split('@')[0]}</span>
                  )}
                </div>
                {(student.ps_alerts?.length || 0) + revealOnlyCount > 0 && (
                  <div style={{ marginTop: '0.35rem' }}>
                    {/* Hidden until clicked, never remembered (the reveal belongs to this student id). */}
                    <PsAlertReveal
                      studentId={student.id} alerts={student.ps_alerts || []} syncedAt={student.ps_alerts_synced_at}
                      shown={alertsShown} onShownChange={(v) => setAlertsShownFor(v ? student.id : null)}
                      extraCount={revealOnlyCount}
                    />
                  </div>
                )}
                {showLegalName && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.2rem' }}>Legal name: {legalFullName}</p>
                )}
                {editing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <label className="text-sm">
                      Preferred name
                      <input
                        type="text" value={preferredVal}
                        onChange={e => setPreferredVal(e.target.value)}
                        placeholder="e.g. Alex"
                        autoFocus
                      />
                    </label>
                    <p className="text-sm text-muted" style={{ margin: 0 }}>
                      Overrides what name is displayed. Leave blank to use Schoology data.
                    </p>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="primary" onClick={handleSave}>Save</button>
                      <button className="secondary" onClick={() => { setEditing(false); setPreferredVal(student.preferred_name_teacher || ''); }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="preferred-name-btn"
                    onClick={() => setEditing(true)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '0.3rem', color: 'var(--text-muted)', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z"/>
                      <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9a.75.75 0 0 1 1.5 0v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z"/>
                    </svg>
                    {student.preferred_name_teacher ? `Preferred: ${student.preferred_name_teacher}` : 'Set preferred name'}
                  </button>
                )}
                {student.email && (
                  <p className="text-sm contact-email" style={{ marginTop: '0.4rem' }}>
                    <a href={`mailto:${student.email}`} className="link">{student.email}</a>
                    <CopyButton text={student.email} />
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Family Contacts */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Family Contacts</h3>
              {copyableParents.length > 0 && (
                <span className="family-copy-all">
                  <CopyButton
                    text={copyableParents.map(p => `${p.first_name} ${p.last_name} <${p.email}>`).join('; ')}
                    label="Copy all emails"
                  />
                  {notCopied > 0 && <span className="text-sm text-muted">{notCopied} not copied</span>}
                </span>
              )}
            </div>
            {'guardians_synced_at' in student && parents.length > 0 && (
              <p className="text-sm text-muted" style={{ marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
                {student.guardians_synced_at ? `Checked against PowerSchool ${formatDate(student.guardians_synced_at)}` : 'Not checked against PowerSchool yet'}
              </p>
            )}
            {parents.length === 0 ? (
              <p className="text-sm text-muted">No parent/guardian contacts synced yet. Run a Schoology sync to pull family data.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {parents.map(p => (
                  <ParentCard key={p.id} parent={p} studentId={id} onUpdated={reload} revealed={alertsShown} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: addingNote || student.notes.length > 0 ? '0.75rem' : 0 }}>
          <h3 style={{ margin: 0 }}>Notes</h3>
          {!addingNote && (
            <button
              className="note-add-btn"
              onClick={() => setAddingNote(true)}
              aria-label="Add new note"
              title="Add new note"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z"/>
                <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9a.75.75 0 0 1 1.5 0v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z"/>
              </svg>
            </button>
          )}
        </div>
        {addingNote && (
          <div className="note-form">
            <textarea
              placeholder="Add a note..."
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              rows={2}
              style={{ flex: 1, resize: 'vertical' }}
              autoFocus
            />
            <div className="note-form__side">
              <select value={noteCourseId} onChange={e => setNoteCourseId(e.target.value)} aria-label="Note course">
                <option value="">General</option>
                {student.courses.map(c => <option key={c.id} value={c.id}>{c.course_name}</option>)}
              </select>
              <button className="primary" onClick={() => { handleAddNote(); setAddingNote(false); }} disabled={!newNote.trim()}>Save</button>
              <button className="ghost" onClick={() => { setAddingNote(false); setNewNote(''); setNoteCourseId(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {student.notes.length === 0 ? (
          <p className="text-sm text-muted">No notes yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {student.notes.map(n => (
              <div key={n.id} style={{ padding: '0.5rem 0.75rem', background: 'var(--bg-subtle)', borderRadius: 8, border: '1px solid var(--border)' }}>
                {editingNoteId === n.id ? (
                  <div className="note-form note-form--edit">
                    <textarea value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={2} style={{ flex: 1 }} />
                    <div className="note-form__side">
                      <button className="primary" onClick={() => handleUpdateNote(n.id)} style={{ fontSize: '0.8rem' }}>Save</button>
                      <button className="ghost" onClick={() => setEditingNoteId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{n.content}</p>
                    <div className="note-meta">
                      <span className="text-sm text-muted">{formatDate(n.created_at)}</span>
                      {n.course_id && <span className="badge badge-blue">{student.courses.find(c => c.id === n.course_id)?.course_name || 'Course'}</span>}
                      <button onClick={() => { setEditingNoteId(n.id); setEditNoteText(n.content); }} className="ghost accent tap-target">Edit</button>
                      <button onClick={() => handleDeleteNote(n.id)} className="ghost danger tap-target">Delete</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-course collapsible sections */}
      {syncCourses.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', margin: '1.5rem 0 0.5rem' }}>
          <h3 style={{ margin: 0, fontWeight: 600 }}>Courses</h3>
          <SyncStatus
            label="Sync Courses"
            syncedAt={oldestSynced}
            archived={!liveCourseIds.length}
            sync={backgroundSync}
            onSync={syncStudentCourses}
            onOpen={(runId) => setFollowRun(runId)}
            help={<SyncHelp button="Sync Courses" nightly={syncFacts.nightlyData?.nightly ?? false} archived={!liveCourseIds.length} />}
          />
        </div>
      )}
      {followRun != null && (
        <SyncDialog followRunId={followRun} onClose={() => setFollowRun(null)} onSyncComplete={bumpDataVersion} />
      )}
      {student.courses.map(course => {
        const grades = gradesByCourse[course.id] || [];
        if (grades.length === 0) return null;
        return (
          <CourseSection
            key={course.id}
            course={course}
            grades={grades}
            flagsByAssignment={assignmentFlagMap}
            studentUid={student.schoology_uid}
            scales={student.grading_scales}
            studentName={`${displayName} ${student.last_name}`}
            attemptLinks={attemptLinks}
            rubrics={rubrics}
            studentId={student.id}
            workLinks={workLinks}
            commentSummaries={commentSummaries}
            onCommentSummary={setCommentSummary}
            fileSummaries={fileSummaries}
            onFileSummary={setFileSummary}
            refreshKey={dataVersion + syncVersion}
          />
        );
      })}

      {student.grades.length === 0 && (
        <div className="card"><p className="text-muted">No grades yet.</p></div>
      )}

      {photoEnlarged && student.picture_url && (
        <div
          onClick={() => setPhotoEnlarged(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, cursor: 'zoom-out', padding: '2rem',
          }}
        >
          <img
            src={student.picture_url} alt={displayName}
            onLoad={e => {
              const img = e.currentTarget;
              img.style.width = `${img.naturalWidth * 2}px`;
              img.style.height = `${img.naturalHeight * 2}px`;
            }}
            style={{
              maxWidth: '90vw', maxHeight: '90vh',
              objectFit: 'contain', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
