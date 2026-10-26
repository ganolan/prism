// The Roster tab (#160): private by default, one switch shows everything private.
// With the switch off nothing private is in the DOM at all (a roster may be projected).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams, useLocation } from 'react-router-dom';
import RosterTab from './RosterTab.jsx';
import { PrivateDetailsSwitch } from '../PrivateDetails.jsx';
import { setPrivateDetails, setPrivateDetailsDefault } from '../../lib/privateDetails.js';
import { setRosterSort } from '../../lib/rosterSort.js';
import { gradeText } from '../PersonSub.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getCourseCommentSummaries: vi.fn(),
  getAlertDetail: vi.fn(),
  getUnreadComments: vi.fn(),
  getEmails: vi.fn(),
}));

const A = {
  plan: { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' },
  epipen: { key: 'epipen', label: 'EpiPen', category: 'health' },
  noPhoto: { key: 'no_photo', label: 'No photo', category: 'other' },
  mobility: { key: 'mobility', label: 'Mobility', category: 'other' },
};
const student = (id, extra = {}) => ({
  id, first_name: `First${id}`, last_name: `Last${id}`, email: `2700${id}@hkis.edu.hk`, grad_year: 2027,
  ps_alerts: [], dropped_at: null, ...extra,
});
const STUDENTS = [
  student(1, { first_name: 'Ana', preferred_name: 'Annie', last_name: 'Lee', gender: 'F', ps_alerts: [A.plan, A.epipen] }),
  student(2, { gender: 'M' }),
  student(3, { gender: 'F' }),
  ...Array.from({ length: 8 }, (_, i) => student(i + 4)),
  student(12, { email: null, ps_alerts: [A.noPhoto] }),
  student(13, { first_name: 'Dee', last_name: 'Parted', dropped_at: '2026-08-13T00:00:00Z', gender: 'M', ps_alerts: [A.mobility] }),
];
// Unread comments: Annie 2, student 3 one; the dropped student 5 (never counted).
const SUMMARIES = { assignments: {
  a1: { 1: { count: 2, unread: 1 }, 3: { count: 1, unread: 1 }, 13: { count: 5, unread: 5 } },
  a2: { 1: { count: 1, unread: 1 } },
} };

function StudentProbe() { return <p>Student page {useParams().id}</p>; }
function SearchProbe() { return <span data-testid="search">{useLocation().search}</span>; }

function renderTab(url = '/course/5', props = {}) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/course/:id" element={(
          <>
            <PrivateDetailsSwitch />
            <SearchProbe />
            <RosterTab course={{ id: 5, course_name: 'AP CSP' }} students={STUDENTS} mastery={null} triage={null} courseId="5" {...props} />
          </>
        )} />
        <Route path="/student/:id" element={<StudentProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}
const toggle = () => fireEvent.click(screen.getByRole('button', { name: 'Private details' }));
const cardOf = (name) => screen.getByText(name).closest('.roster-card');
const status = () => document.querySelector('.assessment-filter-status__count');

let writeText;
// The app's default (off): test-setup.js starts other tests with Private details on.
afterEach(() => { vi.restoreAllMocks(); setPrivateDetailsDefault(true); });
beforeEach(() => {
  vi.clearAllMocks();
  setPrivateDetailsDefault(false);
  localStorage.clear(); setPrivateDetails(false); setRosterSort('last'); localStorage.clear();
  sessionStorage.clear();
  writeText = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  api.getCourseCommentSummaries.mockResolvedValue(SUMMARIES);
});

