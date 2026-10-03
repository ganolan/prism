import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import ResubmitControl from './ResubmitControl.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  requestResubmission: vi.fn(), updateResubmission: vi.fn(), undoResubmission: vi.fn(),
  previewStatusLine: vi.fn(), getStatusLineUntil: vi.fn(), getMasteryLoginStatus: vi.fn(),
}));
const student = (resubmission = null, extra = {}) => ({ id: 7, schoology_uid: 'u7', first_name: 'Maya', last_name: 'Chen', resubmission, ...extra });
const waiting = (until = '2026-10-15') => ({ state: 'waiting', request: { id: 3, lessons: 3, until } });
const modal = () => screen.getByRole('dialog');
const writes = ['requestResubmission', 'updateResubmission', 'undoResubmission'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 10, 9, 0)); // Sat 10/10/2026, local
  api.previewStatusLine.mockResolvedValue({ currentComment: 'Good start.', visible: true, storedLine: null, hiddenWarning: false });
  api.getStatusLineUntil.mockResolvedValue({ until: '2026-10-15', lessons: 3 });
  api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected', checkedAt: '2026-10-03T06:05:00Z' });
});
afterEach(() => vi.useRealTimers());

function renderControl(r = null, props = {}, extra = {}) {
  const onChange = vi.fn();
  render(<ResubmitControl student={student(r, extra)} assignmentId={30} title="CP2" defaultLessons={3} onChange={onChange} {...props} />);
  return onChange;
}

