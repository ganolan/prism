import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import FlagsMenu from './FlagsMenu.jsx';
import * as api from '../services/api.js';
import { FLAGS_MENU_HEADING, flagGuide } from '../lib/flags.js';

vi.mock('../services/api.js', () => ({ getGradeFlags: vi.fn(), setGradeFlag: vi.fn() }));

const STUDENT = { id: 7, firstName: 'Sam' };
const NOTE = 'On graded work, Schoology removes the grade while a flag is set. Prism keeps a copy and offers to restore it when you clear the flag.';
// What the panels read fresh from Schoology (readFlagState).
const state = (over = {}) => ({
  exception: 0, score: 75, comment: 'Good work.', commentStatus: 1, graded: true,
  gradeText: '75 / 100 and 2 topic levels', savedGrade: null, openRecords: [], hasDraft: false, ...over,
});
const RESULT = { exception: 6, saved: true, withdrawn: [], line: null, restored: null };

function renderMenu(props = {}) {
  const onChange = vi.fn();
  render(<FlagsMenu student={STUDENT} assignmentId={30} exception={0} score={75} aligned onChange={onChange} {...props} />);
  return { onChange };
}
const pill = () => screen.getByRole('button', { name: /Flags|Exempt|Late|Absent|Incomplete|Missing/ });
const openMenu = () => fireEvent.click(pill());
async function choose(name) {
  openMenu();
  fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(api.getGradeFlags).toHaveBeenCalledWith(7, 30));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Tue 20/10/2026: the status line's date (only Date is faked, so promises and waitFor run as usual).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00'));
  api.getGradeFlags.mockResolvedValue(state());
  api.setGradeFlag.mockResolvedValue(RESULT);
});
afterEach(() => { vi.useRealTimers(); });