describe('RosterTab privacy', () => {
  it('with Private details off, the Roster shows names, grade, student number and Email copy, and no comment count, alert, filter or Copy emails is in the DOM', () => {
    const { container } = renderTab();
    expect(screen.getByRole('button', { name: 'Private details' })).toHaveAttribute('aria-pressed', 'false');
    const card = cardOf('Annie Lee');
    expect(gradeText(2027)).toBeTruthy();
    expect(within(card).getByText(gradeText(2027))).toBeInTheDocument();
    expect(within(card).getByText('27001')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Copy email 27001@hkis.edu.hk' })).toHaveTextContent('Email');
    // One name: no legal name anywhere.
    expect(container).not.toHaveTextContent(/\bAna\b/);
    expect(container.querySelector('.roster-card__comments, .roster-card__alerts, .assessment-filter-bar')).toBeNull();
    expect(screen.queryByText(/comments?$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    expect(screen.queryByText('EpiPen')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy emails/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Alerts/ })).not.toBeInTheDocument();
    expect(api.getCourseCommentSummaries).not.toHaveBeenCalled();
  });

  it('with Private details on, each card shows its unread count and alert chips, and the filter bar shows Alerts and Follow up group pills', async () => {
    renderTab();
    toggle();
    expect(screen.getByRole('button', { name: 'Private details' })).toHaveAttribute('aria-pressed', 'true');
    const annie = cardOf('Annie Lee');
    expect(await within(annie).findByRole('button', { name: /2 comments/ })).toBeInTheDocument();
    expect(within(cardOf('First3 Last3')).getByRole('button', { name: /1 comment\b/ })).toBeInTheDocument();
    expect(within(cardOf('First4 Last4')).getByText('comments')).toBeInTheDocument();
    expect(within(annie).getByRole('button', { name: 'Accommodation plan' })).toHaveTextContent('Plan');
    expect(within(annie).getByRole('button', { name: 'Accommodation plan' })).toHaveClass('badge-blue');
    expect(within(annie).getByRole('button', { name: 'EpiPen' })).toHaveClass('badge-amber');
    expect(screen.getByRole('button', { name: /^Alerts/ })).toHaveTextContent('Alerts2');
    expect(screen.getByRole('button', { name: /^Follow up/ })).toHaveTextContent('Follow up2');
    expect(status()).toHaveTextContent('Showing all 12 students');
    expect(api.getCourseCommentSummaries).toHaveBeenCalledWith('5');
  });

  it('is remembered: a later visit opens with Private details on', async () => {
    const first = renderTab();
    toggle();
    first.unmount();
    renderTab();
    expect(screen.getByRole('button', { name: 'Private details' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('button', { name: /2 comments/ })).toBeInTheDocument();
  });

  it('turning Private details off closes an open pop-up and clears the filters', async () => {
    api.getAlertDetail.mockResolvedValue({ alertKey: 'epipen', kind: 'text', text: 'Carries an EpiPen.', suggestedPercent: null, readAt: '2026-10-25T02:00:00Z' });
    renderTab();
    toggle();
    fireEvent.click(screen.getByRole('button', { name: /^Learning plan/ }));
    expect(status()).toHaveTextContent('Showing 1 of 12 students');
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'EpiPen' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Carries an EpiPen.');

    toggle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Carries an EpiPen.')).not.toBeInTheDocument();
    expect(screen.getByText('First2 Last2')).toBeInTheDocument(); // the full class again

    toggle();
    expect(status()).toHaveTextContent('Showing all 12 students');
    expect(screen.getByRole('button', { name: /^Alerts/ })).toHaveAttribute('data-state', 'none');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('RosterTab cards', () => {
  it('dropped students appear only behind "N dropped (show)" and are never counted or copied', async () => {
    api.getEmails.mockResolvedValue({ formatted: 'x', addresses: ['x'], count: 1, excluded: 0, emails: ['x'], students: [] });
    renderTab();
    expect(screen.queryByText('Dee Parted')).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: '1 dropped (show)' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure);
    expect(screen.getByRole('button', { name: '1 dropped (hide)' })).toBeInTheDocument();
    expect(within(cardOf('Dee Parted')).getByText('dropped 13/08/2026')).toBeInTheDocument();

    toggle();
    await screen.findByRole('button', { name: /2 comments/ });
    // Only the dropped student holds Mobility, and their 5 unread comments count nowhere.
    expect(screen.queryByRole('button', { name: /^Mobility/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Follow up/ })).toHaveTextContent('Follow up2');
    expect(within(cardOf('Dee Parted')).queryByRole('button', { name: /comments?/ })).not.toBeInTheDocument();
    expect(within(cardOf('Dee Parted')).queryByText('Mobility')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent('Showing all 12 students');

    fireEvent.click(screen.getByRole('button', { name: 'Copy emails (12)' }));
    await waitFor(() => expect(api.getEmails).toHaveBeenCalled());
    const [, , , { students: ids }] = api.getEmails.mock.calls[0];
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain(13);
  });

  it('shows no dropped toggle when nobody has dropped', () => {
    renderTab('/course/5', { students: STUDENTS.filter((s) => !s.dropped_at) });
    expect(screen.getByText('Annie Lee')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dropped/ })).not.toBeInTheDocument();
  });

  it('a student without an email has no number and no Email button', () => {
    renderTab();
    const card = cardOf('First12 Last12');
    expect(within(card).queryByRole('button', { name: /Copy email/ })).not.toBeInTheDocument();
    expect(card.querySelector('.roster-card__number')).toBeNull();
    expect(within(card).getByText(gradeText(2027))).toBeInTheDocument();
  });

  it('tapping a card opens /student/:id; tapping Email copies the address and does not navigate', async () => {
    renderTab();
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'Copy email 27001@hkis.edu.hk' }));
    expect(writeText).toHaveBeenCalledWith('27001@hkis.edu.hk');
    expect(await within(cardOf('Annie Lee')).findByText('Copied')).toBeInTheDocument();
    expect(screen.queryByText(/Student page/)).not.toBeInTheDocument();

    fireEvent.click(cardOf('First2 Last2'));
    expect(screen.getByText('Student page 2')).toBeInTheDocument();
  });

  it('the name is a link to the student page, for the keyboard', () => {
    renderTab();
    expect(screen.getByRole('link', { name: 'Annie Lee' })).toHaveAttribute('href', '/student/1');
  });
});

describe('RosterTab pop-ups', () => {
  it('an alert chip reads the alert live: rows as a table, empty rows left out', async () => {
    api.getAlertDetail.mockResolvedValue({
      alertKey: 'accommodation_plan', kind: 'rows', suggestedPercent: 25, readAt: '2026-10-25T02:00:00Z',
      rows: [
        { category: 'Academic Support', description: 'Learning support 2' },
        { category: 'Case Manager', description: '' },
        { category: 'Accommodation Plan', description: 'Extended time (25%) on tests.' },
        { category: '', description: 'A line with no label.' },
      ],
    });
    renderTab();
    toggle();
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'Accommodation plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Annie Lee: Accommodation plan' });
    expect(api.getAlertDetail).toHaveBeenCalledWith(1, 'accommodation_plan');
    await within(dialog).findByRole('table');
    const rows = within(dialog).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toEqual(['Academic SupportLearning support 2', 'Accommodation PlanExtended time (25%) on tests.', 'A line with no label.']);
    expect(dialog).toHaveTextContent('From PowerSchool, read 25/10/2026');
  });

  it('a rows answer without rows reads as an alert Prism cannot read', async () => {
    api.getAlertDetail.mockResolvedValue({ alertKey: 'epipen', kind: 'rows', suggestedPercent: null, readAt: null });
    renderTab();
    toggle();
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'EpiPen' }));
    expect(await screen.findByText('Prism can read only that this alert is set.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('an alert Prism cannot read says so; a failed read shows the error', async () => {
    api.getAlertDetail.mockResolvedValueOnce({ alertKey: 'no_photo', kind: 'none', suggestedPercent: null, readAt: '2026-10-25T02:00:00Z' });
    renderTab();
    toggle();
    fireEvent.click(within(cardOf('First12 Last12')).getByRole('button', { name: 'No photo' }));
    expect(await screen.findByText('Prism can read only that this alert is set.')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    api.getAlertDetail.mockRejectedValueOnce(Object.assign(new Error('The PowerSchool session has expired'), { code: 'SESSION_EXPIRED' }));
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'EpiPen' }));
    expect(await screen.findByText(/Could not read this alert: The PowerSchool session has expired/)).toBeInTheDocument();
  });

  it('the comments count lists the unread comments, oldest first, each linking to its task', async () => {
    api.getUnreadComments.mockResolvedValue({ comments: [
      { schoologyAssignmentId: 'a1', title: 'Data Lab', created: '2026-10-19T12:14:00Z', studentText: 'Wrong file, see the second one.', attachments: [{ fid: 4, filename: 'lab.pdf', filesize: 2048 }] },
      { schoologyAssignmentId: 'a2', title: 'Unit 2 Practice', created: '2026-10-22T08:02:00Z', studentText: 'Can I resubmit question 4?', attachments: [] },
    ] });
    renderTab();
    toggle();
    fireEvent.click(await within(cardOf('Annie Lee')).findByRole('button', { name: /2 comments/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Annie Lee: unread comments' });
    expect(api.getUnreadComments).toHaveBeenCalledWith('5', 1);
    await within(dialog).findByText('Data Lab');
    expect([...dialog.querySelectorAll('.roster-comment b')].map((b) => b.textContent)).toEqual(['Data Lab', 'Unit 2 Practice']);
    expect(dialog).toHaveTextContent('Wrong file, see the second one.');
    expect(dialog).toHaveTextContent('lab.pdf');
    const links = within(dialog).getAllByRole('link', { name: 'Open the task in Prism' });
    expect(links[0]).toHaveAttribute('href', '/course/5/assessment/a1?student=1');
  });

  it('Copy emails: students or guardians of the students shown, in the Class Tools formats', async () => {
    api.getEmails.mockImplementation((courseId, type) => Promise.resolve(type === 'parent'
      ? { formatted: '"Mei Lee (parent of Annie Lee)" <mei@x.com>', addresses: ['mei@x.com'], count: 1, excluded: 1, emails: [], students: [] }
      : { formatted: 'Annie Lee <27001@hkis.edu.hk>', addresses: ['27001@hkis.edu.hk'], count: 1, excluded: 0, emails: [], students: [] }));
    renderTab();
    toggle();
    fireEvent.click(screen.getByRole('button', { name: /^Learning plan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy emails (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy emails' });
    expect(api.getEmails).toHaveBeenLastCalledWith('5', 'student', '', { students: [1] });
    const box = within(dialog).getByRole('textbox', { name: 'Emails to copy' });
    await waitFor(() => expect(box).toHaveValue('Annie Lee <27001@hkis.edu.hk>'));
    expect(box).toHaveAttribute('readonly');

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Whose emails' }), { target: { value: 'parent' } });
    await waitFor(() => expect(box).toHaveValue('"Mei Lee (parent of Annie Lee)" <mei@x.com>'));
    expect(api.getEmails).toHaveBeenLastCalledWith('5', 'parent', '', { students: [1] });
    expect(dialog).toHaveTextContent('1 guardian not copied');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Format' }), { target: { value: 'bare' } });
    expect(box).toHaveValue('mei@x.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy 1 email' }));
    expect(writeText).toHaveBeenCalledWith('mei@x.com');
  });

  it('a click outside closes a pop-up', async () => {
    api.getAlertDetail.mockResolvedValue({ alertKey: 'epipen', kind: 'text', text: 'Carries an EpiPen.', suggestedPercent: null, readAt: null });
    renderTab();
    toggle();
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('button', { name: 'EpiPen' }));
    await screen.findByRole('dialog');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// Gender on the card, the Gender filter row and the sort (25 Oct 2026, #160).
const SORTABLE = [
  student(1, { first_name: 'Ben', last_name: 'Cole', gender: 'M' }),
  student(2, { first_name: 'Amy', last_name: 'Dunn', gender: 'F' }),
  student(3, { first_name: 'Cal', last_name: 'Aston', gender: null }),
  student(4, { first_name: 'Dee', last_name: 'Bell', gender: 'F' }),
  student(5, { first_name: 'Eve', last_name: 'Zed', gender: 'F', dropped_at: '2026-08-13T00:00:00Z' }),
  student(6, { first_name: 'Fay', last_name: 'Abel', gender: 'M', dropped_at: '2026-08-14T00:00:00Z' }),
];
const order = () => [...document.querySelectorAll('.roster-mode > .roster-cards .roster-card__name')].map((a) => a.textContent);
const sortGroup = () => screen.getByRole('group', { name: 'Sort by' });
const sortBtn = (name) => within(sortGroup()).getByRole('button', { name });

describe('RosterTab gender', () => {
  const tagOf = (name) => cardOf(name).querySelector('.roster-tag');
  const metaOf = (name) => cardOf(name).querySelector('.roster-card__meta').textContent;

  it('with Private details on, the tag after the name reads F, M, NB or ? for F, M, X and a blank value', () => {
    renderTab('/course/5', { students: [
      student(1, { first_name: 'Ana', last_name: 'Lee', gender: 'F' }),
      student(2, { first_name: 'Bo', last_name: 'Mur', gender: 'M' }),
      student(3, { first_name: 'Cy', last_name: 'Nox', gender: 'X' }),
      student(4, { first_name: 'Di', last_name: 'Orr', gender: null }),
    ] });
    toggle();
    expect(tagOf('Ana Lee')).toHaveTextContent(/^F$/);
    expect(tagOf('Bo Mur')).toHaveTextContent(/^M$/);
    expect(tagOf('Cy Nox')).toHaveTextContent(/^NB$/);
    expect(tagOf('Di Orr')).toHaveTextContent(/^\?$/);
  });

  it('the tag is named in full and shows that label in an instant popover on hover, focus and tap', () => {
    renderTab('/course/5', { students: [student(1, { first_name: 'Cy', last_name: 'Nox', gender: 'X' }), student(2, { first_name: 'Di', last_name: 'Orr', gender: null })] });
    toggle();
    const nb = within(cardOf('Cy Nox')).getByRole('img', { name: 'Recorded in PowerSchool as "X"' });
    expect(nb).toHaveAttribute('tabindex', '0');
    expect(within(cardOf('Di Orr')).getByRole('img', { name: 'Not recorded in PowerSchool' })).toBeInTheDocument();
    expect(nb).not.toHaveAttribute('title'); // an instant popover, not a native title delay
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.mouseEnter(nb);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
    fireEvent.mouseLeave(nb);
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.focus(nb);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
    fireEvent.blur(nb);
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.click(nb); // a phone has no hover
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
  });

  it('tapping a tag shows its popover and does not open the student page', () => {
    renderTab();
    toggle();
    fireEvent.click(within(cardOf('Annie Lee')).getByRole('img', { name: 'Female' }));
    expect(screen.queryByText(/Student page/)).not.toBeInTheDocument();
    expect(document.querySelector('.help-pop')).toHaveTextContent('Female');
  });

  it('the tag sits on the name line, inside the element that holds the name, so the card gains no line', () => {
    renderTab();
    toggle();
    const name = cardOf('Annie Lee').querySelector('.roster-card__name');
    const tag = tagOf('Annie Lee');
    expect(name.parentElement).toBe(tag.closest('.roster-card__nameline'));
    expect(name.nextElementSibling).toBe(tag.closest('.roster-tags')); // right after the name
    expect(cardOf('Annie Lee').querySelector('.roster-card__meta')).not.toContainElement(tag);
  });

  it('the meta line is grade, student number, Email: no gender', () => {
    renderTab();
    toggle();
    expect(metaOf('Annie Lee')).toBe(`${gradeText(2027)}27001Email`);
    expect(metaOf('First2 Last2')).toBe(`${gradeText(2027)}27002Email`);
    expect(metaOf('First4 Last4')).toBe(`${gradeText(2027)}27004Email`);
    expect(cardOf('First4 Last4').querySelector('.roster-card__gender')).toBeNull();
  });

  it('with Private details off, no tag is in the DOM; turning it on draws one, off removes it', () => {
    const { container } = renderTab();
    expect(container.querySelector('.roster-tags, .roster-tag')).toBeNull();
    expect(container).not.toHaveTextContent(/Female|Male|Recorded in PowerSchool|Not recorded/);
    toggle();
    expect(container.querySelectorAll('.roster-tag').length).toBeGreaterThan(0);
    toggle();
    expect(container.querySelector('.roster-tags, .roster-tag')).toBeNull();
    expect(container).not.toHaveTextContent(/Female|Male|Recorded in PowerSchool|Not recorded/);
    expect(container.querySelector('[aria-label="Female"]')).toBeNull();
  });

  it('the Gender row lists the F, M and ? codes with counts; the dropped student is never counted', () => {
    renderTab();
    toggle();
    const row = screen.getByRole('group', { name: 'Gender' });
    expect([...row.querySelectorAll('.filter-btn')].map((b) => b.textContent)).toEqual(['F2', 'M1', '?9']);
    expect(within(row).getByRole('button', { name: /^Gender/ })).toHaveTextContent('Gender12');
  });

  it('Female shows the two women; Female and Male together show three; the Gender row narrows Alerts (AND)', async () => {
    renderTab();
    toggle();
    fireEvent.click(screen.getByRole('button', { name: /^Female/ }));
    expect(status()).toHaveTextContent('Showing 2 of 12 students');
    expect(order()).toEqual(['First3 Last3', 'Annie Lee']); // by last name: Last3, Lee
    fireEvent.click(screen.getByRole('button', { name: /^Male/ }));
    expect(status()).toHaveTextContent('Showing 3 of 12 students');
    fireEvent.click(screen.getByRole('button', { name: /^Not recorded/ }));
    expect(status()).toHaveTextContent('Showing 12 of 12 students');
    fireEvent.click(screen.getByRole('button', { name: /Clear all/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Learning plan/ })); // Annie (F) only holds a plan
    expect(status()).toHaveTextContent('Showing 1 of 12 students');
    fireEvent.click(screen.getByRole('button', { name: /^Male/ }));
    expect(status()).toHaveTextContent('Showing 0 of 12 students'); // Male AND Learning plan: nobody
    fireEvent.click(screen.getByRole('button', { name: /^Female/ }));
    expect(status()).toHaveTextContent('Showing 1 of 12 students'); // (Female or Male) AND Learning plan
    expect(order()).toEqual(['Annie Lee']);
    fireEvent.click(screen.getByRole('button', { name: /^Male/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unread comments/ })); // (Learning plan or Unread) AND Female
    expect(order()).toEqual(['First3 Last3', 'Annie Lee']);
  });

  it('the Gender row is not in the page with Private details off', () => {
    renderTab();
    expect(screen.queryByRole('group', { name: 'Gender' })).not.toBeInTheDocument();
  });
});

describe('RosterTab sort', () => {
  it('Sort by offers First name and Last name; the default is Last name', () => {
    renderTab('/course/5', { students: SORTABLE });
    expect([...sortGroup().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['First name', 'Last name']);
    expect(sortBtn('Last name')).toHaveAttribute('aria-pressed', 'true');
    expect(sortBtn('First name')).toHaveAttribute('aria-pressed', 'false');
    expect(order()).toEqual(['Cal Aston', 'Dee Bell', 'Ben Cole', 'Amy Dunn']);
  });

  it('First name sorts by the name the card shows', () => {
    renderTab('/course/5', { students: SORTABLE });
    fireEvent.click(sortBtn('First name'));
    expect(sortBtn('First name')).toHaveAttribute('aria-pressed', 'true');
    expect(order()).toEqual(['Amy Dunn', 'Ben Cole', 'Cal Aston', 'Dee Bell']);
  });

  it('Gender is offered only with Private details on: F, M, NB, ?, each by last name', () => {
    renderTab('/course/5', { students: SORTABLE });
    expect(within(sortGroup()).queryByRole('button', { name: 'Gender' })).not.toBeInTheDocument();
    toggle();
    expect([...sortGroup().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['First name', 'Last name', 'Gender']);
    fireEvent.click(sortBtn('Gender'));
    expect(order()).toEqual(['Dee Bell', 'Amy Dunn', 'Ben Cole', 'Cal Aston']);
  });

  it('a stored Gender sort reads as Last name while Private details is off, and the stored value stays', () => {
    localStorage.setItem('prism:roster:sort', 'gender');
    renderTab('/course/5', { students: SORTABLE });
    expect(order()).toEqual(['Cal Aston', 'Dee Bell', 'Ben Cole', 'Amy Dunn']);
    expect(sortBtn('Last name')).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('prism:roster:sort')).toBe('gender');
    toggle();
    expect(sortBtn('Gender')).toHaveAttribute('aria-pressed', 'true');
    expect(order()).toEqual(['Dee Bell', 'Amy Dunn', 'Ben Cole', 'Cal Aston']);
  });

  it('is remembered on this device, for every course', () => {
    const first = renderTab('/course/5', { students: SORTABLE });
    fireEvent.click(sortBtn('First name'));
    first.unmount();
    renderTab('/course/5', { students: SORTABLE });
    expect(sortBtn('First name')).toHaveAttribute('aria-pressed', 'true');
    expect(order()).toEqual(['Amy Dunn', 'Ben Cole', 'Cal Aston', 'Dee Bell']);
    expect(localStorage.getItem('prism:roster:sort')).toBe('first');
  });

  it('works when storage throws, holding the choice for the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const first = renderTab('/course/5', { students: SORTABLE });
    expect(order()).toEqual(['Cal Aston', 'Dee Bell', 'Ben Cole', 'Amy Dunn']);
    fireEvent.click(sortBtn('First name'));
    expect(order()).toEqual(['Amy Dunn', 'Ben Cole', 'Cal Aston', 'Dee Bell']);
    first.unmount();
    renderTab('/course/5', { students: SORTABLE });
    expect(order()).toEqual(['Amy Dunn', 'Ben Cole', 'Cal Aston', 'Dee Bell']);
  });

  it('applies to the Roster mode only: Needs attention and Mastery do not show the control', () => {
    renderTab('/course/5?mode=mastery', { students: SORTABLE });
    expect(screen.queryByRole('group', { name: 'Sort by' })).not.toBeInTheDocument();
    toggle();
    expect(screen.queryByRole('group', { name: 'Sort by' })).not.toBeInTheDocument();
  });

  it('Needs attention does not show the control, with Private details off or on', () => {
    renderTab('/course/5?mode=attention', { students: SORTABLE });
    expect(screen.queryByRole('group', { name: 'Sort by' })).not.toBeInTheDocument();
    toggle();
    expect(screen.queryByRole('group', { name: 'Sort by' })).not.toBeInTheDocument();
  });

  it('has no Sort by control when nobody is enrolled', () => {
    renderTab('/course/5', { students: [SORTABLE[4]] }); // only a dropped student
    expect(screen.queryByRole('group', { name: 'Sort by' })).not.toBeInTheDocument();
    expect(screen.getByText('No students are enrolled.')).toBeInTheDocument();
  });

  it('sorts the dropped students too, and filters leave the sort as it was', () => {
    renderTab('/course/5', { students: SORTABLE });
    toggle();
    fireEvent.click(sortBtn('Gender'));
    fireEvent.click(screen.getByRole('button', { name: /^Female/ }));
    expect(order()).toEqual(['Dee Bell', 'Amy Dunn']);
    fireEvent.click(screen.getByRole('button', { name: '2 dropped (show)' }));
    const dropped = () => [...document.querySelectorAll('.roster-dropped .roster-card__name')].map((a) => a.textContent);
    expect(dropped()).toEqual(['Eve Zed', 'Fay Abel']); // Gender: Female, then Male
    fireEvent.click(sortBtn('Last name'));
    expect(dropped()).toEqual(['Fay Abel', 'Eve Zed']);
  });
});

describe('RosterTab modes', () => {
  it('four mode tabs, remembered in the URL as ?mode=', () => {
    renderTab();
    const modes = screen.getByRole('tablist', { name: 'Roster view' });
    // #192: the first is "Details and Attendance", since "Roster" repeated the parent tab; its id stays `roster`.
    expect(within(modes).getAllByRole('tab').map((b) => b.textContent)).toEqual(['Details and Attendance', 'Needs attention', 'Test day', 'Mastery']);
    expect(within(modes).getByRole('tab', { name: 'Details and Attendance' })).toHaveClass('subtab-btn', 'active');
    fireEvent.click(within(modes).getByRole('tab', { name: 'Mastery' }));
    expect(screen.getByTestId('search')).toHaveTextContent('mode=mastery');
    expect(within(modes).getByRole('tab', { name: 'Mastery' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Annie Lee')).not.toBeInTheDocument();
  });

  it('Mastery is locked with the switch off, and with it on says when there is no mastery data', () => {
    renderTab('/course/5?mode=mastery');
    expect(screen.getByText('Levels and grades are private.')).toBeInTheDocument();
    toggle();
    expect(screen.getByText('No mastery data yet. Press Sync Course.')).toBeInTheDocument();
    expect(screen.queryByText('Levels and grades are private.')).not.toBeInTheDocument();
  });

  it('with the switch off, a private mode shows only its explanation', () => {
    renderTab('/course/5?mode=attention');
    // The shared PrivateHidden box (#197), the same on every page.
    expect(screen.getByText('Overdue work, referrals and comments are private.')).toBeInTheDocument();
    expect(screen.getByText('Turn on Private details in the side menu to see it. It stays hidden so the page is safe to project.')).toBeInTheDocument();
    expect(screen.queryByText('Annie Lee')).not.toBeInTheDocument();
  });
});
