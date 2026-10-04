import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import StatusLineModal from './StatusLineModal.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  previewStatusLine: vi.fn(),
  requestResubmission: vi.fn(), updateResubmission: vi.fn(), undoResubmission: vi.fn(),
  recordExtension: vi.fn(), undoExtension: vi.fn(),
  getMasteryLoginStatus: vi.fn(),
}));

const LINE = 'Resubmission deadline (Thu 08/10) passed - your grade stands.';
const preview = (over = {}) => ({
  currentComment: 'Great start.', visible: true, storedLine: null,
  resultingComment: `${LINE}\n\nGreat start.`, hiddenWarning: false, ...over,
});
const writeApis = ['requestResubmission', 'updateResubmission', 'undoResubmission', 'recordExtension', 'undoExtension'];

function renderModal(props = {}) {
  const onConfirm = props.onConfirm ?? vi.fn().mockResolvedValue({});
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <StatusLineModal
      studentName="Ravi Shah" studentId={12} assignmentId={30} title="Launch - Design"
      consequence="Ends the resubmission request: missed deadline, grade stands."
      defaultLine={LINE} confirmLabel="Publish & close request"
      {...props} onConfirm={onConfirm} onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}
const preview$ = () => screen.getByLabelText('Their comment will read');

beforeEach(() => {
  vi.clearAllMocks();
  api.previewStatusLine.mockResolvedValue(preview());
  api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected', checkedAt: '2026-10-03T06:05:00Z' });
});

