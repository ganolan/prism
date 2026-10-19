import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MasteryFreshness, { freshnessTime } from './MasteryFreshness.jsx';
import { signInDeps } from '../lib/signIn.js';

const NOW = new Date('2026-10-19T06:30:00');
const TODAY = new Date('2026-10-19T03:02:00').toISOString();
const YESTERDAY = new Date('2026-10-18T03:02:00').toISOString();

describe('MasteryFreshness (#52)', () => {
  it('freshnessTime: a time today, else the day-first date and time', () => {
    expect(freshnessTime(TODAY, NOW)).toBe('03:02 today');
    expect(freshnessTime(YESTERDAY, NOW)).toBe('18/10/2026, 03:02');
    expect(freshnessTime(null, NOW)).toBe('');
  });

  it('while refreshing: the stamp the page loaded with, and that Schoology is being checked', () => {
    render(<MasteryFreshness state={{ status: 'refreshing' }} syncedAt={YESTERDAY} now={NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Mastery levels as of 18/10/2026, 03:02. Checking Schoology for changes…');
  });

  it('after a refresh: the new stamp', () => {
    render(<MasteryFreshness state={{ status: 'done', syncedAt: TODAY }} syncedAt={YESTERDAY} now={NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Mastery levels read from Schoology at 03:02 today.');
  });

  it('idle with no stamp (before the refresh starts): no line', () => {
    const { container } = render(<MasteryFreshness state={{ status: 'idle' }} syncedAt={null} now={NOW} />);
    expect(container.textContent).toBe('');
  });

  it('never read', () => {
    render(<MasteryFreshness state={{ status: 'done', syncedAt: null }} syncedAt={null} now={NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Mastery levels not yet read from Schoology.');
  });

  it('a failure says so and keeps the old stamp; a sign-in failure offers Log in to Schoology', () => {
    const go = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    const { rerender } = render(<MasteryFreshness state={{ status: 'error', syncedAt: YESTERDAY, error: 'HTTP 500 for x', signIn: false }} now={NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Could not refresh mastery levels from Schoology. Showing levels read at 18/10/2026, 03:02.');
    expect(screen.getByRole('status').getAttribute('title')).toBe('HTTP 500 for x');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<MasteryFreshness state={{ status: 'error', syncedAt: YESTERDAY, error: 'Log in', signIn: true }} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(go).toHaveBeenCalled();
    go.mockRestore();
  });

  it('a newer stamp on the page\'s own data (after Sync Mastery) wins, and clears an earlier error', () => {
    render(<MasteryFreshness state={{ status: 'error', syncedAt: YESTERDAY, error: 'x', signIn: true }} syncedAt={TODAY} now={NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Mastery levels read from Schoology at 03:02 today.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