describe('ResubmitControl', () => {
  it('Ask opens the confirm with the due date worked out by the server, then publishes commentLine with the ask', async () => {
    const published = 'Resubmission requested - due Thu 15/10. add tests\n\nGood start.';
    api.requestResubmission.mockResolvedValue({
      id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked',
      statusLine: { comment: published, line: 'Resubmission requested - due Thu 15/10. add tests' },
    });
    const onChange = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.change(screen.getByLabelText('Resubmission note'), { target: { value: 'add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(modal()).toHaveAccessibleName("Publish to Maya Chen's Schoology comment");
    const line = 'Resubmission requested - due Thu 15/10. add tests';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'ask', studentId: 7, assignmentId: 30, lessons: 3 });
    expect(api.requestResubmission).not.toHaveBeenCalled(); // nothing written until Publish
    fireEvent.click(await screen.findByRole('button', { name: 'Publish & ask' }));
    await waitFor(() => expect(api.requestResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: 'add tests', commentLine: line }));
    // I1: the new comment travels with the change, so the card can keep its editor in step.
    expect(onChange).toHaveBeenCalledWith(
      { state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked' } },
      { comment: published, line, kind: 'ask' },
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Cancel in the confirm writes nothing and keeps the panel', async () => {
    const onChange = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByDisplayValue(/Resubmission requested/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const fn of writes) expect(api[fn]).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Resubmission note')).toBeInTheDocument();
  });

  it('a rejected ask shows the server error in the confirm, which stays open', async () => {
    api.requestResubmission.mockRejectedValue(new Error("Couldn't read the grade from Schoology"));
    const onChange = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish & ask' }));
    expect(await screen.findByText("Couldn't read the grade from Schoology")).toBeInTheDocument();
    expect(modal()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an open request before its deadline: Extend + Undo, no Grade stands, no Close', () => {
    renderControl(waiting('2026-10-15'));
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    expect(screen.getByRole('button', { name: 'Extend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('btn-sm');
    expect(screen.queryByRole('button', { name: 'Grade stands' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Resubmission note')).not.toBeInTheDocument(); // extend's note lives in the line
  });

  it('Extend publishes the new due date (extend_resubmission) with the lessons', async () => {
    api.getStatusLineUntil.mockResolvedValue({ until: '2026-10-20', lessons: 4 });
    api.updateResubmission.mockResolvedValue({ id: 3, lessons: 4, until: '2026-10-20' });
    const r = waiting('2026-10-15');
    const onChange = renderControl(r);
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    fireEvent.click(screen.getByLabelText('Increase'));
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }));
    const line = 'Resubmission requested - now due Tue 20/10.';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'extend_resubmission', studentId: 7, assignmentId: 30, resubmissionId: 3, lessons: 4 });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish new due date' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(3, { lessons: 4, commentLine: line }));
    expect(onChange).toHaveBeenCalledWith({ ...r, request: { id: 3, lessons: 4, until: '2026-10-20' } }, null);
  });

  it('after the deadline (red): Grade stands publishes and closes the request', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, outcome: 'grade_stands' });
    const onChange = renderControl(waiting('2026-10-08'));
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 08\/10\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Grade stands' }));
    expect(screen.getByText('Ends the resubmission request: missed deadline, grade stands.')).toBeInTheDocument();
    const line = 'Resubmission deadline (Thu 08/10) passed - your grade stands.';
    expect(screen.getByLabelText('Status line')).toHaveValue(line);
    expect(api.getStatusLineUntil).not.toHaveBeenCalled(); // the deadline is already known
    fireEvent.click(await screen.findByRole('button', { name: 'Publish & close request' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(3, { gradeStands: true, commentLine: line }));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('on the deadline day itself there is no Grade stands yet', () => {
    renderControl(waiting('2026-10-10'));
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 10\/10\/2026/ }));
    expect(screen.queryByRole('button', { name: 'Grade stands' })).not.toBeInTheDocument();
  });

  it('Undo opens the confirm in remove mode; checked → removeLine', async () => {
    api.undoResubmission.mockResolvedValue({ deleted: true });
    const onChange = renderControl(waiting());
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('checkbox', { name: "Remove Prism's line from their comment" })).toBeChecked();
    await screen.findByLabelText('Their comment will read');
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1));
    await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(3, { removeLine: true }));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  // Final review I1: each publish/remove response's comment is handed to the card.
  it('Extend / Grade stands / Undo pass the comment Schoology now holds', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, outcome: 'grade_stands', statusLine: { comment: 'GS line\n\nGood.', line: 'GS line' } });
    let onChange = renderControl(waiting('2026-10-08'));
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 08\/10\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Grade stands' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish & close request' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, { comment: 'GS line\n\nGood.', line: 'GS line', kind: 'grade_stands' }));
    cleanup();

    api.undoResubmission.mockResolvedValue({ deleted: true, statusLine: { removed: true, comment: 'Good.' } });
    onChange = renderControl(waiting());
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByLabelText('Their comment will read');
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, { comment: 'Good.', line: null, kind: null }));
    cleanup();

    // A removal that found no line of its own changed nothing → no comment change.
    api.undoResubmission.mockResolvedValue({ deleted: true, statusLine: { removed: false, comment: null } });
    onChange = renderControl(waiting());
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByLabelText('Their comment will read');
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, null));
  });

  it('Undo of an auto-added (Schoology Unsubmit) request says it closes it; Undo passes its own source', async () => {
    api.previewStatusLine.mockResolvedValue({ currentComment: 'L\n\nGood.', visible: true, storedLine: 'L', storedSource: { sourceType: 'resubmission', sourceId: 8 }, hiddenWarning: false });
    renderControl({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', source: 'schoology_unsubmit' } });
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Closes this resubmission request in Prism.')).toBeInTheDocument();
    expect(await screen.findByText("Prism's current line belongs to a different action — it will stay.")).toBeInTheDocument();
  });

  it('each action remounts the confirm (fresh line state), and Escape returns focus to the panel button', async () => {
    renderControl(waiting('2026-10-08'));
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    const stands = screen.getByRole('button', { name: 'Grade stands' });
    stands.focus();
    fireEvent.click(stands);
    fireEvent.change(screen.getByLabelText('Status line'), { target: { value: 'edited' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(stands).toHaveFocus();
    fireEvent.click(stands);
    expect(screen.getByLabelText('Status line')).toHaveValue('Resubmission deadline (Thu 08/10) passed - your grade stands.');
  });

  it('Undo with the box unchecked leaves the comment alone', async () => {
    api.undoResubmission.mockResolvedValue({ deleted: true });
    renderControl(waiting());
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('checkbox', { name: "Remove Prism's line from their comment" }));
    await screen.findByLabelText('Their comment will read');
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1));
    await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(3, { removeLine: false }));
  });

  it('arrived: awaiting feedback text, no Reviewed (or any) button', () => {
    renderControl({ state: 'arrived', request: { id: 3, lessons: 3, until: '2026-10-15' } });
    expect(screen.getByText('Awaiting your feedback — regrade or comment (visible)')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('reopening the panel resets lessons to the request', () => {
    renderControl(waiting());
    const pill = screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ });
    fireEvent.click(pill);
    fireEvent.click(screen.getByLabelText('Decrease')); // 3 -> 2
    fireEvent.click(pill);
    fireEvent.click(pill);
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
  });

  it('reopening the Ask panel clears a stale note', () => {
    renderControl();
    const pill = screen.getByRole('button', { name: /Ask to resubmit/ });
    fireEvent.click(pill);
    fireEvent.change(screen.getByLabelText('Resubmission note'), { target: { value: 'left over' } });
    fireEvent.click(pill);
    fireEvent.click(pill);
    expect(screen.getByLabelText('Resubmission note')).toHaveValue('');
  });

  it('does not render when assignmentId is missing', () => {
    render(<ResubmitControl student={student()} assignmentId={undefined} defaultLessons={3} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Ask to resubmit/ })).not.toBeInTheDocument();
  });
});

