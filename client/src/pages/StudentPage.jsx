import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { formatDate } from '../lib/formatDate.js';
import {
  getStudent, updateStudent, updateParent,
  createNote, updateNote, deleteNote, startSync, getRubricConfig,
} from '../services/api.js';
import MasteryPerformanceSummary from '../components/MasteryPerformanceSummary.jsx';
import { useBackgroundSync } from '../hooks/useBackgroundSync.js';
import SyncStatus from '../components/SyncStatus.jsx';
import SyncHelp from '../components/SyncHelp.jsx';
import { useSyncFacts } from '../hooks/useSyncFacts.js';
import SyncDialog from '../components/SyncDialog.jsx';
import StudentRubricCard from '../components/gradeCard/StudentRubricCard.jsx';
import { cardInputs, cardReasons } from '../lib/cardInputs.js';
import { useGradeCards } from '../hooks/useGradeCards.js';
import { useCardEditing } from '../hooks/useCardEditing.js';
import StudentAlerts from '../components/StudentAlerts.jsx';
import RecentTasks from '../components/RecentTasks.jsx';
import { CopyEmail } from '../components/roster/RosterCard.jsx';
import { useAttemptLinks } from '../hooks/useAttemptLinks.js';
import { useStudentWorkLinks, useStudentCommentSummaries, useStudentFileSummaries } from '../hooks/useStudentFeedbackLinks.js';
import { hasNativeSubmission } from '../components/SubmissionFiles.jsx';
import { useDataVersion, useBumpDataVersion } from '../hooks/useDataVersion.jsx';
import { formatGradeBadge } from '../lib/gradeLevel.js';
import { preferredFirstName } from '../lib/studentNames.js';
import { usePrivateDetails } from '../lib/privateDetails.js';
import { PrivateHidden } from '../components/PrivateDetails.jsx';
import StudentTags from '../components/StudentTags.jsx';
import { BirthdayMark } from '../components/Birthday.jsx';
import { Tip } from '../components/HelpDot.jsx';

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
    <Tip
      as="button"
      className="tap-target"
      onClick={handleCopy}
      text={label || 'Copy'}
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
    </Tip>
  );
}

// The thread is worth a chip once the student handed something in, it is graded,
// or a read found comments: a chip on every untouched task would be noise.
const commentsWorthAChip = (g, summary) => !!summary || !!g.submission_type || Number(g.submitted_at) > 0
  || g.lti_submission_state === 'submitted' || g.score != null;

