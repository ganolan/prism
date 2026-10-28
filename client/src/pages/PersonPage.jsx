import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { getPerson, addPersonNote, deletePersonNote, deletePerson } from '../services/api.js';
import { formatDate } from '../lib/formatDate.js';
import { usePrivateDetails } from '../lib/privateDetails.js';
import { PrivateHidden } from '../components/PrivateDetails.jsx';
import PersonAvatar, { SCHOOLOGY } from '../components/PersonAvatar.jsx';

// #203: a profile for anyone People search finds who is not a Prism student (a Prism student opens their student
// page). Read from Schoology on first open and kept until the teacher deletes it; read again when opened more than
// 7 days later, or with Read again. Public: who the person is, a staff member's position, a student's courses and groups, a parent's children.
// Private (Private details): a student's parents and the teacher's notes. See docs/design-language.md "Profile pages".
const KIND = { student: 'Student', staff: 'Staff', parent: 'Parent' };

function Row({ label, children }) {
  return (
    <p className="text-sm person-row">
      <span className="text-muted person-row__label">{label}</span>
      <span>{children}</span>
    </p>
  );
}

const personLink = (x) => (x.student_id ? `/student/${x.student_id}` : `/people/${x.uid}`);

export default function PersonPage() {
  const { uid } = useParams();
  const [privateOn] = usePrivateDetails();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getPerson(uid, { refresh }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { setData(null); load(); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data?.student_id) return <Navigate to={`/student/${data.student_id}`} replace />;
  const p = data?.profile;

  const saveNote = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      const added = await addPersonNote(uid, note);
      setData((d) => ({ ...d, profile: { ...d.profile, notes: [added, ...d.profile.notes] } }));
      setNote('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const removeProfile = async () => {
    await deletePerson(uid);
    navigate('/people');
  };
  const removeNote = async (id) => {
    await deletePersonNote(uid, id);
    setData((d) => ({ ...d, profile: { ...d.profile, notes: d.profile.notes.filter((n) => n.id !== id) } }));
  };

  return (
    <div className="fade-in person-page">
      <p className="text-sm"><Link className="link" to="/people">Directory</Link></p>
      {error && <p className="alert alert-warning">{/mastery:login/.test(error) ? 'Schoology session expired. Run npm run mastery:login in a terminal, then open this page again.' : error}</p>}
      {!p && loading && <p className="text-muted">Reading from Schoology…</p>}
      {p && (
        <>
          {/* Graham, 28 Oct 2026: a profile that could not be read again shows as last read, dated, so an old read
              (a student since graduated) is not taken for today's. */}
          {p.read_error && (
            <p className="alert alert-warning">
              Could not read this profile again from Schoology ({p.read_error}). It shows what Schoology held on {formatDate(p.read_at)}.
            </p>
          )}
          <div className="card person-head">
            <PersonAvatar name={p.name_display} photoUrl={p.picture_url} size={64} />
            <div className="person-head__main">
              <h2 className="page-title" style={{ margin: 0 }}>
                {p.name_display}
                {p.kind && <span className="badge badge-gray person-kind">{KIND[p.kind]}</span>}
              </h2>
              {p.name_first_preferred && p.name_first_preferred !== p.name_first && (
                <p className="text-sm text-muted">Legal first name {p.name_first}</p>
              )}
              {p.email && <p className="text-sm"><a className="link" href={`mailto:${p.email}`}>{p.email}</a></p>}
              <p className="text-sm text-muted">
                Read from Schoology {formatDate(p.read_at)}
                {' '}<button className="ghost accent tap-target" onClick={() => load(true)} disabled={loading}>{loading ? 'Reading…' : 'Read again'}</button>
                {' '}<a className="link" href={`${SCHOOLOGY}/user/${p.schoology_uid}`} target="_blank" rel="noreferrer">Open in Schoology</a>
              </p>
              {/* Prism keeps a profile until the teacher deletes it (Graham, 28 Oct 2026). */}
              <p className="text-sm">
                {confirmDelete ? (
                  <>
                    <span>Delete this profile and its notes?</span>
                    {' '}<button className="ghost danger tap-target" onClick={removeProfile}>Delete</button>
                    {' '}<button className="ghost tap-target" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="ghost danger tap-target" onClick={() => setConfirmDelete(true)}>Delete profile</button>
                )}
              </p>
            </div>
          </div>

          {(p.position || p.subjects || p.phone) && (
            <div className="card">
              {p.position && <Row label="Position">{p.position}</Row>}
              {p.subjects && <Row label="Subjects taught">{p.subjects}</Row>}
              {p.phone && <Row label="Phone"><a className="link" href={`tel:${p.phone}`}>{p.phone}</a></Row>}
            </div>
          )}

          {p.children?.length > 0 && (
            <div className="card">
              <h3>Children</h3>
              {p.children.map((c) => (
                <p key={c.uid} className="text-sm"><Link className="link" to={personLink(c)}>{c.name || `User ${c.uid}`}</Link></p>
              ))}
            </div>
          )}

          {p.kind === 'student' && (
            <div className="card">
              <h3>Current courses</h3>
              {p.courses?.length ? p.courses.map((c, i) => <p key={i} className="text-sm">{c.title}</p>)
                : <p className="text-sm text-muted">Schoology lists no current courses.</p>}
            </div>
          )}

          {p.groups?.length > 0 && (
            <div className="card">
              <h3>Groups</h3>
              {p.groups.map((g, i) => <p key={i} className="text-sm">{g.title}</p>)}
            </div>
          )}

          {!privateOn && <PrivateHidden title="Parents and notes are private." />}
          {privateOn && p.parents?.length > 0 && (
            <div className="card">
              <h3>Parents</h3>
              {p.parents.map((x) => (
                <p key={x.uid || x.name} className="text-sm">
                  {x.uid ? <Link className="link" to={personLink(x)}>{x.name}</Link> : x.name}
                  {x.email && <> <a className="link" href={`mailto:${x.email}`}>{x.email}</a></>}
                </p>
              ))}
            </div>
          )}
          {privateOn && (
            <div className="card">
              <h3>Notes</h3>
              <div className="note-form">
                <textarea placeholder="Add a note..." value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" />
                <button className="primary" onClick={saveNote} disabled={saving || !note.trim()}>Save note</button>
              </div>
              {p.notes.map((n) => (
                <div key={n.id} className="person-note">
                  <p className="text-sm">{n.content}</p>
                  <p className="text-sm text-muted">
                    {formatDate(n.created_at)}
                    {' '}<button className="ghost danger tap-target" onClick={() => removeNote(n.id)} aria-label={`Delete note from ${formatDate(n.created_at)}`}>Delete</button>
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
