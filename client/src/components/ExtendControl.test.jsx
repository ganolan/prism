import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ExtendControl from './ExtendControl.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  recordExtension: vi.fn(), undoExtension: vi.fn(),
  previewStatusLine: vi.fn(), getLessonPlan: vi.fn().mockResolvedValue(null), getStatusLineUntil: vi.fn(), getMasteryLoginStatus: vi.fn(),
}));

const timeline = (extension = null) => ({
  due: { date: '2026-10-14', time: '15:30' }, extension, deadline: extension?.until ?? '2026-10-14',
  submission: { state: 'not_submitted' }, overdue: null, resubmission: null, referral: null, limit: 8,
});
const student = (extension = null) => ({ id: 7, schoology_uid: 'u7', first_name: 'Maya', last_name: 'Chen', timeline: timeline(extension) });
const assignment = (over = {}) => ({ id: 30, title: 'CP2', due_date: '2026-10-14 15:30:00', is_test: 0, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 8, 9, 0)); // Thu 08/10/2026: before the due date
  api.previewStatusLine.mockResolvedValue({ currentComment: 'Good start.', visible: true, storedLine: null, hiddenWarning: false });
  api.getStatusLineUntil.mockResolvedValue({ until: '2026-10-19', lessons: 3 });
  api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected', checkedAt: '2026-10-03T06:05:00Z' });
});
afterEach(() => vi.useRealTimers());

function renderControl(s = student(), a = assignment()) {
  const onChange = vi.fn();
  render(<ExtendControl student={s} assignment={a} courseId={5} onChange={onChange} />);
  return onChange;
}

describe('ExtendControl (assessment card)', () => {
  it('before the due date: Extend → N school days from the due date → confirm → publish; the card gets the new timeline', async () => {
    const newTimeline = timeline({ id: 11, until: '2026-10-19', schoolDaysLeft: 3 });
    api.recordExtension.mockResolvedValue({
      id: 11, until: '2026-10-19', timeline: newTimeline,
      statusLine: { comment: 'Extension - now due Mon 19/10 (3 school days). trip\n\nGood start.', line: 'Extension - now due Mon 19/10 (3 school days). trip' },
    });
    const onChange = renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }));
    expect(screen.getByLabelText('Extension (school days)')).toHaveValue(3);
    fireEvent.change(screen.getByLabelText('Extension note'), { target: { value: 'trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('counted from the due date');
    const line = 'Extension - now due Mon 19/10 (3 school days). trip';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'extension', studentId: 7, assignmentId: 30, lessons: 3 });
    expect(api.recordExtension).not.toHaveBeenCalled(); // nothing written until Publish
    fireEvent.click(await screen.findByRole('button', { name: 'Publish new due date' }));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: 'trip', commentLine: line }));
    expect(onChange).toHaveBeenCalledWith(newTimeline, { comment: `${line}\n\nGood start.`, line, kind: 'extension' });
  });

  it('after the due date the confirm says it counts from today; a test is a make-up line', async () => {
    vi.setSystemTime(new Date(2026, 9, 16, 9, 0));
    renderControl(student(), assignment({ is_test: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('to sit the test, counted from today');
    expect(await screen.findByDisplayValue('Make-up - sit by Mon 19/10.')).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'make_up', studentId: 7, assignmentId: 30, lessons: 3 });
  });

  it('an existing extension: the pill shows its date, the editor starts from the school days left, Undo removes it', async () => {
    api.undoExtension.mockResolvedValue({ deleted: true, timeline: timeline(null), statusLine: { removed: true, comment: 'Good start.' } });
    const onChange = renderControl(student({ id: 11, until: '2026-10-19', schoolDaysLeft: 2, note: 'trip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Extended to 19/10/2026' }));
    expect(screen.getByLabelText('Extension (school days)')).toHaveValue(2);
    expect(screen.getByLabelText('Extension note')).toHaveValue('trip');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoExtension).toHaveBeenCalledWith(11, { removeLine: true }));
    expect(onChange).toHaveBeenCalledWith(timeline(null), { comment: 'Good start.', line: null, kind: null });
  });

  it('renders nothing without an assignment due date', () => {
    const { container } = render(<ExtendControl student={student()} assignment={assignment({ due_date: null })} courseId={5} />);
    expect(container).toBeEmptyDOMElement();
  });
});