// One course of the student page: the mastery summary, then each task as the grade card (#176) in
// view mode, editable in place (Edit, Done) on a course Prism can write (`course.writable` from the
// grade-cards route: not archived, excluded or a linked set). The cards come from
// GET /api/students/:id/grade-cards, this student's data only, loaded while the course is expanded.
// The card is in meeting mode: the page may be on a shared screen, so no portrait and no AI
// suggestion. `grades` (GET /api/students/:id) lists the tasks. `workLinks` ({ [aid]: OneDrive
// link }), `commentSummaries` and `fileSummaries` ({ [aid]: summary }, null when the feature is off)
// arrive after the page renders, this student's only. After a flag write or when a card leaves edit
// mode, `onGradesChange` reloads the page's student (GET /api/students/:id), then this course's
// summary and cards reload; the other courses stay as they are.
export function CourseSection({
  course, grades, studentUid, scales, attemptLinks = {}, rubricPalette = {},
  studentId = null, workLinks = {}, commentSummaries = null, onCommentSummary = () => {},
  fileSummaries = null, onFileSummary = () => {},
  refreshKey = 0,
  onGradesChange = null,
}) {
  const [expanded, setExpanded] = useState(true);
  // The page syncs its courses in the background and bumps `refreshKey` when a sync ends: the summary
  // and the cards reload with it. `ownReload` reloads this course only (a write on one of its tasks).
  const [ownReload, setOwnReload] = useState(0);
  const reloadKey = refreshKey + ownReload;
  const { cards, course: cardCourse, loading, error, refetchOne } = useGradeCards({
    studentId, courseId: course.id, enabled: expanded, reloadKey,
  });
  const writable = cardCourse?.writable === true;
  // A failed read of the student throws (the Flags pill says the page could not refresh).
  async function courseChanged() {
    if (onGradesChange) await onGradesChange();
    setOwnReload((v) => v + 1);
  }
  // Edit and Done in place; several tasks may be open for editing at once (each card is independent).
  const edit = useCardEditing({ cards, refetchOne, onChange: courseChanged });
  // Collapsing leaves edit mode (the card's unmount sends its queued draft save): opened again, the
  // course shows its cards as read again, never an editor built from the cards held before.
  function toggleExpanded() {
    if (expanded) edit.stopEditing();
    setExpanded(!expanded);
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button className="student-course__head" onClick={toggleExpanded}>
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
              canOverride={cardCourse ? writable : !course.archived}
              studentUid={studentUid}
              courseName={course.course_name}
              reloadKey={reloadKey}
            />
          </div>

          {error && (
            <div className="alert alert-warning" role="alert">Could not load the grades for this course. Reload the page.</div>
          )}

          {/* One row per task: the grade card, the same component as the assessment page and the
              gradebook pop-up (#176). */}
          <table>
            <thead>
              <tr>
                <th>Assignment</th>
              </tr>
            </thead>
            <tbody>
              {grades.map(g => {
                const aid = g.schoology_assignment_id;
                const assessmentHref = `/course/${g.course_id}/assessment/${aid}`;
                // Name → the assignment's /assessment/ page, for every assignment (as in the
                // gradebook + Assessments tab): unaligned work is graded there too (#41).
                const title = (
                  <Link to={assessmentHref} className="link" style={{ fontWeight: 600 }}>
                    {g.assignment_title}
                  </Link>
                );
                const card = edit.card(aid);
                const summary = commentSummaries?.[aid] || null;
                const showComments = commentSummaries !== null && studentId != null && commentsWorthAChip(g, summary);
                // The student's own Schoology uploads, every revision (#107, #162).
                const showFiles = fileSummaries !== null && studentId != null && hasNativeSubmission(g, g);
                let body;
                if (card) {
                  const { topics, rubric, student } = cardInputs({
                    topics: card.topics, scoreScale: card.scoreScale, rubricData: card.rubric, student: card.student,
                  });
                  const isEditing = writable && edit.isEditing(aid);
                  body = (
                    <>
                      <StudentRubricCard
                        mode={isEditing ? 'edit' : 'view'}
                        meeting
                        heading={title}
                        showDue
                        hasDraft={card.hasDraft}
                        draftRow={card.draft}
                        feedbackRow={null}
                        reasons={cardReasons(card, summary)}
                        student={student}
                        topics={topics}
                        rubric={rubric}
                        rubricPalette={rubricPalette}
                        scoreScale={card.scoreScale}
                        scales={scales}
                        courseId={course.id}
                        assignmentId={aid}
                        assignmentRow={card.assignment}
                        submissionLink={workLinks[aid] || null}
                        attemptLink={attemptLinks[aid] || null}
                        commentsEnabled={showComments}
                        commentSummary={summary}
                        onCommentSummary={(_, s) => onCommentSummary(aid, s)}
                        filesEnabled={showFiles}
                        fileSummary={fileSummaries?.[aid] || null}
                        onFileSummary={(_, s) => onFileSummary(aid, s)}
                        resubmitEnabled={writable}
                        resubmitLessonsDefault={edit.resubmitLessons}
                        onEdit={writable ? () => edit.startEdit(aid) : null}
                        onDone={() => edit.finishEdit(aid)}
                        onSaved={(_, patch) => edit.saved(aid, patch)}
                        onRefreshPair={() => edit.refreshTask(aid)}
                      />
                      {edit.editError(aid) && <div className="alert alert-warning" role="alert">{edit.editError(aid)}</div>}
                    </>
                  );
                } else {
                  body = (
                    <>
                      <div style={{ marginBottom: '0.35rem' }}>{title}</div>
                      {loading && <p className="text-sm text-muted">Loading…</p>}
                    </>
                  );
                }
                return (
                  <tr key={`${g.course_id}-${g.assignment_id}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="text-sm" style={{ verticalAlign: 'top' }}>{body}</td>
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
// feature on (the student then carries `guardians_synced_at`; with it off, no `contact`:
// every parent is shown and copied as before). Do not contact and deceased are family
// facts, kept behind Show family alerts with the family alerts (#185); every guardian not cleared
// as contactable is left out of Copy all. The reason is shown as the API sends it.
// #173: contact.email is the address to show (PowerSchool's, else Schoology's) and
// contact.copy the only addresses that may get a mailto link, a copy button or a place in
// Copy all ([] unless contactable; never one a flagged guardian holds), and contact.tel the
// only numbers that may get a tel: link (the same rule, numbers compared by digits).
// contact.ps.phone is PowerSchool's number; parents.phone and parents.extra_email are the
// teacher's own, labelled "Added in Prism", and left out when they repeat the number or
// address already shown. Off: the Schoology email and the extra email, both copied, and
// the teacher's phone linked.
// See docs/design-language.md "PowerSchool alerts".
const REVEAL_ONLY = new Set(['do_not_contact', 'deceased']);
const NOT_CHECKED = { status: 'not_checked', primary: false, reason: 'Not checked against PowerSchool yet' };
// Fail safe: with the feature on, a parent the API sent no contact for is not checked.
const withContact = (p, checking) => (checking && !p.contact ? { ...p, contact: NOT_CHECKED } : p);
const isRevealOnly = (p) => REVEAL_ONLY.has(p.contact?.status);
const emailKey = (e) => (e || '').trim().toLowerCase();
const phoneKey = (n) => String(n ?? '').replace(/\D/g, '');
const shownEmail = (p) => (p.contact && p.contact.email !== undefined ? p.contact.email : p.email);
function copyList(p) {
  // Fail safe: only a contactable guardian is ever copied, whatever copy holds.
  if (p.contact) return p.contact.status === 'contactable' ? p.contact.copy || [] : [];
  const out = [];
  for (const e of [p.email, p.extra_email]) if (emailKey(e) && !out.some((c) => emailKey(c) === emailKey(e))) out.push(e);
  return out;
}
const isCopyable = (p) => copyList(p).length > 0;
// The numbers that may be tel: links. Fail safe as copyList: only a contactable guardian's.
function telList(p) {
  if (p.contact) return p.contact.status === 'contactable' ? p.contact.tel || [] : [];
  return p.phone ? [p.phone] : [];
}
// Copy all: each address once (emailKey), under the first guardian that copies it.
function copyAllText(parents) {
  const seen = new Set();
  return parents.flatMap((p) => copyList(p).filter((e) => !seen.has(emailKey(e)) && seen.add(emailKey(e)))
    .map((e) => `${p.first_name} ${p.last_name} <${e}>`)).join('; ');
}
const hasAddress = (p) => !!(emailKey(shownEmail(p)) || emailKey(p.extra_email));

const AddedInPrism = () => <span className="text-muted contact-added">Added in Prism</span>;

// One address: a mailto link and a copy button only when `linked`, else plain text.
function ContactEmail({ email, linked, added }) {
  return (
    <p className="text-sm contact-email">
      {linked ? (
        <>
          <a href={`mailto:${email}`} className="link">{email}</a>
          <CopyButton text={email} />
        </>
      ) : <span className="contact-email-plain">{email}</span>}
      {added && <AddedInPrism />}
    </p>
  );
}

function ContactPhone({ phone, linked, added }) {
  return (
    <p className="text-sm">
      {linked ? <a href={`tel:${phone}`} className="link">{phone}</a> : phone}
      {added && <AddedInPrism />}
    </p>
  );
}

function ParentCard({ parent, studentId, onUpdated, revealed = false }) {
  const [editing, setEditing] = useState(false);
  const [phoneVal, setPhoneVal] = useState('');
  const [extraVal, setExtraVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function startEditing() {
    setPhoneVal(parent.phone || '');
    setExtraVal(parent.extra_email || '');
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateParent(studentId, parent.id, { phone: phoneVal.trim() || null, extra_email: extraVal.trim() || null });
      setEditing(false);
      onUpdated();
    } catch (e) {
      setError(e.message); // e.g. the server's "Extra email must be an email address"
    } finally {
      setSaving(false);
    }
  }

  const status = parent.contact?.status;
  const restricted = !!status && status !== 'contactable';
  const revealOnly = isRevealOnly(parent);
  if (status === 'deceased' && !revealed) return null;
  const nameOnly = status === 'do_not_contact' && !revealed;

  // Not cleared: copyList and telList are empty, so no detail gets a mailto, tel or copy,
  // and none is one click from an email or a call.
  const copy = copyList(parent);
  const linked = (e) => copy.some((c) => emailKey(c) === emailKey(e));
  const tel = telList(parent);
  const dialable = (n) => tel.some((t) => phoneKey(t) === phoneKey(n));
  const address = shownEmail(parent);
  const psPhone = parent.contact?.ps?.phone;
  // The teacher's own details, unless they repeat what is already shown.
  const extraPhone = parent.phone && !(psPhone && phoneKey(parent.phone) === phoneKey(psPhone)) ? parent.phone : null;
  const extraEmail = parent.extra_email && emailKey(parent.extra_email) !== emailKey(address) ? parent.extra_email : null;

  return (
    <div style={{ padding: '0.5rem 0.65rem', background: 'var(--bg-subtle)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <p className="text-sm parent-name">
        <span style={{ fontWeight: 600 }}>{parent.first_name} {parent.last_name}</span>
        {/* Which PowerSchool guardian this contact is, so the correspondence alerts (G1, G2, G1+G2) read against
            the right card (28 Oct 2026). Primary contact: the guardian (or, for G1+G2, both) the school writes to. */}
        {parent.contact?.ps?.slot && (
          <Tip className="contact-slot" text={`Guardian ${parent.contact.ps.slot} in PowerSchool`}>G{parent.contact.ps.slot}</Tip>
        )}
        {status === 'contactable' && parent.contact.primary && <span className="badge badge-pink">Primary contact</span>}
        {!revealOnly && !editing && (
          <button
            className="ghost accent tap-target parent-edit-btn"
            onClick={startEditing} aria-label="Edit extra phone and email"
          >Edit</button>
        )}
      </p>
      {!nameOnly && (
        <>
          {restricted && parent.contact.reason && <p className="text-sm text-muted">{parent.contact.reason}</p>}
          {address && <ContactEmail email={address} linked={linked(address)} />}
          {parent.relationship && <p className="text-sm text-muted">{parent.relationship}</p>}
          {psPhone && <ContactPhone phone={psPhone} linked={dialable(psPhone)} />}
          {extraPhone && <ContactPhone phone={extraPhone} linked={dialable(extraPhone)} added />}
          {extraEmail && <ContactEmail email={extraEmail} linked={linked(extraEmail)} added />}
          {editing && (
            <div className="parent-edit">
              <label className="text-sm">
                Extra phone
                <input type="tel" value={phoneVal} onChange={(e) => setPhoneVal(e.target.value)} className="parent-detail-input" />
              </label>
              <label className="text-sm">
                Extra email
                <input type="email" value={extraVal} onChange={(e) => setExtraVal(e.target.value)} className="parent-detail-input" />
              </label>
              {error && <p className="alert alert-error text-sm parent-edit__error" role="alert">{error}</p>}
              <div className="parent-edit__actions">
                <button className="primary" onClick={save} disabled={saving}>Save</button>
                <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
              </div>
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
  // #197: with Private details off the page shows who the student is (photo, name, grade, number, Email),
  // Recent tasks and the courses with their grades and feedback (Graham, 27 Oct 2026; #185), and one PrivateHidden box in place of
  // the alerts, family contacts and notes, which are not in the page.
  // A grade card in edit mode saves its draft when it unmounts, so turning the switch off loses no work.
  const [privateOn] = usePrivateDetails();
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
  // The Unread comments filter on the courses (#185): only tasks with an unread student comment.
  const [unreadOnly, setUnreadOnly] = useState(false);
  useEffect(() => { setUnreadOnly(false); }, [id]);
  // The Show family alerts reveal (#185), shared by the family alert badges and the guardian cards (#66).
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
  // After a flag write on one of the tasks (#40), or when a task's card leaves edit mode (#176): the
  // student reloads here, and that task's course reloads its own summary and cards (CourseSection).
  // A failed read throws, so the Flags pill says the page could not refresh.
  async function handleGradesChange() {
    const s = await getStudent(id);
    setStudent(s);
  }
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
  // The reporting-category colours of an attached rubric's rows, for every card on the page.
  const [rubricPalette, setRubricPalette] = useState({});
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => getRubricConfig())
      .then((c) => { if (active) setRubricPalette(c?.reportingCategoryColors || {}); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
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

  const titleName = displayedFullName;
  const gradeBadge = student.grad_year ? formatGradeBadge(student.grad_year) : null;
  const studentNumber = student.email?.includes('@') ? student.email.split('@')[0] : null;
  const alertsShown = alertsShownFor === student.id;
  const parents = (student.parents || []).map((p) => withContact(p, 'guardians_synced_at' in student));
  const revealOnlyCount = parents.filter(isRevealOnly).length;
  const copyableParents = parents.filter(isCopyable);
  const notCopied = parents.filter((p) => hasAddress(p) && !isCopyable(p)).length;
  // A deceased guardian has no card until Show family alerts (#66, #185).
  const shownCards = parents.filter((p) => alertsShown || p.contact?.status !== 'deceased').length;

  // Tasks with an unread student comment, from this student's comment summaries (null: the feature is off).
  const unreadAids = new Set(Object.entries(commentSummaries || {})
    .filter(([, summary]) => summary?.unread > 0).map(([aid]) => String(aid)));
  const unreadTasks = student.grades.filter((g) => unreadAids.has(String(g.schoology_assignment_id))).length;
  const filtering = unreadOnly && commentSummaries !== null;
  const gradesByCourse = {};
  for (const g of student.grades) {
    if (filtering && !unreadAids.has(String(g.schoology_assignment_id))) continue;
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
                  <BirthdayMark student={student} />{/* public: "Birthday today" only (#191) */}
                  {privateOn && <StudentTags student={student} />}{/* age and gender: not in the page with Private details off */}
                </div>
                {/* One line under the name, as on the roster card (#185): grade, student number (the email's
                    local part) and an Email copy button. */}
                <div className="student-meta">
                  {gradeBadge && (
                    <Tip text={`Graduating ${student.grad_year}`}>{gradeBadge.grade ? `Grade ${gradeBadge.grade}` : `Class of ${student.grad_year}`}</Tip>
                  )}
                  {studentNumber && <Tip className="student-meta__number" text="Student number">{studentNumber}</Tip>}
                  {student.email && <span><CopyEmail email={student.email} /></span>}
                </div>
                {privateOn && (
                  <StudentAlerts
                    studentId={student.id} alerts={student.ps_alerts || []} syncedAt={student.ps_alerts_synced_at}
                    familyShown={alertsShown} onFamilyShownChange={(v) => setAlertsShownFor(v ? student.id : null)}
                    extraCount={revealOnlyCount}
                  />
                )}
                {showLegalName && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.2rem' }}>Legal name: {legalFullName}</p>
                )}
                {/* PowerSchool's Demographics screen (#191): private. */}
                {privateOn && student.home_room && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.2rem' }}>Home room: {student.home_room}</p>
                )}
                {privateOn && student.guardianship && (
                  <p className="text-sm text-muted" style={{ marginTop: '0.2rem' }}>Guardianship: {student.guardianship}</p>
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
              </div>
            </div>
          </div>

          {!privateOn && <PrivateHidden title="Alerts, family contacts and notes are private." />}
          {/* Family Contacts */}
          {privateOn && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Family Contacts</h3>
              {copyableParents.length > 0 && (
                <span className="family-copy-all">
                  <CopyButton
                    text={copyAllText(copyableParents)}
                    label="Copy all emails"
                  />
                  {notCopied > 0 && <span className="text-sm text-muted">{notCopied} not copied</span>}
                </span>
              )}
            </div>
            {'guardians_synced_at' in student && shownCards > 0 && (
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
          )}
        </div>
      </div>

      <RecentTasks student={student} />

      {/* Notes: private (#197). */}
      {privateOn && (
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: addingNote || student.notes.length > 0 ? '0.75rem' : 0 }}>
          <h3 style={{ margin: 0 }}>Notes</h3>
          {!addingNote && (
            <Tip
              as="button"
              className="note-add-btn"
              onClick={() => setAddingNote(true)}
              text="Add new note"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z"/>
                <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9a.75.75 0 0 1 1.5 0v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z"/>
              </svg>
            </Tip>
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
      )}

      {/* Per-course collapsible sections: grades and feedback show with Private details off too
          (Graham, 27 Oct 2026). */}
      {syncCourses.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', margin: '1.5rem 0 0.5rem' }}>
          <h3 style={{ margin: 0, fontWeight: 600 }}>Courses</h3>
          {commentSummaries !== null && (unreadTasks > 0 || unreadOnly) && (
            <button type="button" className={`filter-btn student-unread-filter${unreadOnly ? ' active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}>
              Unread comments <span className="filter-btn__n">{unreadTasks}</span>
            </button>
          )}
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
        // Keyed per student as well as per course: the route keeps this page mounted from /student/A
        // to /student/B, and B's tasks must not open in A's edit mode.
        return (
          <CourseSection
            key={`${student.id}-${course.id}`}
            course={course}
            grades={grades}
            studentUid={student.schoology_uid}
            scales={student.grading_scales}
            attemptLinks={attemptLinks}
            rubricPalette={rubricPalette}
            studentId={student.id}
            workLinks={workLinks}
            commentSummaries={commentSummaries}
            onCommentSummary={setCommentSummary}
            fileSummaries={fileSummaries}
            onFileSummary={setFileSummary}
            refreshKey={dataVersion + syncVersion}
            onGradesChange={handleGradesChange}
          />
        );
      })}

      {student.grades.length === 0 && (
        <div className="card"><p className="text-muted">No grades yet.</p></div>
      )}
      {filtering && unreadTasks === 0 && student.grades.length > 0 && (
        <div className="card"><p className="text-muted">No task has an unread comment now.</p></div>
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