describe('ResubmitControl — unsubmit on Ask (Phase 2)', () => {
  const LINE = 'Resubmission requested - due Thu 15/10.';
  const BOX = 'Unsubmit their OneDrive work in Schoology so they can edit it';
  const openAsk = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByDisplayValue(LINE);
    await screen.findByLabelText('Their comment will read');
  };

  it('no unsubmit option unless the card says it is available', async () => {
    renderControl(null, {}, { lti_submission_state: 'in_progress', unsubmit_available: false });
    await openAsk();
    expect(screen.queryByRole('checkbox', { name: BOX })).not.toBeInTheDocument();
    api.requestResubmission.mockResolvedValue({ id: 3, outcome: 'asked' });
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    await waitFor(() => expect(api.requestResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: '', commentLine: LINE }));
  });

  it('available: checked by default, sent with the ask; success closes and marks the work in progress', async () => {
    api.requestResubmission.mockResolvedValue({ id: 3, outcome: 'asked', unsubmit: { ok: true }, statusLine: { comment: `${LINE}\n\nGood start.`, line: LINE } });
    const onChange = renderControl(null, {}, { lti_submission_state: 'submitted', unsubmit_available: true });
    await openAsk();
    expect(screen.getByRole('checkbox', { name: BOX })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    await waitFor(() => expect(api.requestResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: '', commentLine: LINE, unsubmit: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onChange).toHaveBeenCalledWith(
      { state: 'waiting', request: { id: 3, outcome: 'asked' } },
      { comment: `${LINE}\n\nGood start.`, line: LINE, kind: 'ask' },
      { lti_submission_state: 'in_progress', unsubmit_available: false },
    );
  });

  it('a failed unsubmit: the ask is recorded (card updated), the modal stays open with the Schoology link', async () => {
    const url = 'https://schoology.hkis.edu.hk/assignments/a1/info';
    api.requestResubmission.mockResolvedValue({
      id: 3, outcome: 'asked', unsubmitError: 'Schoology connection expired — reconnect in Settings', unsubmitUrl: url,
      unsubmit: { ok: false, error: 'Schoology connection expired — reconnect in Settings', url },
    });
    const onChange = renderControl(null, {}, { lti_submission_state: 'submitted', unsubmit_available: true });
    await openAsk();
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'unsubmit it in Schoology ›' })).toHaveAttribute('href', url);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(
      { state: 'waiting', request: expect.objectContaining({ id: 3, unsubmitError: expect.any(String), unsubmitUrl: url }) },
      null,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('an open request whose unsubmit failed shows the note with the Schoology link on the card', () => {
    const url = 'https://schoology.hkis.edu.hk/assignments/a1/info';
    renderControl({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', unsubmitError: 'boom', unsubmitUrl: url } });
    const link = screen.getByRole('link', { name: 'unsubmit it in Schoology ›' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Unsubmit failed/)).toBeInTheDocument();
  });

  it('an unconfirmed unsubmit reads "not confirmed", not "failed"', () => {
    renderControl({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', unsubmitError: "Schoology didn't confirm the unsubmit — x", unsubmitUncertain: true, unsubmitUrl: 'https://s/a' } });
    expect(screen.getByText(/Unsubmit not confirmed/)).toBeInTheDocument();
    expect(screen.queryByText(/Unsubmit failed/)).not.toBeInTheDocument();
  });

  it('Undo / Grade stands on unsubmitted work say it stays unsubmitted (no re-submit)', async () => {
    renderControl(waiting('2026-10-08'), {}, { lti_submission_state: 'in_progress' });
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // Closed, not deleted (the server keeps the row so the next sync doesn't re-add it).
    expect(screen.getByText('Closes this request in Prism. Their work stays unsubmitted in Schoology.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Grade stands' }));
    expect(screen.getByText(/grade stands\. Their work stays unsubmitted in Schoology\./)).toBeInTheDocument();
  });
});