describe('StatusLineModal', () => {
  it('shows the significance: header, visibility sub-line, consequence, editable line and the resulting comment', async () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: "Publish to Ravi Shah's Schoology comment" })).toBeInTheDocument();
    expect(screen.getByText('Visible to the student (and parents) as soon as you publish.')).toBeInTheDocument();
    expect(screen.getByText('Ends the resubmission request: missed deadline, grade stands.')).toBeInTheDocument();
    expect(screen.getByText('Launch - Design')).toBeInTheDocument();
    expect(screen.getByLabelText('Status line')).toHaveValue(LINE);
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    expect(api.previewStatusLine).toHaveBeenCalledWith({ studentId: 12, assignmentId: 30, line: LINE });
    // The new line is highlighted at the top of the full resulting comment.
    const mark = preview$().querySelector('mark');
    expect(mark).toHaveTextContent(LINE);
    expect(mark).toHaveClass('status-line-modal__new');
    expect(preview$().textContent).toBe(`${LINE}\n\nGreat start.`);
    expect(screen.getByRole('button', { name: 'Publish & close request' })).toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('ghost');
    expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
  });

  it('replaces only Prism\'s stored line, exactly (the preview composes like the server)', async () => {
    api.previewStatusLine.mockResolvedValue(preview({ currentComment: 'OLD LINE\r\n\r\nGreat start.', storedLine: 'OLD LINE' }));
    renderModal();
    await waitFor(() => expect(preview$().textContent).toBe(`${LINE}\n\nGreat start.`));
  });

  it('warns when the comment is hidden: publishing shows it to the student', async () => {
    api.previewStatusLine.mockResolvedValue(preview({ visible: false, hiddenWarning: true, currentComment: 'Private: check plagiarism.' }));
    renderModal();
    const warning = await screen.findByText(/hidden comment/i);
    expect(warning.closest('.alert')).toHaveClass('alert-warning');
    expect(preview$()).toHaveTextContent('Private: check plagiarism.');
  });

  it('edits flow to the preview and to onConfirm (trimmed, one line)', async () => {
    const { onConfirm } = renderModal();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.change(screen.getByLabelText('Status line'), { target: { value: '  Edited line\nwith a break ' } });
    expect(screen.getByLabelText('Status line')).toHaveValue('  Edited line with a break ');
    expect(preview$().querySelector('mark')).toHaveTextContent('Edited line with a break');
    fireEvent.click(screen.getByRole('button', { name: 'Publish & close request' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Edited line with a break'));
  });

  it('typographic characters are shown and sent as their plain ASCII forms (same as the server)', async () => {
    const { onConfirm } = renderModal();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.change(screen.getByLabelText('Status line'), { target: { value: 'Due Fri \u2014 \u201Cbring it\u201D\u2026' } });
    expect(preview$().querySelector('mark')).toHaveTextContent('Due Fri - "bring it"...');
    fireEvent.click(screen.getByRole('button', { name: 'Publish & close request' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Due Fri - "bring it"...'));
  });

  it('other non-ASCII characters block publishing with a hint', async () => {
    const { onConfirm } = renderModal();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.change(screen.getByLabelText('Status line'), { target: { value: '\u27F3 Bien jou\u00E9' } });
    expect(screen.getByText('Use plain characters in the status line')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish & close request' });
    expect(publish).toBeDisabled();
    fireEvent.click(publish);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('an empty line cannot be published', async () => {
    renderModal();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.change(screen.getByLabelText('Status line'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Publish & close request' })).toBeDisabled();
  });

  it('Cancel, Escape and a backdrop press close without calling any write API', async () => {
    const { onCancel, onConfirm } = renderModal();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByLabelText('Status line')); // inside: not a dismiss
    fireEvent.mouseDown(document.querySelector('.status-line-modal__overlay')); // the backdrop
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    for (const fn of writeApis) expect(api[fn]).not.toHaveBeenCalled();
  });

  it('busy while publishing, then shows the server error and stays open', async () => {
    let reject;
    const onConfirm = vi.fn(() => new Promise((_, r) => { reject = r; }));
    const { onCancel } = renderModal({ onConfirm });
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish & close request' }));
    expect(await screen.findByRole('button', { name: 'Publishing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    reject(Object.assign(new Error("Couldn't read the grade from Schoology: nothing was published"), { code: 'SCHOOLOGY_READ_FAILED' }));
    expect(await screen.findByText("Couldn't read the grade from Schoology: nothing was published")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish & close request' })).not.toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a record failure after publishing says plainly that the comment WAS published', async () => {
    const onConfirm = vi.fn().mockRejectedValue(Object.assign(new Error('The comment WAS published to the student\'s Schoology comment, but Prism could not record the action (db locked).'), {
      code: 'RECORD_FAILED_AFTER_PUBLISH', published: true,
    }));
    const { onCancel } = renderModal({ onConfirm });
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish & close request' }));
    const err = await screen.findByText(/Prism could not record the action/);
    expect(err.closest('.alert')).toHaveClass('alert-error');
    expect(screen.getByText('Published to Schoology: not recorded in Prism')).toBeInTheDocument();
    // Retrying would publish again: only Close is offered.
    expect(screen.queryByRole('button', { name: 'Publish & close request' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('a failed preview read blocks publishing and offers Retry', async () => {
    api.previewStatusLine.mockRejectedValueOnce(new Error('Schoology read failed'));
    renderModal();
    expect(await screen.findByText(/Schoology read failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish & close request' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    expect(screen.getByRole('button', { name: 'Publish & close request' })).not.toBeDisabled();
  });

  it('loadDefaultLine: the line is worked out first (e.g. the due date), then pre-filled', async () => {
    const loadDefaultLine = vi.fn().mockResolvedValue('Resubmission requested - due Thu 08/10.');
    renderModal({ defaultLine: undefined, loadDefaultLine });
    expect(await screen.findByDisplayValue('Resubmission requested - due Thu 08/10.')).toBeInTheDocument();
    await waitFor(() => expect(preview$().querySelector('mark')).toHaveTextContent('Resubmission requested - due Thu 08/10.'));
  });

  it('loadDefaultLine failing (e.g. ALREADY_OPEN) shows the error and blocks publishing', async () => {
    renderModal({ defaultLine: undefined, loadDefaultLine: vi.fn().mockRejectedValue(new Error('That student already has an open resubmission request')) });
    expect(await screen.findByText(/already has an open resubmission request/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish & close request' })).toBeDisabled();
  });

  describe('removeMode (Undo)', () => {
    beforeEach(() => {
      api.previewStatusLine.mockResolvedValue(preview({ currentComment: `${LINE}\n\nGreat start.`, storedLine: LINE }));
    });

    it('offers to remove Prism\'s line (default on) and previews the comment without it', async () => {
      const { onConfirm } = renderModal({ removeMode: true, confirmLabel: 'Undo', consequence: 'Deletes the grade-stands record in Prism.' });
      expect(screen.queryByLabelText('Status line')).not.toBeInTheDocument();
      const box = screen.getByRole('checkbox', { name: "Remove Prism's line from their comment" });
      expect(box).toBeChecked();
      await waitFor(() => expect(preview$().textContent).toBe('Great start.'));
      expect(api.previewStatusLine).toHaveBeenCalledWith({ studentId: 12, assignmentId: 30, line: '' });
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true));
    });

    it('unchecked: the comment stays as it is and onConfirm(false)', async () => {
      const { onConfirm } = renderModal({ removeMode: true, confirmLabel: 'Undo' });
      await waitFor(() => expect(preview$().textContent).toBe('Great start.'));
      fireEvent.click(screen.getByRole('checkbox', { name: "Remove Prism's line from their comment" }));
      expect(preview$().textContent).toBe(`${LINE}\n\nGreat start.`);
      expect(screen.getByText(/Nothing in Schoology changes/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false));
    });

    it('checked: the sub-line says their comment changes (removal keeps Display as it is)', async () => {
      renderModal({ removeMode: true, confirmLabel: 'Undo' });
      expect(await screen.findByText('Changes their Schoology comment.')).toBeInTheDocument();
      expect(screen.queryByText(/as soon as you publish/)).not.toBeInTheDocument();
    });

    it("the stored line belongs to a different action: it says it will stay, and the preview keeps it", async () => {
      api.previewStatusLine.mockResolvedValue(preview({
        currentComment: `${LINE}\n\nGreat start.`, storedLine: LINE, storedSource: { sourceType: 'resubmission', sourceId: 99 },
      }));
      renderModal({ removeMode: true, confirmLabel: 'Undo', undoSource: { sourceType: 'resubmission', sourceId: 3 } });
      expect(await screen.findByText("Prism's current line belongs to a different action. It will stay.")).toBeInTheDocument();
      expect(preview$().textContent).toBe(`${LINE}\n\nGreat start.`);
    });

    it('the stored line is this action\'s own: previewed without it, no "different action" note', async () => {
      api.previewStatusLine.mockResolvedValue(preview({
        currentComment: `${LINE}\n\nGreat start.`, storedLine: LINE, storedSource: { sourceType: 'resubmission', sourceId: 3 },
      }));
      renderModal({ removeMode: true, confirmLabel: 'Undo', undoSource: { sourceType: 'resubmission', sourceId: 3 } });
      await waitFor(() => expect(preview$().textContent).toBe('Great start.'));
      expect(screen.queryByText(/different action/)).not.toBeInTheDocument();
    });

    it('says so when Prism\'s line is no longer in the comment', async () => {
      api.previewStatusLine.mockResolvedValue(preview({ currentComment: 'Teacher rewrote it.', storedLine: LINE }));
      renderModal({ removeMode: true, confirmLabel: 'Undo' });
      expect(await screen.findByText(/line isn.t in their comment/)).toBeInTheDocument();
    });
  });
});

describe('StatusLineModal — focus, alerts, guards', () => {
  // A page button opens the modal; closing it should hand focus back to that button.
  function Harness({ removeMode = false, onConfirm = vi.fn().mockResolvedValue({}) }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open confirm</button>
        <button type="button">Background action</button>
        {open && (
          <StatusLineModal
            studentName="Ravi Shah" studentId={12} assignmentId={30} defaultLine={LINE}
            confirmLabel="Publish & close request" removeMode={removeMode}
            onConfirm={onConfirm} onCancel={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  const openFrom = () => {
    const opener = screen.getByRole('button', { name: 'Open confirm' });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  };

  it('focus moves to the line on open (never the primary button) and returns to the opener on close', async () => {
    render(<Harness />);
    const opener = openFrom();
    expect(screen.getByLabelText('Status line')).toHaveFocus();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    expect(screen.getByRole('button', { name: 'Publish & close request' })).not.toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('removeMode focuses the dialog itself', async () => {
    api.previewStatusLine.mockResolvedValue(preview({ currentComment: `${LINE}\n\nGreat start.`, storedLine: LINE }));
    render(<Harness removeMode />);
    openFrom();
    expect(screen.getByRole('dialog')).toHaveFocus();
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
  });

  it('Tab wraps inside the dialog at both ends; the background is never reached', async () => {
    render(<Harness />);
    openFrom();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish & close request' })).not.toBeDisabled());
    const line = screen.getByLabelText('Status line');
    const primary = screen.getByRole('button', { name: 'Publish & close request' });
    primary.focus();
    fireEvent.keyDown(primary, { key: 'Tab' });
    expect(line).toHaveFocus(); // last → first
    fireEvent.keyDown(line, { key: 'Tab', shiftKey: true });
    expect(primary).toHaveFocus(); // first → last
    expect(screen.getByRole('button', { name: 'Background action' })).not.toHaveFocus();
  });

  it('a double click publishes once (in-flight guard)', async () => {
    let resolve;
    const onConfirm = vi.fn(() => new Promise((r) => { resolve = r; }));
    renderModal({ onConfirm });
    await waitFor(() => expect(preview$()).toHaveTextContent('Great start.'));
    const primary = screen.getByRole('button', { name: 'Publish & close request' });
    fireEvent.click(primary);
    fireEvent.click(primary);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    resolve({});
  });

  it('errors and load warnings are announced (role=alert); the preview is a labelled region', async () => {
    api.previewStatusLine.mockRejectedValueOnce(new Error('Schoology read failed'));
    renderModal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Schoology read failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Their comment will read' })).toBeInTheDocument();
  });

  it('"Re-read from Schoology" next to the hidden warning fetches the comment again', async () => {
    api.previewStatusLine.mockResolvedValueOnce(preview({ visible: false, hiddenWarning: true, currentComment: 'Private note.' }));
    api.previewStatusLine.mockResolvedValueOnce(preview({ currentComment: 'Fixed in Schoology.' }));
    renderModal();
    const warning = await screen.findByText(/hidden comment/i);
    fireEvent.click(within(warning.closest('.alert')).getByRole('button', { name: 'Re-read from Schoology' }));
    await waitFor(() => expect(preview$()).toHaveTextContent('Fixed in Schoology.'));
    expect(api.previewStatusLine).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/hidden comment/i)).not.toBeInTheDocument();
  });
});

describe('StatusLineModal — unsubmit on Ask (Phase 2)', () => {
  const ASK = 'Resubmission requested - due Thu 09/10.';
  const askModal = (props = {}) => renderModal({
    defaultLine: ASK, consequence: 'Asks Ravi Shah to resubmit within 3 lessons.', confirmLabel: 'Publish & ask', ...props,
  });
  const box = () => screen.getByRole('checkbox', { name: 'Unsubmit their OneDrive work in Schoology so they can edit it' });

  it('no checkbox (and no session check) unless the work is offered for unsubmit', async () => {
    askModal();
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(api.getMasteryLoginStatus).not.toHaveBeenCalled();
  });

  it('offered: checked by default, the consequence says so, onConfirm gets { unsubmit: true }, busy text', async () => {
    let resolve;
    const onConfirm = vi.fn(() => new Promise((r) => { resolve = r; }));
    askModal({ offerUnsubmit: true, onConfirm });
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    await waitFor(() => expect(api.getMasteryLoginStatus).toHaveBeenCalled());
    expect(box()).toBeChecked();
    expect(screen.getByText(/Unsubmits their OneDrive work in Schoology so they can edit it\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    expect(onConfirm).toHaveBeenCalledWith(ASK, { unsubmit: true });
    expect(screen.getByRole('button', { name: 'Publishing and unsubmitting…' })).toBeDisabled();
    resolve({ unsubmit: { ok: true } });
  });

  it('unchecked: the consequence drops it and onConfirm gets { unsubmit: false }', async () => {
    const { onConfirm } = askModal({ offerUnsubmit: true });
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    fireEvent.click(box());
    expect(box()).not.toBeChecked();
    expect(screen.queryByText(/Unsubmits their OneDrive work/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    expect(onConfirm).toHaveBeenCalledWith(ASK, { unsubmit: false });
  });

  it('an expired Schoology connection disables it, with a link to Settings', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired', checkedAt: null });
    const { onConfirm } = askModal({ offerUnsubmit: true });
    const link = await screen.findByRole('link', { name: 'Schoology connection expired: reconnect in Settings ›' });
    expect(link).toHaveAttribute('href', '/settings#schoology');
    expect(box()).toBeDisabled();
    expect(box()).not.toBeChecked();
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    expect(onConfirm).toHaveBeenCalledWith(ASK, { unsubmit: false });
  });

  it('no saved session: disabled with a set-up link', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: false, live: 'none', checkedAt: null });
    askModal({ offerUnsubmit: true });
    expect(await screen.findByRole('link', { name: /connect in Settings/ })).toHaveAttribute('href', '/settings#schoology');
    expect(box()).toBeDisabled();
  });

  it('a failed unsubmit keeps the modal open: warning + a link to Schoology (new tab) + Close', async () => {
    const url = 'https://schoology.hkis.edu.hk/assignments/8000000001/info';
    const onConfirm = vi.fn().mockResolvedValue({ outcome: 'asked', unsubmit: { ok: false, error: 'Schoology refused the unsubmit (HTTP 403)', url } });
    const { onCancel } = askModal({ offerUnsubmit: true, onConfirm });
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Schoology refused the unsubmit (HTTP 403)');
    expect(alert).toHaveTextContent('Unsubmit failed');
    const link = within(alert).getByRole('link', { name: 'unsubmit it in Schoology ›' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(screen.queryByRole('button', { name: 'Publish & ask' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('an UNCONFIRMED unsubmit says their work MAY still be submitted (not "still submitted")', async () => {
    const url = 'https://schoology.hkis.edu.hk/assignments/8000000001/info';
    const onConfirm = vi.fn().mockResolvedValue({
      outcome: 'asked', unsubmit: { ok: false, uncertain: true, error: "Schoology didn't confirm the unsubmit: no answer (TimeoutError)", url },
    });
    askModal({ offerUnsubmit: true, onConfirm });
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Publish & ask' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Schoology didn't confirm the unsubmit. Their work may still be submitted.");
    expect(alert).not.toHaveTextContent('is still submitted');
    expect(within(alert).getByRole('link', { name: 'Unsubmit it in Schoology ›' })).toHaveAttribute('href', url);
  });

  it("an 'unknown' connection (the check couldn't tell) does not disable the checkbox", async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'unknown', checkedAt: '2026-10-03T06:05:00Z', message: 'Could not reach Schoology' });
    askModal({ offerUnsubmit: true });
    await waitFor(() => expect(api.getMasteryLoginStatus).toHaveBeenCalled());
    await waitFor(() => expect(preview$()).toBeInTheDocument());
    expect(box()).toBeEnabled();
    expect(box()).toBeChecked();
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
  });
});
