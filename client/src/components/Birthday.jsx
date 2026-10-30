import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Tip } from './HelpDot.jsx';
import { getBirthdays } from '../services/api.js';
import { usePrivateDetails } from '../lib/privateDetails.js';

// Birthdays (#191; Graham's rules, 25 and 28 Oct 2026). Public: only the fact that today is a student's birthday
// (a weekend or holiday birthday is marked on the school day before). Private, with Private details on: the age,
// the date, and the dashboard's list from 3 days back to 7 days ahead. The server works out `birthday_today`
// (services/birthdays.js); nothing here reads a date of birth.

const CakeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 14h11M3.5 14V9.5h9V14M3.5 11.5c1.2.8 2 .8 3 0s1.8-.8 3 0 1.8.8 3 0M8 9.5V7.5M8 5.5c.9-.8.9-1.6 0-2.5-.9.9-.9 1.7 0 2.5Z" />
  </svg>
);

// The public mark beside a name: a small cake, its popover and name the server's words ("Birthday today", or for a
// weekend birthday marked early "Birthday on Saturday"). Never the date or age.
export function BirthdayMark({ student }) {
  if (!student?.birthday_today) return null;
  return <Tip className="birthday-mark" text={student.birthday_label || 'Birthday today'}><CakeIcon /></Tip>;
}

// "Thu 29/10"
const dayText = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
};
// "turns 16 today", "turns 16 on Sat 31/10", "turned 16 on Mon 26/10"
export function birthdayLine(b) {
  if (b.days === 0) return `turns ${b.turns} today`;
  return b.days > 0 ? `turns ${b.turns} on ${dayText(b.date)}` : `turned ${b.turns} on ${dayText(b.date)}`;
}

// The dashboard's card. With Private details off: only "It's Ana's birthday today." for each student marked today
// (nothing at all when nobody is). With it on: every birthday from 3 days back to 7 days ahead, with the age.
export function BirthdaysCard() {
  const [privateOn] = usePrivateDetails();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    new Promise((resolve) => resolve(getBirthdays()))
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, []);
  const students = data?.students || [];
  const today = students.filter((s) => s.birthday_today);
  if (!privateOn) {
    if (!today.length) return null;
    return (
      <div className="card birthdays-card birthdays-card--public">
        {today.map((s) => <p key={s.id} className="birthdays-card__today"><CakeIcon /> It&apos;s {s.first}&apos;s birthday today.</p>)}
      </div>
    );
  }
  if (!students.length) return null;
  return (
    <div className="card birthdays-card">
      <h3 className="birthdays-card__title">Birthdays</h3>
      <ul className="birthdays-card__list">
        {students.map((s) => (
          <li key={s.id} className={s.birthday_today ? 'birthdays-card__row birthdays-card__row--today' : 'birthdays-card__row'}>
            {s.birthday_today ? <CakeIcon /> : <span className="birthdays-card__gap" aria-hidden="true" />}
            <Link to={`/student/${s.id}`} className="link">{s.name}</Link>
            <span className="text-muted">{birthdayLine(s)}</span>
            <span className="text-muted birthdays-card__courses">{s.courses.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
