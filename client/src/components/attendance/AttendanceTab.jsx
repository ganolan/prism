import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAttendance, getClassTimes, saveAttendance } from '../../services/api.js';
import { formatTime, localIsoDate } from '../../lib/formatDate.js';
import {
  MAIN_CODES, PRESENT, canSave, codeLabel, counts, editable, fillLabel, initialChoices, isDirty, markAllPresent, marksToSend, otherCodes,
} from '../../lib/attendance.js';

// #39: take attendance for one of the course's lessons and save it to PowerSchool, as the Schoology Attendance page
// does. Present is a choice like Tardy and Absent (Graham, 29 Oct 2026); "Mark the remaining N present" fills the rest
// (named so it never reads as overriding marks already chosen); marks the
// office entered (PowerSchool's readOnly) are shown locked. Every save is read back. See docs/design-language.md
// "Attendance tab".
const LOOKBACK_DAYS = 21;

const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });

export default function AttendanceTab({ courseId }) {
  const [meetings, setMeetings] = useState(null); // [{ date, start, end }], newest first
  const [date, setDate] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [choices, setChoices] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const today = localIsoDate();
    const from = localIsoDate(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
    getClassTimes(courseId, from, today)
      .then((r) => {
        const list = [...(r.meetings || [])].filter((m) => m.date <= today).sort((a, b) => b.date.localeCompare(a.date));
        setMeetings(list);
        setDate(list[0]?.date ?? null);
      })
      .catch((err) => { setMeetings([]); setError(err.message); });
  }, [courseId]);

  const show = (l) => { setLesson(l); setChoices(initialChoices(l)); };
  useEffect(() => {
    if (!date) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setLesson(null);
    getAttendance(courseId, date).then(show).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, [courseId, date]);

  const c = useMemo(() => counts(choices, lesson), [choices, lesson]);
  const dirty = isDirty(choices, lesson);
  const meeting = meetings?.find((m) => m.date === date);

  const choose = (id, code) => { setNotice(null); setChoices((prev) => ({ ...prev, [id]: code })); };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await saveAttendance(courseId, { date, marks: marksToSend(choices, lesson), fingerprint: lesson.fingerprint });
      show(r.lesson);
      setNotice(`Saved to PowerSchool at ${formatTime(new Date())}. Every mark read back as sent.`);
    } catch (err) {
      setError(err.message);
      if (err.lesson) show(err.lesson);
    } finally {
      setSaving(false);
    }
  };

  if (meetings && !meetings.length) {
    return <p className="text-muted">{error || `This class has no lesson in the last ${LOOKBACK_DAYS / 7} weeks.`}</p>;
  }

  return (
    <div className="attendance">
      <div className="attendance__bar">
        <label className="text-sm attendance__lesson">
          Lesson
          <select value={date || ''} onChange={(e) => setDate(e.target.value)} disabled={saving} aria-label="Lesson">
            {(meetings || []).map((m) => (
              <option key={m.date} value={m.date}>{dayLabel(m.date)}{m.start ? `, ${m.start} to ${m.end}` : ''}</option>
            ))}
          </select>
        </label>
        {lesson?.lesson && (
          <span className={`badge ${lesson.taken ? 'badge-green' : 'badge-amber'}`}>{lesson.taken ? 'Taken in PowerSchool' : 'Not taken yet'}</span>
        )}
        {dirty && <span className="text-sm text-muted">Unsaved changes: another lesson discards them.</span>}
      </div>

      {error && <p className="alert alert-warning">{/mastery:login/.test(error) ? 'Schoology session expired. Run npm run mastery:login in a terminal, then open this tab again.' : error}</p>}
      {notice && <p className="alert alert-success">{notice}</p>}
      {loading && <p className="text-muted">Reading attendance from PowerSchool…</p>}
      {lesson && !lesson.lesson && <p className="text-muted">PowerSchool has no lesson for this class on {dayLabel(date)}.</p>}

      {lesson?.lesson && (
        <>
          <div className="attendance__actions">
            {fillLabel(choices, lesson) && (
              <button className="secondary" onClick={() => setChoices((prev) => markAllPresent(prev, lesson))} disabled={saving}>
                {fillLabel(choices, lesson)}
              </button>
            )}
            <span className="text-sm attendance__counts" aria-live="polite">
              Present {c.present}, Tardy {c.tardy}, Absent {c.absent}{c.other ? `, Other ${c.other}` : ''}{c.unmarked ? `, Not marked ${c.unmarked}` : ''}
            </span>
            <button className="primary" onClick={save} disabled={saving || !canSave(choices, lesson)}>
              {saving ? 'Saving…' : 'Save to PowerSchool'}
            </button>
          </div>

          <ul className="attendance__list">
            {lesson.students.map((st) => {
              const choice = choices[st.ps_student_id];
              const others = otherCodes(lesson);
              const isOther = choice != null && !MAIN_CODES.some((m) => m.code === choice);
              return (
                <li key={st.ps_student_id} className={`attendance__row${choice == null && editable(st) ? ' attendance__row--unmarked' : ''}`}>
                  <span className="attendance__name">
                    {st.student_id ? <Link className="link" to={`/student/${st.student_id}`}>{st.name}</Link> : st.name}
                  </span>
                  {st.office && (
                    <span className="attendance__office">
                      <span className="badge badge-gray">Office: {codeLabel(st.code ?? PRESENT, lesson)}</span>
                      {st.comment && <span className="text-sm text-muted">{st.comment}</span>}
                    </span>
                  )}
                  {!st.markable && <span className="text-sm text-muted">Mark this student on Schoology: PowerSchool holds more than one mark for them in this lesson.</span>}
                  {editable(st) && (
                    <span className="attendance__choices" role="group" aria-label={`Attendance for ${st.name}`}>
                      {MAIN_CODES.map((m) => (
                        <button key={m.label} type="button" aria-pressed={choice === m.code}
                          className={`att-choice att-choice--${m.label.toLowerCase()}${choice === m.code ? ' active' : ''}`}
                          onClick={() => choose(st.ps_student_id, m.code)} disabled={saving}>
                          {m.label}
                        </button>
                      ))}
                      <select className={`att-other${isOther ? ' active' : ''}`} value={isOther ? choice : ''} disabled={saving}
                        aria-label={`Other code for ${st.name}`} onChange={(e) => e.target.value && choose(st.ps_student_id, e.target.value)}>
                        <option value="">Other…</option>
                        {others.map((o) => <option key={o.code} value={o.code}>{o.code}: {o.description}</option>)}
                      </select>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
