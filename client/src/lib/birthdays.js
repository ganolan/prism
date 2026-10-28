// Birthdays and age from PowerSchool's date of birth (#191; Graham's rules, 25 and 28 Oct 2026). Pure, no DOM:
// the server imports it too (routes/birthdays.js, the roster and student page answers), so both agree.
//  - Public: the fact that today is a student's birthday ("Birthday today"), never the date or the age.
//  - Private (Private details on): the age, the date of birth, and the list of birthdays from 3 days back to 7
//    days ahead.
//  - A birthday on a weekend or holiday is marked on the school day before it.
// Dates are 'YYYY-MM-DD' strings, compared without a time zone.

export const BIRTHDAYS_AHEAD = 7;
export const BIRTHDAYS_BACK = 3;
const MARK_LOOKBACK = 31; // the longest run of days without school a birthday mark looks back over (winter break)

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// The birthday in `year` ('YYYY-MM-DD'); 29 February is the 28th in a year that has none.
export function birthdayIn(dob, year) {
  const [, m, d] = dob.split('-');
  return m === '02' && d === '29' && !leap(year) ? `${year}-02-28` : `${year}-${m}-${d}`;
}

// Whole years old on `day`.
export function ageOn(dob, day) {
  const [y] = dob.split('-').map(Number);
  const [ty] = day.split('-').map(Number);
  return ty - y - (birthdayIn(dob, ty) > day ? 1 : 0);
}

// The birthday from BIRTHDAYS_BACK days ago to BIRTHDAYS_AHEAD days ahead of `today`, else null:
// { date, days (negative = past), turns (the age on that birthday) }.
export function birthdayNear(dob, today) {
  if (!dob) return null;
  const [ty] = today.split('-').map(Number);
  for (const year of [ty - 1, ty, ty + 1]) {
    const date = birthdayIn(dob, year);
    const days = daysFrom(today, date);
    if (days >= -BIRTHDAYS_BACK && days <= BIRTHDAYS_AHEAD) return { date, days, turns: ageOn(dob, date) };
  }
  return null;
}

// The next birthday on or after `today`: { date, days, turns }.
export function nextBirthday(dob, today) {
  const [ty] = today.split('-').map(Number);
  const date = [ty, ty + 1].map((y) => birthdayIn(dob, y)).find((d) => d >= today);
  return { date, days: daysFrom(today, date), turns: ageOn(dob, date) };
}

// The school day a birthday is marked on: the day itself when it is a school day, else the last school day before.
export function markDay(birthday, isSchoolDay) {
  for (let n = 0; n <= MARK_LOOKBACK; n += 1) {
    const d = addDays(birthday, -n);
    if (isSchoolDay(d)) return d;
  }
  return null;
}

// Whether the public "Birthday today" mark shows today: today is the mark day of the student's next birthday.
export function isBirthdayToday(dob, today, isSchoolDay) {
  if (!dob || !isSchoolDay(today)) return false;
  const next = nextBirthday(dob, today);
  return next.days <= MARK_LOOKBACK && markDay(next.date, isSchoolDay) === today;
}
