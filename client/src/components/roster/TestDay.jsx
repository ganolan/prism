import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import NumberStepper from '../NumberStepper.jsx';
import { Photo } from './RosterCard.jsx';
import { forRoster } from '../../lib/psAlerts.js';
import { studentFullName } from '../../lib/studentNames.js';
import { formatDate } from '../../lib/formatDate.js';
import { upcomingTests, extraMinutes, planLine } from '../../lib/testDay.js';
import { getAlertDetail, getExtraTime, setExtraTime } from '../../services/api.js';

// Test day on the Roster tab (#160; spec "Test day"): each learning plan's extra time for a chosen
// test. The test picker and length show with Private details off; the students only with it on (with
// it off they are not in the page at all). Health alerts never list a student here.
//
// Extra time is the figure the teacher confirmed once (GET/PUT /api/extra-time, per student, every
// course). Plan text is read live, only for students with no confirmed figure, one after another, from
// the student's first learning alert (getAlertDetail, which suggests a percentage); a confirmed student
// is read only when the teacher asks for the plan line. A refused read or an ended session stops every
// later read, on request too, until Test day is opened again (STOPS_READS). Prism holds no lesson
// times, so everything is in minutes ("63 minutes, 13 more"), never a clock time. With no test chosen
// the percentage leads ("50% extra time"), with the minutes for a test of the chosen length under it as
// an example (#192); with a test chosen, its minutes lead.
// Props: on (Private details), students (enrolled ones), gradebook (CoursePage's getGradebook), locked
// (what shows in place of the list with Private details off), today (for tests; default now).

const NO_TEST = 'none';
const FIRST_GUESS = 25; // where Set extra time starts when the notes give no figure
// Errors that every later read would repeat (psSupportSummary's codes): PowerSchool logged a security
// violation, or the session ended. The reads stop there, and the list says why once.
const STOPS_READS = new Set(['SECURITY_VIOLATION', 'SESSION_EXPIRED']);

// The plan line from a read: a rows answer through planLine, a text answer one line at a time.
function lineFrom(detail) {
  if (detail.kind === 'rows') return planLine(detail.rows);
  if (detail.kind === 'text') return planLine((detail.text || '').split('\n').map((description) => ({ description })));
  return null;
}

function PlanLine({ read, confirmed, onShow }) {
  if (!read) return confirmed && onShow ? <button type="button" className="ghost test-day-card__show" onClick={onShow}>Show plan</button> : null;
  if (read.loading) return null;
  if (read.error) return <span className="test-day-card__error">Could not read the plan: {read.error}</span>;
  if (read.detail.kind === 'none') return <span>Prism can read only that this plan is set.</span>;
  return <span>{lineFrom(read.detail) ?? 'The plan has no notes.'}</span>;
}

function TimeControls({ student, length, hasTest, confirmed, read, stopped, draft, setDraft, onSave, saving, saveError }) {
  const name = studentFullName(student);
  if (draft != null) {
    return (
      <>
        <NumberStepper value={draft} onChange={setDraft} min={0} max={200} step={5} suffix="%" aria-label={`Extra time for ${name}, percent`} />
        <button type="button" className="primary test-day-card__btn" disabled={saving} onClick={() => onSave(draft)}>Save</button>
        <button type="button" className="ghost" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
        {saveError && <span className="test-day-card__error">Could not save: {saveError}</span>}
      </>
    );
  }
  if (confirmed) {
    const more = extraMinutes(length, confirmed.percent);
    return (
      <>
        {hasTest ? (
          <>
            <b className="test-day-card__total">{length + more} minutes, {more ? `${more} more` : 'no extra time'}</b>
            <span className="test-day-card__muted">{confirmed.percent}% extra</span>
          </>
        ) : (
          <>
            <b className="test-day-card__total">{confirmed.percent ? `${confirmed.percent}% extra time` : 'No extra time'}</b>
            <span className="test-day-card__muted">{length + more} minutes for a {length}-minute test</span>
          </>
        )}
        <button type="button" className="secondary test-day-card__btn" onClick={() => setDraft(confirmed.percent)}>Change</button>
      </>
    );
  }
  if ((!read || read.loading) && !stopped) return <span className="test-day-card__muted">Reading the plan…</span>;
  const suggested = read?.detail?.suggestedPercent;
  if (suggested != null) {
    return (
      <>
        <span className="test-day-card__muted">Notes mention {suggested}%</span>
        <button type="button" className="primary test-day-card__btn" disabled={saving} onClick={() => onSave(suggested)}>Use {suggested}%</button>
        <button type="button" className="secondary test-day-card__btn" onClick={() => setDraft(suggested)}>Other</button>
        {saveError && <span className="test-day-card__error">Could not save: {saveError}</span>}
      </>
    );
  }
  return (
    <>
      {read?.detail && <span className="test-day-card__muted">No time in the notes</span>}
      <button type="button" className="secondary test-day-card__btn" onClick={() => setDraft(FIRST_GUESS)}>Set extra time</button>
    </>
  );
}

