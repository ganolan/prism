// #191: the public "Birthday today" mark and the dashboard's birthdays card, with Private details off and on.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BirthdayMark, BirthdaysCard, birthdayLine } from './Birthday.jsx';
import { setPrivateDetails } from '../lib/privateDetails.js';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({ getBirthdays: vi.fn() }));

const ANSWER = {
  today: '2026-10-30',
  students: [
    { id: 1, name: 'Cy Lee', first: 'Cy', date: '2026-10-27', days: -3, turns: 16, birthday_today: false, courses: ['AI & ML'] },
    { id: 2, name: 'Ana Lee', first: 'Ana', date: '2026-10-31', days: 1, turns: 17, birthday_today: true, courses: ['AI & ML', 'Robotics'] },
    { id: 3, name: 'Di Lee', first: 'Di', date: '2026-11-06', days: 7, turns: 15, birthday_today: false, courses: ['Robotics'] },
  ],
};
const renderCard = () => render(<MemoryRouter><BirthdaysCard /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrivateDetails(true);
  api.getBirthdays.mockResolvedValue(ANSWER);
});

describe('BirthdayMark', () => {
  it('shows only on a birthday, named "Birthday today" in an instant popover, never a date or age', () => {
    const { container, rerender } = render(<BirthdayMark student={{ birthday_today: false, age: 16 }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BirthdayMark student={{ birthday_today: true, age: 16, date_of_birth: '2010-10-30' }} />);
    const mark = screen.getByRole('img', { name: 'Birthday today' });
    expect(mark).not.toHaveAttribute('title');
    fireEvent.mouseEnter(mark);
    expect(document.querySelector('.help-pop')).toHaveTextContent(/^Birthday today$/);
    expect(document.body).not.toHaveTextContent(/16|2010/);
  });
});

describe('BirthdaysCard', () => {
  it('with Private details on: every birthday from 3 days back to 7 ahead, with the age and the date', async () => {
    renderCard();
    expect(await screen.findByRole('heading', { name: 'Birthdays' })).toBeInTheDocument();
    const rows = [...document.querySelectorAll('.birthdays-card__row')].map((r) => r.textContent);
    expect(rows).toEqual([
      'Cy Leeturned 16 on Tue 27/10AI & ML',
      'Ana Leeturns 17 on Sat 31/10AI & ML, Robotics',
      'Di Leeturns 15 on Fri 06/11Robotics',
    ]);
    expect(screen.getByRole('link', { name: 'Ana Lee' })).toHaveAttribute('href', '/student/2');
  });

  it('with Private details off: only who has a birthday today, with no date, age or list', async () => {
    setPrivateDetails(false);
    const { container } = renderCard();
    expect(await screen.findByText("It's Ana's birthday today.")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Cy|Di|17|31\/10|turns|Robotics/);
    act(() => setPrivateDetails(true));
    expect(screen.getByRole('heading', { name: 'Birthdays' })).toBeInTheDocument();
  });

  it('draws nothing when nobody has a birthday near, or with the switch off and none today, or when the read fails', async () => {
    api.getBirthdays.mockResolvedValue({ today: '2026-10-30', students: [] });
    const a = renderCard();
    await act(async () => {});
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    setPrivateDetails(false);
    api.getBirthdays.mockResolvedValue({ today: '2026-10-30', students: [ANSWER.students[0]] });
    const b = renderCard();
    await act(async () => {});
    expect(b.container).toBeEmptyDOMElement();
    b.unmount();
    api.getBirthdays.mockRejectedValue(new Error('offline'));
    const c = renderCard();
    await act(async () => {});
    expect(c.container).toBeEmptyDOMElement();
  });

  it('birthdayLine: today, ahead and past', () => {
    expect(birthdayLine({ days: 0, turns: 16, date: '2026-10-30' })).toBe('turns 16 today');
    expect(birthdayLine({ days: 2, turns: 16, date: '2026-11-01' })).toBe('turns 16 on Sun 01/11');
    expect(birthdayLine({ days: -1, turns: 16, date: '2026-10-29' })).toBe('turned 16 on Thu 29/10');
  });
});
