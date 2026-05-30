import { Fragment, useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getStudent, updateStudent, updateParentPhone,
  createNote, updateNote, deleteNote,
} from '../services/api.js';
import MasteryPerformanceSummary from '../components/MasteryPerformanceSummary.jsx';
import CompactRubric from '../components/CompactRubric.jsx';
import SubmissionBadges from '../components/SubmissionBadges.jsx';
import { LEVEL_COLORS } from '../components/OverridePopup.jsx';
import { gradeLabel, submissionStatus } from '../lib/gradeLabel.js';
import { masteryCodeForLevel } from '../lib/masteryLevels.js';

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
      onClick={handleCopy}
      title={label || 'Copy'}
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

const EXCEPTION_LABELS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing', 4: 'Late' };

function gradYearToLevel(gradYear) {
  if (!gradYear) return null;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-indexed
  // Academic year starts in August: if we're past August, grad year minus current year
  const academicYear = currentMonth >= 7 ? currentYear + 1 : currentYear;
  const grade = 12 - (gradYear - academicYear);
  return grade >= 1 && grade <= 12 ? grade : null;
}

export function CourseSection({ course, grades, flagsByAssignment, studentUid, scales }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.85rem 1.25rem', background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
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
        <div style={{ padding: '0 1.25rem 1.25rem' }}>
          {/* Mastery Performance Summary (SBG grid) */}
          <div style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>
            <MasteryPerformanceSummary
              courseId={course.id}
              studentUid={studentUid}
              courseName={course.course_name}
            />
          </div>

          <table>
            <thead>
              <tr>
                <th>Assignment</th>
                <th>Score / Rubric</th>
              </tr>
            </thead>
            <tbody>
              {grades.map(g => {
                const assignmentFlags = flagsByAssignment?.[g.assignment_id] || [];
                const aligned = g.mastery?.topics?.length > 0;
                const assessmentHref = `/course/${g.course_id}/assessment/${g.schoology_assignment_id}`;
                const statusBadges = submissionStatus({
                  score: g.score,
                  exception: g.exception,
                  late: g.late,
                  draft: g.draft,
                  submitted_at: g.submitted_at,
                  submission_type: g.submission_type,
                  due_date: g.due_date,
                });
                const infoCell = (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {/* Name (link only when aligned) */}
                    <div>
                      {aligned ? (
                        <Link to={assessmentHref} className="link" style={{ fontWeight: 600 }}>
                          {g.assignment_title}
                        </Link>
                      ) : (
                        <span style={{ fontWeight: 600 }}>{g.assignment_title}</span>
                      )}
                    </div>
                    {/* Due + flags row */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                      <span className="text-xs text-muted">Due: {g.due_date || '—'}</span>
                      <SubmissionBadges
                        status={statusBadges}
                        flags={assignmentFlags}
                        resubmitted={g.resubmitted}
                        assignmentTitle={g.assignment_title}
                      />
                    </div>
                  </div>
                );
                return (
                  <Fragment key={`${g.course_id}-${g.assignment_id}`}>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      {aligned ? (
                        /* Aligned: name + due/flags span both columns; rubric goes below */
                        <td colSpan={2} style={{ verticalAlign: 'top' }} className="text-sm">
                          {infoCell}
                        </td>
                      ) : (
                        <>
                          <td className="text-sm" style={{ verticalAlign: 'top' }}>{infoCell}</td>
                          <td style={{ verticalAlign: 'top' }}>
                            {(() => {
                              const lbl = gradeLabel({
                                score: g.score, max_points: g.assignment_max_points,
                                exception: g.exception, grading_scale_id: g.grading_scale_id,
                                scales,
                              });
                              const code = lbl.kind === 'scale' ? masteryCodeForLevel(lbl.text) : null;
                              const c = code ? LEVEL_COLORS[code] : null;
                              const style = lbl.kind === 'mismatch' ? { color: 'var(--danger)' }
                                : lbl.kind === 'pending' ? { color: 'var(--text-muted)' }
                                : c ? { background: c.bg, color: c.text, border: `1px solid ${c.border}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block' }
                                : null;
                              return <span className="text-sm" style={style} title={lbl.kind === 'mismatch' ? 'Score does not match any defined level on this grading scale — check Schoology' : undefined}>{lbl.text}</span>;
                            })()}
                          </td>
                        </>
                      )}
                    </tr>
                    {aligned && (
                      <tr>
                        <td colSpan={2} style={{ padding: '0.25rem 0.25rem 0.5rem', borderTop: 'none' }}>
                          <div style={{ width: '100%' }}>
                            {/* Exception (Excused/Incomplete/Missing/Late) deletes
                                score data in Schoology, so the rubric is hidden
                                while the exception is active — show the label
                                in its place. */}
                            {EXCEPTION_LABELS[g.exception] ? (
                              <div className="text-sm" style={{
                                padding: '0.5rem 0.75rem',
                                background: 'var(--bg-subtle)',
                                border: '1px dashed var(--border)',
                                borderRadius: 6,
                                color: 'var(--text-muted)',
                                fontStyle: 'italic',
                              }}>
                                <strong style={{ fontStyle: 'normal', color: 'var(--danger)' }}>{EXCEPTION_LABELS[g.exception]}</strong>
                                {' — rubric hidden because Schoology deletes scores when an exception is set.'}
                              </div>
                            ) : (
                              <CompactRubric topics={g.mastery.topics} />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {g.grade_comment && (
                      <tr>
                        <td colSpan={2} className="text-sm text-muted" style={{
                          paddingTop: '0.25rem', paddingBottom: '0.75rem',
                          fontStyle: 'italic', borderTop: 'none',
                        }}>
                          <span style={{ fontWeight: 600, fontStyle: 'normal', color: 'var(--text-muted)', marginRight: '0.4rem' }}>Comment:</span>
                          {g.grade_comment}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ParentCard({ parent, studentId, onUpdated }) {
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneVal, setPhoneVal] = useState(parent.phone || '');

  async function savePhone() {
    await updateParentPhone(studentId, parent.id, phoneVal.trim() || null);
    setEditingPhone(false);
    onUpdated();
  }

  return (
    <div style={{ padding: '0.5rem 0.65rem', background: 'var(--bg-subtle)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <p className="text-sm" style={{ fontWeight: 600 }}>{parent.first_name} {parent.last_name}</p>
      {parent.email && (
        <p className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
          <a href={`mailto:${parent.email}`} className="link">{parent.email}</a>
          <CopyButton text={parent.email} />
        </p>
      )}
      {parent.relationship && <p className="text-sm text-muted">{parent.relationship}</p>}
      {editingPhone ? (
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', alignItems: 'center' }}>
          <input
            type="tel" value={phoneVal} onChange={e => setPhoneVal(e.target.value)}
            placeholder="Phone number" style={{ flex: 1, fontSize: '0.8rem' }}
          />
          <button className="primary" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={savePhone}>Save</button>
          <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => { setEditingPhone(false); setPhoneVal(parent.phone || ''); }}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem' }}>
          {parent.phone ? (
            <>
              <p className="text-sm"><a href={`tel:${parent.phone}`} className="link">{parent.phone}</a></p>
              <button className="ghost accent" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => setEditingPhone(true)}>Edit</button>
            </>
          ) : (
            <button className="ghost accent" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => setEditingPhone(true)}>+ Add Phone</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function StudentPage() {
  const { id } = useParams();
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

  useEffect(() => { reload(); }, [id]);

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

  // Teacher-set preferred name wins, then Schoology preferred_name, then legal first_name
  const displayName = student.preferred_name_teacher || student.preferred_name || student.first_name;
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

  const gradesByCourse = {};
  for (const g of student.grades) {
    if (!gradesByCourse[g.course_id]) gradesByCourse[g.course_id] = [];
    gradesByCourse[g.course_id].push(g);
  }

  const coursesWithGrades = student.courses.filter((c, i) => (gradesByCourse[c.id] || []).length > 0);

  return (
    <div className="fade-in">
      {/* Profile + Family row */}
      <div className="card">
        <div className="grid-2">
          {/* Profile */}
          <div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              {student.picture_url && (
                <img
                  src={student.picture_url} alt={displayName}
                  style={{ width: 144, height: 144, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '2px solid var(--border)', cursor: 'zoom-in' }}
                  onClick={() => setPhotoEnlarged(true)}
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.2 }}>{titleName}</h2>
                  {student.grad_year && (() => {
                    const gradeLevel = gradYearToLevel(student.grad_year);
                    return (
                      <span className="badge badge-blue" title={`Graduating ${student.grad_year}`}>
                        {gradeLevel ? `Grade ${gradeLevel}` : ''} (Class of {student.grad_year})
                      </span>
                    );
                  })()}
                  {student.email && student.email.includes('@') && (
                    <span className="text-sm text-muted" title="Student ID">ID: {student.email.split('@')[0]}</span>
                  )}
                </div>
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
                  <p className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.15rem', marginTop: '0.4rem' }}>
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
              {student.parents?.some(p => p.email) && (
                <CopyButton
                  text={student.parents.filter(p => p.email).map(p => `${p.first_name} ${p.last_name} <${p.email}>`).join('; ')}
                  label="Copy all emails"
                />
              )}
            </div>
            {(!student.parents || student.parents.length === 0) ? (
              <p className="text-sm text-muted">No parent/guardian contacts synced yet. Run a Schoology sync to pull family data.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {student.parents.map(p => (
                  <ParentCard key={p.id} parent={p} studentId={id} onUpdated={reload} />
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
              onClick={() => setAddingNote(true)}
              aria-label="Add new note"
              title="Add new note"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.15rem 0.3rem', marginLeft: '0.35rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z"/>
                <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9a.75.75 0 0 1 1.5 0v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z"/>
              </svg>
            </button>
          )}
        </div>
        {addingNote && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <textarea
              placeholder="Add a note..."
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              rows={2}
              style={{ flex: 1, resize: 'vertical' }}
              autoFocus
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <select value={noteCourseId} onChange={e => setNoteCourseId(e.target.value)} style={{ fontSize: '0.8rem' }}>
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
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <textarea value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={2} style={{ flex: 1 }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      <button className="primary" onClick={() => handleUpdateNote(n.id)} style={{ fontSize: '0.8rem' }}>Save</button>
                      <button className="ghost" onClick={() => setEditingNoteId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{n.content}</p>
                    <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.3rem', alignItems: 'center' }}>
                      <span className="text-sm text-muted">{new Date(n.created_at).toLocaleDateString()}</span>
                      {n.course_id && <span className="badge badge-blue">{student.courses.find(c => c.id === n.course_id)?.course_name || 'Course'}</span>}
                      <button onClick={() => { setEditingNoteId(n.id); setEditNoteText(n.content); }} className="ghost accent">Edit</button>
                      <button onClick={() => handleDeleteNote(n.id)} className="ghost danger">Delete</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-course collapsible sections */}
      {coursesWithGrades.length > 0 && (
        <h3 style={{ margin: '1.5rem 0 0.5rem', fontWeight: 600 }}>Courses</h3>
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