describe('FlagsMenu: the closed pill', () => {
  it('no flag: "Flags", no flag color', () => {
    renderMenu();
    expect(pill()).toHaveTextContent('Flags');
    expect(pill()).toHaveClass('flags-pill');
    expect(pill().className).not.toMatch(/flags-pill--(exempt|late|absent|incomplete|missing)/);
    expect(pill()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it.each([[1, 'Exempt', 'exempt'], [6, 'Late', 'late'], [5, 'Absent', 'absent'], [2, 'Incomplete', 'incomplete'], [3, 'Missing', 'missing']])(
    'exception %i: the %s symbol and name, in its color (flags-pill--%s)', (exception, name, key) => {
      renderMenu({ exception });
      expect(pill()).toHaveTextContent(name);
      expect(pill()).toHaveClass(`flags-pill--${key}`);
      expect(pill().querySelector(`.flag-symbol--${key}`)).not.toBeNull();
    });

  it('size sm is the smaller pill (the shared view\'s badge row)', () => {
    renderMenu({ size: 'sm' });
    expect(pill()).toHaveClass('flags-pill--sm');
  });
});

describe('FlagsMenu: the open menu', () => {
  it('the subheading, then the five flags in order with their lines verbatim, then the divider note', () => {
    renderMenu();
    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText(FLAGS_MENU_HEADING)).toBeInTheDocument();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.querySelector('.flags-menu__name').textContent)).toEqual(['Exempt', 'Late', 'Absent', 'Incomplete', 'Missing']);
    expect(items[0]).toHaveTextContent("Left out of Sam's grade.");
    expect(items[1]).toHaveTextContent("Left out of Sam's grade while flagged.");
    expect(items[2]).toHaveTextContent("Absent for this task. Left out of Sam's grade.");
    expect(items[3]).toHaveTextContent('No grade while flagged.');
    expect(items[4]).toHaveTextContent('Scores this task as zero. Topic levels already entered still count.');
    [1, 6, 5, 2, 3].forEach((code, i) => expect(items[i]).toHaveTextContent(flagGuide(code, 'Sam', { aligned: true })));
    expect(within(menu).getByText(NOTE)).toBeInTheDocument();
    items.forEach((i) => expect(i).toHaveAttribute('aria-checked', 'false'));
  });

  it('a task with no topics: Missing\'s short line', () => {
    renderMenu({ aligned: false });
    openMenu();
    expect(screen.getByRole('menuitemradio', { name: /^Missing/ })).toHaveTextContent(/Scores this task as zero\.$/);
  });

  it('the set flag is ticked, and its line reads "Choose again to clear it."', () => {
    renderMenu({ exception: 6 });
    openMenu();
    const late = screen.getByRole('menuitemradio', { name: /^Late/ });
    expect(late).toHaveAttribute('aria-checked', 'true');
    expect(late).toHaveTextContent('Choose again to clear it.');
    expect(late).not.toHaveTextContent("Left out of Sam's grade while flagged.");
    expect(screen.getByRole('menuitemradio', { name: /^Exempt/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('keyboard: focus starts on the first flag, ArrowDown moves through the five, Enter chooses', async () => {
    renderMenu();
    openMenu();
    const items = screen.getAllByRole('menuitemradio');
    expect(items[0]).toHaveFocus();
    for (let i = 1; i < 5; i += 1) {
      fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
      expect(items[i]).toHaveFocus();
    }
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus(); // wraps
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(items[4]).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement, { key: 'Enter' }); // Incomplete
    await waitFor(() => expect(api.getGradeFlags).toHaveBeenCalledWith(7, 30));
    expect(await screen.findByText('Mark Sam incomplete?')).toBeInTheDocument();
  });

  it('keyboard: Escape closes the menu and gives focus back to the pill', () => {
    renderMenu();
    openMenu();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(pill()).toHaveFocus();
  });

  it('a click outside closes the menu', () => {
    renderMenu();
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// Found live on prod (#40): focusing the first item on open scrolled the document, and the "a scroll
// closes it" listener took that scroll as a reason to close, so the menu vanished ~16 ms after it
// opened. jsdom never scrolls, so these tests dispatch the scroll themselves.
describe('FlagsMenu: focus and scroll do not close the menu it just opened', () => {
  // Moves the pill: what a real scroll of the page does to its rectangle.
  function mockPillRect(rect) {
    const el = pill();
    el.getBoundingClientRect = () => ({ top: rect.top, left: rect.left, bottom: rect.top + 24, right: rect.left + 80, width: 80, height: 24 });
    return el;
  }

  it('focusing an item on open uses preventScroll, so the page does not scroll', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      renderMenu();
      openMenu();
      const first = screen.getAllByRole('menuitemradio')[0];
      expect(first).toHaveFocus();
      const call = focus.mock.calls.find((_args, i) => focus.mock.contexts[i] === first);
      expect(call?.[0]).toEqual({ preventScroll: true });
    } finally { focus.mockRestore(); }
  });

  it('arrow keys move focus with preventScroll too', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      renderMenu();
      openMenu();
      const items = screen.getAllByRole('menuitemradio');
      focus.mockClear();
      fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
      expect(items[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally { focus.mockRestore(); }
  });

  it('a scroll in the first moments after opening keeps it open (the scroll focus caused)', () => {
    renderMenu();
    mockPillRect({ top: 100, left: 50 });
    openMenu();
    mockPillRect({ top: 20, left: 50 }); // even if the pill did move
    vi.setSystemTime(Date.now() + 16);
    fireEvent.scroll(document);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('after the guard time, a scroll that moves the pill closes it', () => {
    renderMenu();
    mockPillRect({ top: 100, left: 50 });
    openMenu();
    vi.setSystemTime(Date.now() + 500);
    mockPillRect({ top: 60, left: 50 });
    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('after the guard time, a scroll that sideways-moves the pill closes it', () => {
    renderMenu();
    mockPillRect({ top: 100, left: 50 });
    openMenu();
    vi.setSystemTime(Date.now() + 500);
    mockPillRect({ top: 100, left: 40 });
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('after the guard time, a scroll that leaves the pill where it was keeps it open', () => {
    renderMenu();
    mockPillRect({ top: 100, left: 50 });
    openMenu();
    vi.setSystemTime(Date.now() + 500);
    mockPillRect({ top: 101, left: 49 }); // within 2 px
    fireEvent.scroll(document);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a scroll inside the menu never closes it', () => {
    renderMenu();
    mockPillRect({ top: 100, left: 50 });
    openMenu();
    vi.setSystemTime(Date.now() + 500);
    mockPillRect({ top: 0, left: 50 });
    fireEvent.scroll(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('FlagsMenu: the panel for setting a flag', () => {
  it('reads Schoology fresh, then: the title, the reason with its preview, the saved-grade note, next steps, buttons', async () => {
    const { onChange } = renderMenu();
    await choose('Late');
    const panel = await screen.findByRole('group', { name: 'Mark Sam late?' });
    expect(within(panel).getByText('Mark Sam late?')).toBeInTheDocument();
    const reason = within(panel).getByLabelText('Reason for the student (optional)');
    expect(within(panel).queryByText(/Added to the top/)).toBeNull(); // no line without a reason
    fireEvent.change(reason, { target: { value: 'Handed in after the deadline.' } });
    expect(within(panel).getByText(`Added to the top of Sam's comment: "Marked late on Tue 20/10. Handed in after the deadline."`)).toBeInTheDocument();
    expect(within(panel).getByText('Schoology removes this grade while the flag is set. Prism keeps a copy: 75 / 100 and 2 topic levels. Your comment stays.')).toBeInTheDocument();
    expect(within(panel).getByText('Grading the work clears Late, and the grade then counts. If the work is too late to count, mark it Missing instead.')).toBeInTheDocument();
    expect(within(panel).queryByText(/Also withdraws/)).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark late' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith({
      studentId: 7, assignmentId: 30, code: 6, expected: { exception: 0, score: 75 }, reason: 'Handed in after the deadline.',
    }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(RESULT));
    expect(screen.queryByRole('group', { name: 'Mark Sam late?' })).toBeNull();
  });

  // A reason publishes a status line, and publishing turns Display on (#40 review I3): a hidden
  // teacher comment would become visible, so the panel warns as Extend and Resubmit do.
  const HIDDEN = /Their comment is hidden from the student\. Publishing turns Display on, so your current hidden comment becomes visible to the student and parents\./;
  it('a reason over a hidden teacher comment: the hidden-comment warning', async () => {
    api.getGradeFlags.mockResolvedValueOnce(state({ commentStatus: 0, comment: 'Private: check plagiarism.' }));
    renderMenu();
    await choose('Late');
    const panel = await screen.findByRole('group', { name: 'Mark Sam late?' });
    expect(within(panel).queryByText(HIDDEN)).toBeNull(); // no reason, no line, Display unchanged
    fireEvent.change(within(panel).getByLabelText('Reason for the student (optional)'), { target: { value: 'Late.' } });
    expect(within(panel).getByRole('alert')).toHaveTextContent(HIDDEN);
  });

  it.each([
    ['Display on', { commentStatus: 1, comment: 'Private: check plagiarism.' }],
    ['an empty comment', { commentStatus: 0, comment: '' }],
    ['only Prism\'s own line', { commentStatus: 0, comment: 'Extension - now due Fri 23/10 (3 school days).', storedLine: 'Extension - now due Fri 23/10 (3 school days).' }],
  ])('no warning with %s', async (_label, over) => {
    api.getGradeFlags.mockResolvedValueOnce(state(over));
    renderMenu();
    await choose('Late');
    const panel = await screen.findByRole('group', { name: 'Mark Sam late?' });
    fireEvent.change(within(panel).getByLabelText('Reason for the student (optional)'), { target: { value: 'Late.' } });
    expect(within(panel).queryByText(HIDDEN)).toBeNull();
  });

  it('no reason: reason null', async () => {
    renderMenu();
    await choose('Absent');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark absent' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith(expect.objectContaining({ code: 5, reason: null })));
  });

  it('Exempt lists the records it withdraws, and has no next-steps line', async () => {
    api.getGradeFlags.mockResolvedValue(state({ openRecords: [{ type: 'extension', id: 4, label: 'Extension to Fri 24/10/2026' }] }));
    renderMenu();
    await choose('Exempt');
    const panel = await screen.findByRole('group', { name: 'Mark Sam exempt?' });
    expect(within(panel).getByText('Also withdraws: Extension to Fri 24/10/2026')).toBeInTheDocument();
    expect(within(panel).queryByText(/Extend|Grading the work/)).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Mark exempt' })).toBeInTheDocument();
  });

  it.each(['Late', 'Absent', 'Incomplete', 'Missing'])('%s withdraws nothing, so lists nothing', async (name) => {
    api.getGradeFlags.mockResolvedValue(state({ openRecords: [{ type: 'extension', id: 4, label: 'Extension to Fri 24/10/2026' }] }));
    renderMenu();
    await choose(name);
    await screen.findByRole('group', { name: `Mark Sam ${name.toLowerCase()}?` });
    expect(screen.queryByText(/Also withdraws/)).toBeNull();
  });

  it('the markers\' next steps, verbatim', async () => {
    renderMenu();
    await choose('Incomplete');
    expect(await screen.findByText('Set a date to finish with Extend. Grading the work clears Incomplete.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    api.getGradeFlags.mockClear();
    await choose('Absent');
    expect(await screen.findByText('If Sam will make this up, set a date with Extend. If Sam will not do this task, mark Exempt instead.')).toBeInTheDocument();
  });

  it('Missing: the 0 wording for the saved grade, no next-steps line', async () => {
    renderMenu();
    await choose('Missing');
    const panel = await screen.findByRole('group', { name: 'Mark Sam missing?' });
    expect(within(panel).getByText('Schoology sets this grade to 0 while the flag is set. Prism keeps a copy: 75 / 100 and 2 topic levels. Your comment stays.')).toBeInTheDocument();
    expect(within(panel).queryByText(/Extend|Grading the work/)).toBeNull();
  });

  it('ungraded work: no saved-grade note', async () => {
    api.getGradeFlags.mockResolvedValue(state({ score: null, graded: false, gradeText: null }));
    renderMenu({ score: null });
    await choose('Exempt');
    await screen.findByRole('group', { name: 'Mark Sam exempt?' });
    expect(screen.queryByText(/Prism keeps a copy/)).toBeNull();
  });

  it('a flag replacing a flag opens the same panel', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 6, score: null, graded: false, gradeText: null }));
    renderMenu({ exception: 6, score: null });
    await choose('Exempt');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark exempt' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith(expect.objectContaining({ code: 1, expected: { exception: 6, score: null } })));
  });

  it('no first name: "the student"', async () => {
    render(<FlagsMenu student={{ id: 7, firstName: null }} assignmentId={30} exception={0} score={75} />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Exempt/ }));
    expect(await screen.findByText('Mark the student exempt?')).toBeInTheDocument();
  });

  it('Cancel closes the panel and writes nothing', async () => {
    renderMenu();
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(api.setGradeFlag).not.toHaveBeenCalled();
  });

  it('renders into panelHost when one is given', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      renderMenu({ panelHost: host });
      await choose('Late');
      await waitFor(() => expect(within(host).getByText('Mark Sam late?')).toBeInTheDocument());
    } finally { host.remove(); }
  });
});

describe('FlagsMenu: clearing', () => {
  const SAVED = { flag: 1, savedAt: '2026-10-20 02:00:00', summary: '90 / 100 and 2 topic levels', restoreSummary: '2 topic levels', notRestored: ['90'] };

  it('the ticked flag with a saved copy: the clear panel, box ticked, the parts to re-enter, "Clear Exempt"', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 1, score: null, graded: false, gradeText: null, savedGrade: SAVED }));
    api.setGradeFlag.mockResolvedValue({ exception: 0, saved: false, withdrawn: [], line: null, restored: { draft: true, notRestored: ['90'] } });
    const { onChange } = renderMenu({ exception: 1, score: null });
    await choose('Exempt');
    const panel = await screen.findByRole('group', { name: 'Clear Exempt?' });
    const box = within(panel).getByRole('checkbox', { name: 'Restore the saved grade as a draft: 2 topic levels' });
    expect(box).toBeChecked();
    expect(within(panel).queryByText(/replaces your current draft/)).toBeNull();
    expect(within(panel).getByText('Re-enter in Schoology: 90')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear Exempt' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith({
      studentId: 7, assignmentId: 30, code: 0, expected: { exception: 1, score: null }, reason: null, restore: true,
    }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('"(replaces your current draft)" when a draft exists; unticked sends restore: false', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 1, score: null, graded: false, savedGrade: { ...SAVED, notRestored: [] }, hasDraft: true }));
    renderMenu({ exception: 1, score: null });
    await choose('Exempt');
    const box = await screen.findByRole('checkbox', { name: 'Restore the saved grade as a draft: 2 topic levels (replaces your current draft)' });
    expect(screen.queryByText(/Re-enter in Schoology/)).toBeNull();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Exempt' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith(expect.objectContaining({ code: 0, restore: false })));
  });

  it('the ticked flag without a copy clears at once (no panel)', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 6, score: null, graded: false, gradeText: null }));
    api.setGradeFlag.mockResolvedValue({ exception: 0, saved: false, withdrawn: [], line: null, restored: null });
    const { onChange } = renderMenu({ exception: 6, score: null });
    await choose('Late');
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith({
      studentId: 7, assignmentId: 30, code: 0, expected: { exception: 6, score: null }, reason: null, restore: false,
    }));
    expect(screen.queryByRole('group')).toBeNull();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ exception: 0 })));
  });
});

