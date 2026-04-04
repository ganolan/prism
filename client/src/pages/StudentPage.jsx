import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getStudent, updateStudent, createNote, updateNote, deleteNote, createFlag, resolveFlag, reopenFlag, deleteFlag } from '../services/api.js';
import StudentAnalytics from '../components/StudentAnalytics.jsx';

export default function StudentPage() {
  const { id } = useParams();
  const [student, setStudent] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);

  // Notes state
  const [newNote, setNewNote] = useState('');
  const [noteCourseId, setNoteCourseId] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editNoteText, setEditNoteText] = useState('');

  // Flags state
  const [flagReason, setFlagReason] = useState('');
  const [flagType, setFlagType] = useState('custom');

  function reload() {
    getStudent(id)
      .then(s => { setStudent(s); setForm({ preferred_name: s.preferred_name || '', parent_email: s.parent_email || '', parent_phone: s.parent_phone || '' }); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, [id]);

  async function handleSave() {
    const updated = await updateStudent(id, form);
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

  async function handleDeleteNote(noteId) {
    await deleteNote(noteId);
    reload();
  }

  async function handleAddFlag() {
    if (!flagReason.trim()) return;
    await createFlag({ student_id: parseInt(id), flag_type: flagType, flag_reason: flagReason });
    setFlagReason('');
    setFlagType('custom');
    reload();
  }

  async function handleResolveFlag(flagId) {
    await resolveFlag(flagId);
    reload();
  }

  async function handleReopenFlag(flagId) {
    await reopenFlag(flagId);
    reload();
  }

  async function handleDeleteFlag(flagId) {
    await deleteFlag(flagId);
    reload();
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (!student) return <div className="error-msg">Student not found</div>;

  const displayName = student.preferred_name || student.first_name;
  const activeFlags = student.flags.filter(f => !f.resolved);
  const resolvedFlags = student.flags.filter(f => f.resolved);

  // Group grades by course
  const gradesByCourse = {};
  for (const g of student.grades) {
    if (!gradesByCourse[g.course_id]) {
      gradesByCourse[g.course_id] = { name: g.course_name, grades: [] };
    }
    gradesByCourse[g.course_id].grades.push(g);
  }

  return (
    <div>
      <h2 className="page-title">{displayName} {student.last_name}</h2>
      {student.preferred_name && (
        <p className="text-sm text-muted mb-1">Legal name: {student.first_name} {student.last_name}</p>
      )}

      {/* Active flags banner */}
      {activeFlags.length > 0 && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          <strong style={{ color: '#92400e' }}>Active flags ({activeFlags.length})</strong>
          {activeFlags.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
              <span className="badge badge-red" style={{ textTransform: 'capitalize' }}>{f.flag_type.replace('_', ' ')}</span>
              <span className="text-sm">{f.flag_reason}</span>
              <button onClick={() => handleResolveFlag(f.id)} className="text-sm" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}>Resolve</button>
            </div>
          ))}
        </div>
      )}

      {/* Profile + Family + Courses row */}
      <div className="card">
        <div className="grid-3">
          <div>
            <h3 style={{ marginBottom: '0.75rem' }}>Profile</h3>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label className="text-sm">
                  Preferred Name
                  <input type="text" value={form.preferred_name}
                    onChange={e => setForm(f => ({ ...f, preferred_name: e.target.value }))} />
                </label>
                <label className="text-sm">
                  Parent Email (legacy)
                  <input type="email" value={form.parent_email}
                    onChange={e => setForm(f => ({ ...f, parent_email: e.target.value }))} />
                </label>
                <label className="text-sm">
                  Parent Phone
                  <input type="text" value={form.parent_phone}
                    onChange={e => setForm(f => ({ ...f, parent_phone: e.target.value }))} />
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="primary" onClick={handleSave}>Save</button>
                  <button onClick={() => setEditing(false)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <p><strong>Email:</strong> {student.email || '-'}</p>
                <p><strong>Preferred name:</strong> {student.preferred_name || '-'}</p>
                {student.parent_phone && <p><strong>Parent phone:</strong> {student.parent_phone}</p>}
                <button className="primary" onClick={() => setEditing(true)} style={{ marginTop: '0.5rem', width: 'fit-content' }}>Edit</button>
              </div>
            )}
          </div>
          <div>
            <h3 style={{ marginBottom: '0.75rem' }}>Family Contacts</h3>
            {(!student.parents || student.parents.length === 0) ? (
              <p className="text-sm text-muted">No parent/guardian contacts synced yet. Run a Schoology sync to pull family data.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {student.parents.map(p => (
                  <div key={p.id} style={{ padding: '0.5rem 0.65rem', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <p className="text-sm" style={{ fontWeight: 600 }}>{p.first_name} {p.last_name}</p>
                    {p.email && <p className="text-sm"><a href={`mailto:${p.email}`} className="link">{p.email}</a></p>}
                    {p.relationship && <p className="text-sm text-muted">{p.relationship}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 style={{ marginBottom: '0.75rem' }}>Courses</h3>
            {student.courses.length === 0 ? (
              <p className="text-sm text-muted">No courses</p>
            ) : (
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {student.courses.map(c => (
                  <li key={c.id}>
                    <Link to={`/course/${c.id}`} className="link text-sm">{c.course_name}</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Notes section */}
      <div className="card">
        <h3 style={{ marginBottom: '0.75rem' }}>Notes</h3>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <textarea
            placeholder="Add a note..."
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            rows={2}
            style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '0.9rem', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <select value={noteCourseId} onChange={e => setNoteCourseId(e.target.value)} style={{ fontSize: '0.8rem' }}>
              <option value="">General</option>
              {student.courses.map(c => <option key={c.id} value={c.id}>{c.course_name}</option>)}
            </select>
            <button className="primary" onClick={handleAddNote} disabled={!newNote.trim()}>Add Note</button>
          </div>
        </div>
        {student.notes.length === 0 ? (
          <p className="text-sm text-muted">No notes yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {student.notes.map(n => (
              <div key={n.id} style={{ padding: '0.5rem 0.75rem', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                {editingNoteId === n.id ? (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <textarea value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={2}
                      style={{ flex: 1, padding: '0.4rem', border: '1px solid var(--border)', borderRadius: 4, fontFamily: 'inherit', fontSize: '0.85rem' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      <button className="primary" onClick={() => handleUpdateNote(n.id)} style={{ fontSize: '0.8rem' }}>Save</button>
                      <button onClick={() => setEditingNoteId(null)} style={{ fontSize: '0.8rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{n.content}</p>
                    <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.3rem', alignItems: 'center' }}>
                      <span className="text-sm text-muted">{new Date(n.created_at).toLocaleDateString()}</span>
                      {n.course_id && <span className="badge badge-blue">{student.courses.find(c => c.id === n.course_id)?.course_name || 'Course'}</span>}
                      <button onClick={() => { setEditingNoteId(n.id); setEditNoteText(n.content); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '0.8rem' }}>Edit</button>
                      <button onClick={() => handleDeleteNote(n.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--error)', fontSize: '0.8rem' }}>Delete</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Flags section */}
      <div className="card">
        <h3 style={{ marginBottom: '0.75rem' }}>Flags</h3>
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
            {student.flags.map(f => (
              <div key={f.id} style={{
                padding: '0.5rem 0.75rem', borderRadius: 6,
                background: f.resolved ? '#f0fdf4' : '#fefce8',
                border: `1px solid ${f.resolved ? '#bbf7d0' : '#fde68a'}`,
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                opacity: f.resolved ? 0.7 : 1,
              }}>
                <span className={`badge ${f.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
                  {f.flag_type.replace('_', ' ')}
                </span>
                <span className="text-sm" style={{ flex: 1, textDecoration: f.resolved ? 'line-through' : 'none' }}>
                  {f.flag_reason}
                </span>
                <span className="text-sm text-muted">{new Date(f.created_at).toLocaleDateString()}</span>
                {f.resolved ? (
                  <button onClick={() => handleReopenFlag(f.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '0.8rem' }}>Reopen</button>
                ) : (
                  <button onClick={() => handleResolveFlag(f.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--success)', fontSize: '0.8rem' }}>Resolve</button>
                )}
                <button onClick={() => handleDeleteFlag(f.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--error)', fontSize: '0.8rem' }}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Analytics */}
      <StudentAnalytics studentId={parseInt(id)} />

      {/* Grades by course */}
      {Object.entries(gradesByCourse).map(([courseId, { name, grades }]) => (
        <div className="card" key={courseId}>
          <h3 style={{ marginBottom: '0.75rem' }}>
            <Link to={`/course/${courseId}`} className="link">{name}</Link>
          </h3>
          <table>
            <thead>
              <tr>
                <th>Assignment</th>
                <th>Due</th>
                <th>Score</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {grades.map(g => (
                <tr key={g.id}>
                  <td className="text-sm">{g.assignment_title}</td>
                  <td className="text-sm text-muted">{g.due_date || '-'}</td>
                  <td>
                    {g.score != null ? (
                      <span>{g.score}{g.assignment_max_points ? ` / ${g.assignment_max_points}` : ''}</span>
                    ) : '-'}
                  </td>
                  <td className="text-sm text-muted" style={{ maxWidth: '300px' }}>
                    {g.grade_comment || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {student.grades.length === 0 && (
        <div className="card"><p className="text-muted">No grades yet.</p></div>
      )}
    </div>
  );
}
