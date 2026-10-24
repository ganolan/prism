// Test day on the Roster tab (#160): each learning plan's extra time for a chosen test, from a figure
// the teacher confirms once. Rendered through RosterTab, so Private details works as it does on the page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RosterTab from './RosterTab.jsx';
import { setPrivateDetails } from '../../lib/privateDetails.js';
import { localIsoDate } from '../../lib/formatDate.js';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getCourseCommentSummaries: vi.fn(),
  getAlertDetail: vi.fn(),
  getUnreadComments: vi.fn(),
  getEmails: vi.fn(),
  getExtraTime: vi.fn(),
  setExtraTime: vi.fn(),
  clearExtraTime: vi.fn(),
}));

const A = {
  plan: { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' },
  ls1: { key: 'learning_support_1', label: 'Learning support 1', category: 'learning' },
  summary: { key: 'support_summary', label: 'Support summary', category: 'learning' },
  epipen: { key: 'epipen', label: 'EpiPen', category: 'health' },
};
const student = (id, first, last, alerts, extra = {}) => ({
  id, first_name: first, last_name: last, email: `2700${id}@hkis.edu.hk`, grad_year: 2027, ps_alerts: alerts, dropped_at: null, ...extra,
});
const MAYA = student(1, 'Maya', 'Chen', [A.plan]); // confirmed
const ETHAN = student(2, 'Ethan', 'Wong', [A.ls1, A.summary]); // suggested
const AIDEN = student(3, 'Aiden', 'Li', [A.summary]); // none found
const NOAH = student(4, 'Noah', 'Park', [A.epipen]); // health only
const DEE = student(5, 'Dee', 'Parted', [A.plan], { dropped_at: '2026-09-01T00:00:00Z' });
const STUDENTS = [MAYA, ETHAN, AIDEN, NOAH, DEE];

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${localIsoDate(d)} 10:15:00`; };
const test = (id, title, due) => ({ schoology_assignment_id: id, title, due_date: due, is_test: 1, published: 1 });
const GRADEBOOK = { assignments: [test('t2', 'Unit 3 test', inDays(9)), test('t1', 'Quiz 2', inDays(2)), { ...test('t0', 'Old test', inDays(-3)) }] };

const detail = (key, description, suggestedPercent) => ({
  alertKey: key, kind: 'rows', suggestedPercent, readAt: '2026-10-25T01:00:00Z',
  rows: [{ category: 'Academic Support', description: 'Learning support 1' }, { category: 'Support Notes', description }],
});

function renderTab(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/course/5?mode=testday']}>
      <RosterTab course={{ id: 5 }} students={STUDENTS} gradebook={GRADEBOOK} courseId="5" {...props} />
    </MemoryRouter>,
  );
}
const cardOf = (name) => screen.getByRole('link', { name }).closest('.test-day-card');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); setPrivateDetails(true);
  sessionStorage.clear();
  api.getCourseCommentSummaries.mockResolvedValue({ assignments: {} });
  api.getExtraTime.mockResolvedValue({ 1: { percent: 25, updatedAt: '2026-10-20T00:00:00Z' } });
  api.getAlertDetail.mockImplementation(async (id) => {
    if (id === 2) return detail('learning_support_1', 'Extended time (25%)', 25);
    if (id === 3) return detail('support_summary', 'Quiet room if available', null);
    throw Object.assign(new Error('Not this student'), { code: 'NO_ALERT' });
  });
  api.setExtraTime.mockImplementation(async (id, percent) => ({ percent, updatedAt: '2026-10-25T02:00:00Z' }));
});

describe('Test day', () => {
  it('shows the picker and length with Private details off, and no student at all', () => {
    setPrivateDetails(false);
    renderTab();
    const picker = screen.getByRole('combobox', { name: 'Test' });
    expect(within(picker).getByRole('option', { name: /^Quiz 2,/ }).selected).toBe(true); // the nearest test
    expect(within(picker).getByRole('option', { name: 'No test (plans only)' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Old test/ })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Test length in minutes' })).toHaveValue(50);
    expect(screen.getByText('Extra time for learning plans is private.')).toBeInTheDocument();
    for (const name of ['Maya', 'Ethan', 'Aiden', 'Chen', 'Wong', 'Accommodation plan']) expect(screen.queryByText(new RegExp(name))).toBeNull();
    expect(api.getExtraTime).not.toHaveBeenCalled();
    expect(api.getAlertDetail).not.toHaveBeenCalled();
  });

  it('lists learning plans only: a health-only student and a dropped one are absent', async () => {
    renderTab();
    await screen.findByRole('link', { name: 'Maya Chen' });
    expect(screen.getByRole('link', { name: 'Ethan Wong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aiden Li' })).toBeInTheDocument();
    expect(screen.queryByText(/Noah/)).toBeNull();
    expect(screen.queryByText(/Dee/)).toBeNull();
    expect(api.getExtraTime).toHaveBeenCalledWith([1, 2, 3]);
    // The plan names sit under the name.
    expect(within(cardOf('Ethan Wong')).getByText('Learning support 1, Support summary')).toBeInTheDocument();
  });

  it('a confirmed student shows the total and extra minutes with Change, and causes no plan read', async () => {
    renderTab();
    const card = (await screen.findByRole('link', { name: 'Maya Chen' })).closest('.test-day-card');
    expect(within(card).getByText('63 minutes, 13 more')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    await waitFor(() => expect(api.getAlertDetail).toHaveBeenCalledTimes(2));
    expect(api.getAlertDetail.mock.calls.map(([id]) => id)).toEqual([2, 3]);
  });

  it('a suggested figure shows "Notes mention 25%"; Use 25% saves it', async () => {
    renderTab();
    await waitFor(() => expect(within(cardOf('Ethan Wong')).getByText('Notes mention 25%')).toBeInTheDocument());
    const card = cardOf('Ethan Wong');
    expect(api.getAlertDetail).toHaveBeenCalledWith(2, 'learning_support_1'); // the first learning alert
    expect(within(card).getByText('Extended time (25%)')).toBeInTheDocument(); // the plan line
    expect(within(card).getByRole('button', { name: 'Other' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Use 25%' }));
    expect(api.setExtraTime).toHaveBeenCalledWith(2, 25);
    expect(await within(card).findByText('63 minutes, 13 more')).toBeInTheDocument();
  });

  it('no figure in the notes shows Set extra time, which opens a 5% stepper and Save', async () => {
    renderTab();
    await waitFor(() => expect(within(cardOf('Aiden Li')).getByText('No time in the notes')).toBeInTheDocument());
    const card = cardOf('Aiden Li');
    expect(within(card).getByText('Learning support 1')).toBeInTheDocument(); // no time in the rows: the first one
    fireEvent.click(within(card).getByRole('button', { name: 'Set extra time' }));
    const stepper = within(card).getByRole('spinbutton', { name: 'Extra time for Aiden Li, percent' });
    expect(stepper).toHaveValue(25);
    fireEvent.click(within(card).getByRole('button', { name: 'Increase' }));
    expect(stepper).toHaveValue(30);
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(api.setExtraTime).toHaveBeenCalledWith(3, 30);
    expect(await within(card).findByText('65 minutes, 15 more')).toBeInTheDocument();
  });

  it('Change opens the stepper at the confirmed figure', async () => {
    renderTab();
    const card = (await screen.findByRole('link', { name: 'Maya Chen' })).closest('.test-day-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Change' }));
    expect(within(card).getByRole('spinbutton', { name: 'Extra time for Maya Chen, percent' })).toHaveValue(25);
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).getByText('63 minutes, 13 more')).toBeInTheDocument();
  });

  it('reads plans one after another, not in parallel', async () => {
    let release;
    api.getAlertDetail.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(detail('learning_support_1', 'Extended time (25%)', 25)); }));
    renderTab();
    await waitFor(() => expect(api.getAlertDetail).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.getAlertDetail).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(api.getAlertDetail).toHaveBeenCalledTimes(2));
  });

  it('a failed read shows that student\'s error, and the others still render', async () => {
    api.getAlertDetail.mockImplementation(async (id) => {
      if (id === 2) throw Object.assign(new Error('Could not read PowerSchool: timed out'), { code: 'PS_FAILED' });
      return detail('support_summary', 'Quiet room if available', null);
    });
    renderTab();
    await waitFor(() => expect(within(cardOf('Ethan Wong')).getByText(/Could not read PowerSchool: timed out/)).toBeInTheDocument());
    expect(within(cardOf('Ethan Wong')).getByRole('button', { name: 'Set extra time' })).toBeInTheDocument();
    await waitFor(() => expect(within(cardOf('Aiden Li')).getByText('No time in the notes')).toBeInTheDocument());
    expect(within(cardOf('Maya Chen')).getByText('63 minutes, 13 more')).toBeInTheDocument();
  });

  // A refused read (PowerSchool logged a security violation) or an ended session would only repeat
  // for every later student: the loop stops, and the list says why once (psSupportSummary's codes).
  for (const [code, message] of [
    ['SECURITY_VIOLATION', 'PowerSchool refused the read'],
    ['SESSION_EXPIRED', 'The Schoology session has expired: log in to Schoology in Settings'],
  ]) {
    it(`stops reading plans after ${code} and says so once for the list`, async () => {
      api.getAlertDetail.mockImplementation(async () => { throw Object.assign(new Error(message), { code }); });
      renderTab();
      expect(await screen.findByText(`Could not read the plans: ${message}`)).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(api.getAlertDetail).toHaveBeenCalledTimes(1); // Ethan only: Aiden is never read
      expect(screen.getAllByText(new RegExp(message))).toHaveLength(1); // not repeated on a card
      for (const name of ['Ethan Wong', 'Aiden Li']) {
        expect(within(cardOf(name)).queryByText('Reading the plan…')).toBeNull();
        expect(within(cardOf(name)).getByRole('button', { name: 'Set extra time' })).toBeInTheDocument();
      }
      // No read on request either: Show plan is gone for the confirmed student.
      expect(within(cardOf('Maya Chen')).queryByRole('button', { name: 'Show plan' })).toBeNull();
      expect(within(cardOf('Maya Chen')).getByText('63 minutes, 13 more')).toBeInTheDocument();
    });
  }

  it('a confirmed student loads the plan line only on request', async () => {
    api.getAlertDetail.mockImplementation(async (id) => detail('accommodation_plan', id === 1 ? '25% extra time on tests' : 'Quiet room', null));
    renderTab();
    const card = (await screen.findByRole('link', { name: 'Maya Chen' })).closest('.test-day-card');
    await waitFor(() => expect(api.getAlertDetail).toHaveBeenCalledTimes(2));
    expect(api.getAlertDetail).not.toHaveBeenCalledWith(1, expect.anything());
    fireEvent.click(within(card).getByRole('button', { name: 'Show plan' }));
    expect(await within(card).findByText('25% extra time on tests')).toBeInTheDocument();
    expect(api.getAlertDetail).toHaveBeenCalledWith(1, 'accommodation_plan');
  });

  it('the length changes every card\'s minutes', async () => {
    renderTab();
    const card = (await screen.findByRole('link', { name: 'Maya Chen' })).closest('.test-day-card');
    const length = screen.getByRole('spinbutton', { name: 'Test length in minutes' });
    fireEvent.click(within(length.closest('.number-stepper')).getByRole('button', { name: 'Increase' }));
    expect(length).toHaveValue(55);
    expect(within(card).getByText('69 minutes, 14 more')).toBeInTheDocument();
  });

  it('with no test in the next two weeks: the dashed box, and extra minutes still show', async () => {
    renderTab({ gradebook: { assignments: [test('t0', 'Old test', inDays(-3)), test('t9', 'Far test', inDays(20))] } });
    expect(screen.getByText('No test is set in the next two weeks.')).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Test' });
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['No test (plans only)']);
    const card = (await screen.findByRole('link', { name: 'Maya Chen' })).closest('.test-day-card');
    expect(within(card).getByText('63 minutes, 13 more')).toBeInTheDocument();
  });

  it('choosing No test while tests exist says so, without claiming none is set', () => {
    renderTab();
    fireEvent.change(screen.getByRole('combobox', { name: 'Test' }), { target: { value: 'none' } });
    expect(screen.queryByText('No test is set in the next two weeks.')).toBeNull();
    expect(screen.getByText('No test chosen.')).toBeInTheDocument();
  });

  it('says so when no student holds a learning plan', async () => {
    renderTab({ students: [NOAH] });
    expect(await screen.findByText('No student in this class has a learning plan.')).toBeInTheDocument();
    expect(api.getExtraTime).not.toHaveBeenCalled();
  });
});
