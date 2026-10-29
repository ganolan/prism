import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAttendance, getAttendanceDays, getClassTimes, saveAttendance } from '../../services/api.js';
import { monthGrid, monthOf, monthRange, stepMonth } from '../../lib/monthGrid.js';
import { formatTime, localIsoDate } from '../../lib/formatDate.js';
import {
  MAIN_CODES, PRESENT, canSave, codeLabel, counts, editable, fillLabel, initialChoices, isDirty, markAllPresent, marksToSend, otherCodes,
} from '../../lib/attendance.js';

// #39: take attendance for one of the course's lessons and save it to PowerSchool, as the Schoology Attendance page
// does. Present is a choice like Tardy and Absent (Graham, 29 Oct 2026); "Mark the remaining N present" fills the rest
// (named so it never reads as overriding marks already chosen); marks the
// office entered (PowerSchool's readOnly) are shown locked. Every save is read back. See docs/design-language.md
// "Attendance tab". The lesson is picked on a month calendar; on a day the class does not meet the tab opens the
// last lesson, saying so and naming the next (Graham, 29 Oct 2026).
const LOOKBACK_DAYS = 60; // how far back the opening lesson is looked for
const AHEAD_DAYS = 21; // and the next lesson

const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });

// The lesson calendar: a Monday-to-Friday month grid. The class's lessons up to today are buttons, the open one
// filled, today outlined; a dot marks whether PowerSchool holds attendance for each (green taken, amber not yet).
// Later lessons show without a button; other days are greyed.
function LessonCalendar({ month, onMonth, lessons, status, selected, today, onPick, disabled }) {
  const grid = monthGrid(month.year, month.month);
  const byDate = new Map(lessons.map((m) => [m.date, m]));
  const word = (d) => (status[d] === true ? 'attendance taken' : status[d] === false ? 'not taken yet' : '');
  return (
    <div className="att-cal" aria-label="Lessons">
      <div className="att-cal__head">
        <button type="button" className="ghost tap-target" onClick={() => onMonth(stepMonth(month, -1))} aria-label="Previous month">‹</button>
        <span className="att-cal__month">{grid.label}</span>
        <button type="button" className="ghost tap-target" onClick={() => onMonth(stepMonth(month, 1))} aria-label="Next month">›</button>
      </div>
      <div className="att-cal__grid" role="grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => <span key={d} className="att-cal__dow" role="columnheader">{d}</span>)}
        {grid.weeks.flat().map((iso, i) => {
          if (!iso) return <span key={`x${i}`} className="att-cal__day att-cal__day--out" />;
          const n = Number(iso.slice(8));
          const lessonDay = byDate.get(iso);
          const cls = `att-cal__day${iso === today ? ' att-cal__day--today' : ''}${iso === selected ? ' att-cal__day--selected' : ''}`;
          if (!lessonDay) return <span key={iso} className={`${cls} att-cal__day--none`}>{n}</span>;
          const dot = status[iso] === true ? 'taken' : status[iso] === false ? 'missing' : null;
          if (iso > today) return <span key={iso} className={`${cls} att-cal__day--later`}>{n}<i className="att-cal__dot" aria-hidden="true" /></span>;
          return (
            <button key={iso} type="button" className={`${cls} att-cal__day--lesson`} aria-pressed={iso === selected} disabled={disabled}
              aria-label={`${dayLabel(iso)}${lessonDay.start ? `, ${lessonDay.start}` : ''}${word(iso) ? `, ${word(iso)}` : ''}`} onClick={() => onPick(iso)}>
              {n}<i className={`att-cal__dot${dot ? ` att-cal__dot--${dot}` : ''}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The strip's fourth segment (Graham chose it 29 Oct 2026, after the grade card's Flags control): "Other ▾", or the
// chosen code ("I: Illness ▾"); it opens a menu of the school's other codes, the chosen one ticked. Escape or a click
// outside closes it; arrow keys move between codes.
function OtherMenu({ codes, choice, name, disabled, onChoose }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const chosen = codes.find((c) => c.code === choice);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    wrap.current?.querySelector('[role="menuitemradio"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector('button')?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...wrap.current.querySelectorAll('[role="menuitemradio"]')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <span className="att-other" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`att-seg att-seg--other${chosen ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={chosen ? `Other code for ${name}: ${chosen.code}, ${chosen.description}` : `Other code for ${name}`}
        disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {chosen ? `${chosen.code}: ${chosen.description}` : 'Other'} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="att-menu" role="menu" aria-label={`Other codes for ${name}`}>
          <div className="att-menu__heading" role="presentation">Other codes</div>
          {codes.map((c) => (
            <button key={c.code} type="button" role="menuitemradio" aria-checked={c.code === choice} className="att-menu__item"
              onClick={() => { onChoose(c.code); setOpen(false); }}>
              <span className="att-menu__code">{c.code}</span>
              <span>{c.description}</span>
              <span className="att-menu__tick" aria-hidden="true">{c.code === choice ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export default function AttendanceTab({ courseId }) {
  const today = localIsoDate();
  const [meetings, setMeetings] = useState(null); // [{ date, start, end }] from Prism's timetable, oldest first
  const [date, setDate] = useState(null);
  const [month, setMonth] = useState(() => monthOf(today));
  const [status, setStatus] = useState({}); // date → true (taken) | false (not yet) | null
  const [lesson, setLesson] = useState(null);
  const [choices, setChoices] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // The opening lesson: today's, or the last one before it.
  useEffect(() => {
    const from = localIsoDate(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
    const to = localIsoDate(new Date(Date.now() + AHEAD_DAYS * 86400000));
    getClassTimes(courseId, from, to)
      .then((r) => {
        const list = [...(r.meetings || [])].sort((a, b) => a.date.localeCompare(b.date));
        setMeetings(list);
        const open = [...list].reverse().find((m) => m.date <= today)?.date ?? null;
        setDate(open);
        if (open) setMonth(monthOf(open));
      })
      .catch((err) => { setMeetings([]); setError(err.message); });
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The shown month's lessons, and whether each is taken (one PowerSchool read per past lesson).
  const [monthLessons, setMonthLessons] = useState([]);
  useEffect(() => {
    const [from, to] = monthRange(month.year, month.month);
    let live = true;
    Promise.resolve().then(() => getAttendanceDays(courseId, from, to))
      .then((r = {}) => {
        if (!live) return;
        setMonthLessons(r.days || []);
        setStatus((prev) => ({ ...prev, ...Object.fromEntries((r.days || []).map((d) => [d.date, d.taken])) }));
      })
      .catch(() => { if (live) setMonthLessons((meetings || []).filter((m) => m.date >= from && m.date <= to)); });
    return () => { live = false; };
  }, [courseId, month.year, month.month]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const lessonToday = meetings?.some((m) => m.date === today);
  const nextLesson = meetings?.find((m) => m.date > today)?.date;
  const calendarLessons = monthLessons.length ? monthLessons : (meetings || []).filter((m) => m.date.slice(0, 7) === `${month.year}-${String(month.month + 1).padStart(2, '0')}`);

  const choose = (id, code) => { setNotice(null); setChoices((prev) => ({ ...prev, [id]: code })); };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await saveAttendance(courseId, { date, marks: marksToSend(choices, lesson), fingerprint: lesson.fingerprint });
      show(r.lesson);
      setStatus((prev) => ({ ...prev, [date]: r.lesson.taken }));
      setNotice(`Saved to PowerSchool at ${formatTime(new Date())}. Every mark read back as sent.`);
    } catch (err) {
      setError(err.message);
      if (err.lesson) show(err.lesson);
    } finally {
      setSaving(false);
    }
  };

  if (meetings && !meetings.some((m) => m.date <= today)) {
    return <p className="text-muted">{error || `This class has had no lesson in the last ${Math.round(LOOKBACK_DAYS / 7)} weeks.`}</p>;
  }

  return (
    <div className="attendance">
      {meetings && !lessonToday && date && (
        <p className="alert alert-info attendance__no-lesson">
          This class has no lesson today ({dayLabel(today)}). {date !== today ? `Showing the last lesson, ${dayLabel(date)}.` : ''}
          {nextLesson ? ` Next lesson: ${dayLabel(nextLesson)}.` : ''}
        </p>
      )}
      <div className="attendance__top">
        <LessonCalendar month={month} onMonth={setMonth} lessons={calendarLessons} status={status} selected={date} today={today}
          onPick={(d) => setDate(d)} disabled={saving} />
        <div className="attendance__bar">
          {date && <span className="attendance__date">{dayLabel(date)}{meetings?.find((m) => m.date === date)?.start ? `, ${meetings.find((m) => m.date === date).start} to ${meetings.find((m) => m.date === date).end}` : ''}</span>}
          {lesson?.lesson && (
            <span className={`badge ${lesson.taken ? 'badge-green' : 'badge-amber'}`}>{lesson.taken ? 'Taken in PowerSchool' : 'Not taken yet'}</span>
          )}
          {dirty && <span className="text-sm text-muted">Unsaved changes: another lesson discards them.</span>}
        </div>
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
                    <span className="att-strip" role="group" aria-label={`Attendance for ${st.name}`}>
                      {MAIN_CODES.map((m) => (
                        <button key={m.label} type="button" aria-pressed={choice === m.code}
                          className={`att-seg att-seg--${m.label.toLowerCase()}${choice === m.code ? ' active' : ''}`}
                          onClick={() => choose(st.ps_student_id, m.code)} disabled={saving}>
                          {m.label}
                        </button>
                      ))}
                      <OtherMenu codes={others} choice={isOther ? choice : null} name={st.name} disabled={saving}
                        onChoose={(code) => choose(st.ps_student_id, code)} />
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