describe('FlagsMenu: clearing never replaces a draft unannounced (#40 review I1a)', () => {
  it('clearing Missing with no waiting copy posts restore: false (a copy kept now is offered on the card instead)', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 3, score: 0, graded: false, gradeText: null }));
    api.setGradeFlag.mockResolvedValue({ exception: 0, saved: true, withdrawn: [], line: null, restored: null });
    renderMenu({ exception: 3, score: 0 });
    await choose('Missing');
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith({
      studentId: 7, assignmentId: 30, code: 0, expected: { exception: 3, score: 0 }, reason: null, restore: false,
    }));
  });
});

describe('FlagsMenu: the comment the teacher saw (#40 review M1)', () => {
  it('expected carries the page\'s comment when one is given', async () => {
    renderMenu({ comment: 'Good work.' });
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalledWith(expect.objectContaining({
      expected: { exception: 0, score: 75, comment: 'Good work.' },
    })));
  });
});

describe('FlagsMenu: refetching after a write (#40 review M3)', () => {
  it('a read-back mismatch (after the Schoology write) still refetches the pair, and keeps its message', async () => {
    api.setGradeFlag.mockRejectedValue(Object.assign(new Error('Schoology answered, but its record shows no flag, not Late.'), { code: 'READBACK_MISMATCH' }));
    const { onChange } = renderMenu();
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(screen.getByRole('alert')).toHaveTextContent('its record shows no flag');
  });

  it('a refusal before any write (CHANGED) does not refetch', async () => {
    api.setGradeFlag.mockRejectedValue(Object.assign(new Error('Changed.'), { code: 'CHANGED' }));
    const { onChange } = renderMenu();
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    await screen.findByRole('alert');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a failed refetch says so', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('offline'));
    render(<FlagsMenu student={STUDENT} assignmentId={30} exception={0} score={75} onChange={onChange} />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Late/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved, but the page could not refresh. Reload to see it.');
  });
});

describe('FlagsMenu: the card\'s queued draft save goes first (#40 review)', () => {
  it('beforeWrite is awaited before the flag write', async () => {
    let settled = false;
    const beforeWrite = vi.fn(() => new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 0)));
    api.setGradeFlag.mockImplementationOnce(async () => { expect(settled).toBe(true); return RESULT; });
    renderMenu({ beforeWrite });
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalled());
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(api.setGradeFlag.mock.invocationCallOrder[0]);
  });
});

