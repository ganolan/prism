import { useEffect, useState } from 'react';
import { getLessonPlan } from '../services/api.js';
import { lessonHint, schoolDaysForLesson } from '../lib/lessonHint.js';

// Under a school-day deadline stepper: where the count lands in this class's
// lessons ("→ Thu 15/10 · 3 lessons from today"), plus "Next lesson" / "2 lessons"
// picks that set the school-day count. `from` is the date the count starts at
// (due date, test date, or the day the resubmission was asked). Quietly renders
// nothing until (or unless) the plan loads.
export default function LessonHint({ courseId, from, value, onPick }) {
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    let live = true;
    if (courseId) Promise.resolve(getLessonPlan(courseId, from)).then((p) => { if (live) setPlan(p); }).catch(() => {});
    return () => { live = false; };
  }, [courseId, from]);

  const hint = lessonHint(plan, value);
  if (!hint) return null;
  const picks = [[1, 'Next lesson'], [2, '2 lessons']]
    .map(([k, label]) => ({ label, n: schoolDaysForLesson(plan, k) }))
    .filter((p) => p.n != null);
  return (
    <span className="lesson-hint">
      <span className="text-sm text-muted" data-testid="lesson-hint">{hint.text}</span>
      {picks.map((p) => (
        <button key={p.label} type="button" className="ghost btn-sm" onClick={() => onPick(p.n)} aria-pressed={p.n === value}>
          {p.label}
        </button>
      ))}
    </span>
  );
}
