import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EmailMenu, { MailLink } from './EmailMenu.jsx';

const ROWS = [
  { studentId: 1, studentName: 'Ada L', studentEmail: 'a@example.test', tone: 'red', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' },
  { studentId: 2, studentName: 'Bo M', studentEmail: 'B@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 10, title: 'Unit 2 quiz' },
  { studentId: 3, studentName: 'Cy N', studentEmail: null, tone: 'green', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' },
  { studentId: 4, studentName: 'Di O', studentEmail: 'd@example.test', tone: 'red', kind: 'submitted_late', assignmentId: 9, title: 'CPT 1' },
];

let writeText;
function setClipboard(impl) {
  writeText = impl;
  Object.defineProperty(navigator, 'clipboard', { value: impl ? { writeText: impl } : undefined, configurable: true });
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Copy student emails' }));
const pick = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name })); });
};

beforeEach(() => { setClipboard(vi.fn().mockResolvedValue(undefined)); });
afterEach(() => { vi.useRealTimers(); });

describe('EmailMenu', () => {
  it('renders nothing when nobody still owes', () => {
    const { container } = render(<EmailMenu kind="late" rows={[ROWS[3]]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('"@ ▾" button opens a menu of tiers then assessments, with counts', () => {
    render(<EmailMenu kind="late" rows={ROWS} />);
    const btn = screen.getByRole('button', { name: 'Copy student emails' });
    expect(btn).toHaveTextContent('@ ▾');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    openMenu();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Red (1)', 'Red + amber (2)', 'Everyone still owing (3)', 'CPT 1 (2)', 'Unit 2 quiz (1)',
    ]);
    expect(screen.getByText('By assessment')).toBeInTheDocument();
  });

  it('a menu item carries the full "label (count)" as its title, with the count in its own element', () => {
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    const item = screen.getByRole('menuitem', { name: 'Red (1)' });
    expect(item).toHaveAttribute('title', 'Red (1)');
    expect(item.querySelector('.email-menu__count')).toHaveTextContent('(1)');
  });

  it('copies "; "-joined addresses and says how many, noting students with no email', async () => {
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Everyone still owing (3)');
    expect(writeText).toHaveBeenCalledWith('a@example.test; B@example.test');
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 addresses copied. Paste into Outlook To or Bcc. 1 student has no email in Prism.',
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); // closes on choice
  });

  it('the status clears after a few seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red (1)');
    expect(screen.getByRole('status')).toHaveTextContent('1 address copied.');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('status')).toBeEmptyDOMElement(); // toHaveTextContent('') would match anything
  });

  it('copies nothing when no chosen student has an email, and says so', async () => {
    render(<EmailMenu kind="late" rows={[ROWS[2]]} />);
    openMenu();
    await pick('Everyone still owing (1)');
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Nothing copied: 1 student has no email in Prism.');
  });

  it('falls back to a selected field when the clipboard rejects', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red + amber (2)');
    const field = screen.getByLabelText('Addresses to copy');
    expect(field).toHaveValue('a@example.test; B@example.test');
    expect(field).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Addresses to copy')).not.toBeInTheDocument();
  });

  it('falls back when there is no clipboard API at all', async () => {
    setClipboard(null);
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red (1)');
    expect(screen.getByLabelText('Addresses to copy')).toHaveValue('a@example.test');
  });

  it('Escape and an outside click close the menu', () => {
    render(<div><p>outside</p><EmailMenu kind="late" rows={ROWS} /></div>);
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy student emails' })).toHaveFocus();
    openMenu();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('scrolls the opened menu into view inside the scrolling rail', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<EmailMenu kind="late" rows={ROWS} />);
      openMenu();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('menu'));
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  it('scrolls the fallback bubble into view inside the scrolling rail', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
      render(<EmailMenu kind="late" rows={ROWS} />);
      openMenu();
      await pick('Red (1)');
      const bubble = screen.getByLabelText('Addresses to copy').closest('.email-menu__bubble');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(bubble);
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });
});

describe('MailLink', () => {
  it('links to a prefilled mailto', () => {
    render(<MailLink row={ROWS[0]} kind="late" />);
    expect(screen.getByRole('link', { name: 'Email Ada L' }))
      .toHaveAttribute('href', 'mailto:a@example.test?subject=CPT%201%3A%20late%20work');
  });
  it('renders nothing without an email', () => {
    const { container } = render(<MailLink row={ROWS[2]} kind="late" />);
    expect(container).toBeEmptyDOMElement();
  });
});