describe('FlagsMenu: pending and failures', () => {
  it('while a read or write is pending the pill is disabled', async () => {
    let resolve;
    api.getGradeFlags.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Late/ }));
    await waitFor(() => expect(pill()).toBeDisabled());
    resolve(state());
    await screen.findByRole('group', { name: 'Mark Sam late?' });
    expect(pill()).not.toBeDisabled();
  });

  it('a CHANGED refusal shows its message beside the pill and keeps the old state', async () => {
    api.setGradeFlag.mockRejectedValue(Object.assign(new Error('Changed in Schoology since Prism last read this task: the score (now 50). Nothing was written. Sync, then try again.'), { code: 'CHANGED' }));
    const { onChange } = renderMenu();
    await choose('Late');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark late' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed in Schoology since Prism last read this task: the score (now 50). Nothing was written. Sync, then try again.');
    expect(onChange).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent('Flags');
    expect(pill().className).not.toMatch(/flags-pill--late/);
  });

  it('a failed fresh read shows its message and opens no panel', async () => {
    api.getGradeFlags.mockRejectedValue(new Error('Schoology did not answer'));
    renderMenu();
    await choose('Exempt');
    expect(await screen.findByRole('alert')).toHaveTextContent('Schoology did not answer');
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('Schoology changed since the page loaded: says so before any panel, writes nothing', async () => {
    api.getGradeFlags.mockResolvedValue(state({ exception: 1, score: null }));
    renderMenu();
    await choose('Late');
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed in Schoology since Prism last read this task. Sync, then try again.');
    expect(screen.queryByRole('group')).toBeNull();
    expect(api.setGradeFlag).not.toHaveBeenCalled();
  });
});