function PlanList({ plans, length, hasTest }) {
  const [extra, setExtra] = useState(null); // { [student id]: { percent, updatedAt } } once read
  const [extraError, setExtraError] = useState(null);
  const [reads, setReads] = useState({}); // { [student id]: { loading } | { detail } | { error } }
  const [drafts, setDrafts] = useState({}); // { [student id]: percent } while its stepper is open
  const [saving, setSaving] = useState({}); // { [student id]: true }
  const [saveErrors, setSaveErrors] = useState({});
  const [stopped, setStopped] = useState(null); // the message of a read error in STOPS_READS
  const stoppedRef = useRef(false);
  const extraRef = useRef({}); // the latest confirmed figures, for the read loop
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const key = plans.map((p) => `${p.student.id}:${p.alertKey}`).join(',');

  const read = (id, alertKey, isLive = () => true) => {
    setReads((r) => ({ ...r, [id]: { loading: true } }));
    return getAlertDetail(id, alertKey)
      .then((detail) => { if (isLive()) setReads((r) => ({ ...r, [id]: { detail } })); })
      .catch((err) => {
        if (!isLive()) return;
        if (STOPS_READS.has(err.code)) {
          stoppedRef.current = true;
          setStopped(err.message);
          setReads((r) => { const next = { ...r }; delete next[id]; return next; });
        } else {
          setReads((r) => ({ ...r, [id]: { error: err.message } }));
        }
      });
  };

  // The confirmed figures, then each unconfirmed student's plan, one read after another.
  useEffect(() => {
    let live = true;
    const isLive = () => live;
    const list = plansRef.current;
    (async () => {
      let confirmed;
      try {
        confirmed = list.length ? (await getExtraTime(list.map((p) => p.student.id))) || {} : {};
      } catch (err) {
        if (live) setExtraError(err.message);
        return;
      }
      if (!live) return;
      extraRef.current = confirmed;
      setExtra(confirmed);
      for (const p of list) {
        if (!live || stoppedRef.current) return;
        if (extraRef.current[p.student.id]) continue; // confirmed, maybe since the loop began
        await read(p.student.id, p.alertKey, isLive);
      }
    })();
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDraft = (id) => (value) => setDrafts((d) => {
    const next = { ...d };
    if (value == null) delete next[id]; else next[id] = value;
    return next;
  });

  const save = async (id, percent) => {
    setSaving((s) => ({ ...s, [id]: true }));
    setSaveErrors((e) => ({ ...e, [id]: null }));
    try {
      const figure = await setExtraTime(id, percent);
      extraRef.current = { ...extraRef.current, [id]: figure };
      setExtra(extraRef.current);
      setDraft(id)(null);
    } catch (err) {
      setSaveErrors((e) => ({ ...e, [id]: err.message }));
    } finally {
      setSaving((s) => ({ ...s, [id]: false }));
    }
  };

  if (!plans.length) return <p className="text-sm text-muted">No student in this class has a learning plan.</p>;
  if (extraError) return <div className="alert alert-warning">Could not read the confirmed extra time: {extraError}</div>;
  if (!extra) return <p className="text-sm text-muted">Reading extra time…</p>;

  return (
    <div className="roster-cards">
      {stopped && <div className="alert alert-warning">Could not read the plans: {stopped}</div>}
      {plans.map(({ student, alertKey, planNames }) => {
        const id = student.id;
        return (
          <div key={id} className="test-day-card">
            <span className="test-day-card__avatar"><Photo student={student} /></span>
            <span className="test-day-card__id">
              <Link className="roster-card__name" to={`/student/${id}`}>{studentFullName(student)}</Link>
              <span className="test-day-card__plans">{planNames}</span>
            </span>
            <span className="test-day-card__time">
              <TimeControls student={student} length={length} hasTest={hasTest} confirmed={extra[id]} read={reads[id]}
                stopped={Boolean(stopped)} draft={drafts[id] ?? null} setDraft={setDraft(id)} onSave={(percent) => save(id, percent)}
                saving={Boolean(saving[id])} saveError={saveErrors[id]} />
            </span>
            <span className="test-day-card__line">
              <PlanLine read={reads[id]} confirmed={Boolean(extra[id])} onShow={stopped ? null : () => read(id, alertKey)} />
            </span>
          </div>
        );
      })}
      <p className="text-sm text-muted">Learning plans only, not health alerts. You confirm each student&apos;s extra time once, and Prism keeps it for every course they take with you.</p>
    </div>
  );
}

export default function TestDay({ on, students, gradebook = null, locked = null, today }) {
  const tests = useMemo(() => upcomingTests(gradebook?.assignments, today), [gradebook, today]);
  const [choice, setChoice] = useState(null); // null: the nearest test
  const testId = choice ?? tests[0]?.schoologyAssignmentId ?? NO_TEST;
  const test = tests.find((t) => t.schoologyAssignmentId === testId) || null;
  const [length, setLength] = useState(50);

  // Students with a learning alert, and the first one's key (its read covers a student without the
  // Support Summary alert). Built only with Private details on.
  const plans = useMemo(() => (on ? students : []).map((student) => {
    const learning = forRoster(student.ps_alerts).filter((a) => a.category === 'learning');
    if (!learning.length) return null;
    return { student, alertKey: learning[0].key, planNames: learning.map((a) => a.title || a.label).join(', ') };
  }).filter(Boolean), [on, students]);

  return (
    <div className="roster-mode test-day">
      <div className="test-day__bar">
        <label className="test-day__field">
          <span>Test</span>
          <select aria-label="Test" value={test ? testId : NO_TEST} onChange={(e) => setChoice(e.target.value)}>
            {tests.map((t) => <option key={t.schoologyAssignmentId} value={t.schoologyAssignmentId}>{t.title}, {formatDate(t.dueDate)}</option>)}
            <option value={NO_TEST}>No test (plans only)</option>
          </select>
        </label>
        <span className="test-day__field">
          <span>Length</span>
          <NumberStepper value={length} onChange={setLength} min={5} max={300} step={5} suffix="min" aria-label="Test length in minutes" />
        </span>
      </div>
      {!test && (
        <div className="test-day__none">
          <b>{tests.length ? 'No test chosen.' : 'No test is set in the next two weeks.'}</b>
          <span>The list shows each student&apos;s extra time, with the minutes for a {length}-minute test as an example.</span>
        </div>
      )}
      {on ? <PlanList plans={plans} length={length} hasTest={Boolean(test)} /> : locked}
    </div>
  );
}
