import { Fragment, useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getStudent, updateStudent, updateParentPhone,
  createNote, updateNote, deleteNote,
  createFlag, resolveFlag, reopenFlag, deleteFlag,
} from '../services/api.js';
import StudentAnalytics from '../components/StudentAnalytics.jsx';
import MasteryPerformanceSummary from '../components/MasteryPerformanceSummary.jsx';
import { LEVEL_COLORS } from '../components/OverridePopup.jsx';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Compact rubric shown in place of the score column for aligned assignments.
// One row per measurement topic, one column per level. The student's current
// level is filled solid green (matching the AssessmentSummaryPage rubric).
function CompactRubric({ topics }) {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.7rem', lineHeight: 1.2, width: '100%', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{
            padding: '0.2rem 0.45rem', textAlign: 'left',
            background: 'var(--bg-subtle)', border: '1px solid var(--border)',
            fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.65rem',
            width: 'auto',
          }}>Measurement Topic</th>
          {LEVELS.map(l => (
            <th key={l} style={{
              padding: '0.15rem 0.3rem', textAlign: 'center',
              background: LEVEL_COLORS[l].bg, color: LEVEL_COLORS[l].text,
              border: '1px solid var(--border)', fontWeight: 700,
              fontSize: '0.68rem', width: '7%',
            }}>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {topics.map(t => (
          <tr key={t.topic_id}>
            <td style={{
              padding: '0.2rem 0.45rem', border: '1px solid var(--border)',
              fontSize: '0.7rem', color: 'var(--text)',
              whiteSpace: 'normal', wordBreak: 'break-word',
            }}>
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              {(t.external_id || t.category_title) && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                  {t.external_id}{t.external_id && t.category_title ? ' · ' : ''}{t.category_title || ''}
                </div>
              )}
            </td>
            {LEVELS.map(l => {
              const isCurrent = t.grade === l;
              const c = LEVEL_COLORS[l];
              return (
                <td key={l} style={{
                  border: `1px solid ${isCurrent ? c.text : 'var(--border)'}`,
                  textAlign: 'center',
                  padding: '0.2rem 0.3rem',
                  background: isCurrent ? c.bg : 'var(--card-bg)',
                  color: isCurrent ? c.text : 'var(--text-muted)',
                  fontWeight: isCurrent ? 700 : 400,
                  fontSize: '0.7rem',
                }}>{isCurrent ? l : ''}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatFlagReason(flag) {
  if (!flag?.flag_reason) return '';
  if (['missing', 'late_submission'].includes(flag.flag_type)) {
    return flag.flag_reason.replace(/^Missing:\s*/i, '');
  }
  return flag.flag_reason;
}

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

function CourseSection({ course, grades, flagsByAssignment, studentUid }) {
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
                const exLabel = g.exception ? EXCEPTION_LABELS[g.exception] : null;
                const aligned = g.mastery?.topics?.length > 0;
                const assessmentHref = `/course/${g.course_id}/assessment/${g.schoology_assignment_id}`;
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
                      {g.late ? <span className="badge badge-red" style={{ fontSize: '0.65rem' }}>Late</span> : null}
                      {g.draft ? <span className="badge badge-blue" style={{ fontSize: '0.65rem' }}>Draft</span> : null}
                      {exLabel && g.exception !== 4 && <span className={`badge ${g.exception === 3 ? 'badge-red' : 'badge-blue'}`} style={{ fontSize: '0.65rem' }}>{exLabel}</span>}
                      {assignmentFlags.map(flag => {
                        const flagReason = formatFlagReason(flag);
                        const showReason = flagReason && flagReason !== g.assignment_title;
                        return (
                          <span key={flag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span className={`badge ${flag.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
                              {flag.flag_type.replace('_', ' ')}
                            </span>
                            {showReason && <span className="text-xs text-muted">{flagReason}</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
                return (
                  <Fragment key={g.id}>
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
                            {g.score != null
                              ? <span>{g.score}{g.assignment_max_points ? ` / ${g.assignment_max_points}` : ''}</span>
                              : exLabel ? <span className="text-sm text-muted">{exLabel}</span> : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                    {aligned && (
                      <tr>
                        <td colSpan={2} style={{ padding: '0.25rem 0.25rem 0.5rem', borderTop: 'none' }}>
                          <div style={{ width: '100%' }}>
                            <CompactRubric topics={g.mastery.topics} />
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

function CollapsibleCard({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.75rem 1.25rem', background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <h3 style={{ margin: 0 }}>{title}</h3>
        {count != null && <span className="text-sm text-muted">({count})</span>}
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 6, marginLeft: 'auto',
          background: 'var(--bg-subtle)', border: '1px solid var(--border)',
          color: 'var(--text)', flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.427 6.427a.75.75 0 0 1 1.06 0L8 8.94l2.513-2.513a.75.75 0 0 1 1.06 1.06l-3.043 3.044a.75.75 0 0 1-1.06 0L4.427 7.487a.75.75 0 0 1 0-1.06z"/>
          </svg>
        </span>
      </button>
      {open && <div style={{ padding: '0 1.25rem 1.25rem' }}>{children}</div>}
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

  const [flagReason, setFlagReason] = useState('');
  const [flagType, setFlagType] = useState('custom');

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

  async function handleAddFlag() {
    if (!flagReason.trim()) return;
    await createFlag({ student_id: parseInt(id), flag_type: flagType, flag_reason: flagReason });
    setFlagReason('');
    setFlagType('custom');
    reload();
  }

  async function handleResolveFlag(flagId) { await resolveFlag(flagId); reload(); }
  async function handleReopenFlag(flagId) { await reopenFlag(flagId); reload(); }
  async function handleDeleteFlag(flagId) { await deleteFlag(flagId); reload(); }

  if (loading) return <div className="loading">Loading...</div>;
  if (!student) return <div className="error-msg">Student not found</div>;

  // Teacher-set preferred name wins, then Schoology preferred_name, then legal first_name
  const displayName = student.preferred_name_teacher || student.preferred_name || student.first_name;
  const legalFullName = `${student.first_name} ${student.last_name}`;
  const displayedFullName = `${displayName} ${student.last_name}`;
  const showLegalName = legalFullName !== displayedFullName;
  const assignmentFlagMap = {};
  const assignmentLookup = {};
  for (const g of student.grades) {
    if (!assignmentLookup[g.assignment_id]) {
      assignmentLookup[g.assignment_id] = { title: g.assignment_title, courseName: g.course_name };
    }
  }
  for (const f of student.flags) {
    if (!f.assignment_id || f.resolved) continue;
    if (!assignmentFlagMap[f.assignment_id]) assignmentFlagMap[f.assignment_id] = [];
    assignmentFlagMap[f.assignment_id].push(f);
  }
  const activeFlags = student.flags.filter(f => !f.resolved && !f.assignment_id);

  const titleName = displayedFullName;

  const gradesByCourse = {};
  for (const g of student.grades) {
    if (!gradesByCourse[g.course_id]) gradesByCourse[g.course_id] = [];
    gradesByCourse[g.course_id].push(g);
  }

  const coursesWithGrades = student.courses.filter((c, i) => (gradesByCourse[c.id] || []).length > 0);

  return (
    <div className="fade-in">
      {/* Active flags banner */}
      {activeFlags.length > 0 && (
        <div className="alert alert-warning">
          <strong style={{ color: '#92400e' }}>Active flags ({activeFlags.length})</strong>
          {activeFlags.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
              <span className="badge badge-red" style={{ textTransform: 'capitalize' }}>{f.flag_type.replace('_', ' ')}</span>
              <span className="text-sm">{formatFlagReason(f) || f.flag_reason || '—'}</span>
              <button onClick={() => handleResolveFlag(f.id)} className="ghost accent" style={{ marginLeft: 'auto' }}>Resolve</button>
            </div>
          ))}
        </div>
      )}

      {/* Profile + Family row */}
      <div className="card">
        <div className="grid-2">
          {/* Profile */}
          <div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              {student.picture_url && (
                <img
                  src={student.picture_url} alt={displayName}
                  style={{ width: 144, height: 144, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '2px solid var(--border)' }}
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

      {/* Flags — collapsible, collapsed by default */}
      <CollapsibleCard title="Flags" count={student.flags.length} defaultOpen={false}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <input type="text" placeholder="Flag reason..." value={flagReason}
              onChange={e => setFlagReason(e.target.value)} />
          </div>
          <select value={flagType} onChange={e => setFlagType(e.target.value)} style={{ width: 'auto' }}>
            <option value="custom">Custom</option>
            <option value="review_needed">Review Needed</option>
            <option value="late_submission">Late Submission</option>
            <option value="performance_change">Performance Change</option>
          </select>
          <button className="primary" onClick={handleAddFlag} disabled={!flagReason.trim()}>Add Flag</button>
        </div>
        {student.flags.length === 0 ? (
          <p className="text-sm text-muted">No flags.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {student.flags.map(f => {
              const isAssignmentFlag = Boolean(f.assignment_id);
              const isAutoFlag = ['missing', 'late_submission'].includes(f.flag_type);
              const assignment = isAssignmentFlag ? assignmentLookup[f.assignment_id] : null;
              const reasonText = formatFlagReason(f);
              const primaryText = reasonText || assignment?.title || '';
              const showAssignmentLabel = assignment && primaryText !== assignment.title;
              return (
                <div key={f.id} style={{
                  padding: '0.5rem 0.75rem', borderRadius: 8,
                  background: f.resolved ? 'var(--success-light)' : 'var(--warning-light)',
                  border: `1px solid ${f.resolved ? 'var(--success)' : 'var(--warning)'}`,
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  opacity: f.resolved ? 0.7 : 1,
                }}>
                  <span className={`badge ${f.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
                    {f.flag_type.replace('_', ' ')}
                  </span>
                  <span className="text-sm" style={{ flex: 1, textDecoration: f.resolved ? 'line-through' : 'none' }}>
                    {primaryText || '—'}
                    {showAssignmentLabel && (
                      <span className="text-muted" style={{ marginLeft: '0.35rem', fontSize: '0.8rem' }}>
                        {assignment.title}
                      </span>
                    )}
                  </span>
                  <span className="text-sm text-muted">{new Date(f.created_at).toLocaleDateString()}</span>
                  {!isAutoFlag && (
                    f.resolved ? (
                      <button onClick={() => handleReopenFlag(f.id)} className="ghost accent">Reopen</button>
                    ) : (
                      <button onClick={() => handleResolveFlag(f.id)} className="ghost success">Resolve</button>
                    )
                  )}
                  {!isAutoFlag && (
                    <button onClick={() => handleDeleteFlag(f.id)} className="ghost danger">Delete</button>
                  )}
                  {isAutoFlag && (
                    <span className="text-xs text-muted">Auto from Schoology</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleCard>

      {/* Summary analytics (cross-course comparison + performance alerts) */}
      <StudentAnalytics studentId={parseInt(id)} />

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
          />
        );
      })}

      {student.grades.length === 0 && (
        <div className="card"><p className="text-muted">No grades yet.</p></div>
      )}
    </div>
  );
}
