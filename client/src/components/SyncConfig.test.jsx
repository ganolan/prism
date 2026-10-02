import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncConfig from './SyncConfig.jsx';

const COURSES = [
  { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0, synced_at: '2026-05-20T12:00:00Z', block_synced_at: '2026-05-20T12:00:00Z' },
  { id: 2, course_name: 'Chemistry 11', hidden: 0, archived: 0, block_synced_at: '2026-05-20T12:00:00Z' },
  { id: 3, course_name: 'Old Physics', hidden: 1, archived: 0, block_synced_at: '2026-05-20T12:00:00Z' },
  { id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1 },
];

// A calendar fresh enough (and present) that it never drives the PowerSchool
// default on its own — tests that care only about needsFirstBlockSync use
// this so the calendar freshness check stays out of their way.
const FRESH_CALENDAR = { source: 'powerschool', totalSchoolDays: 120, syncedAt: new Date().toISOString() };

function renderConfig(props = {}) {
  return render(
    <SyncConfig
      courses={COURSES}
      calendar={props.calendar === undefined ? FRESH_CALENDAR : props.calendar}
      loggedIn={true}
      busy={props.busy ?? false}
      onStart={props.onStart || (() => {})}
      onCancel={props.onCancel || (() => {})}
      onLogin={props.onLogin || (() => {})}
    />
  );
}

describe('SyncConfig', () => {
  beforeEach(() => localStorage.clear());

  it('renders the visible and hidden course groups', () => {
    renderConfig();
    expect(screen.getByText(/Visible courses/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden courses/)).toBeInTheDocument();
  });

  it('shows visible courses expanded and others collapsed by default', () => {
    renderConfig();
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
    expect(screen.queryByLabelText('Old Physics')).not.toBeInTheDocument();
  });

  it('expands a collapsed group when its header is clicked', () => {
    renderConfig();
    fireEvent.click(screen.getByText(/Hidden courses/));
    expect(screen.getByLabelText('Old Physics')).toBeInTheDocument();
  });

  it('pre-selects all visible courses and starts with their ids', () => {
    const onStart = vi.fn();
    renderConfig({ onStart });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    // onStart is called with the selected ids AND the include-hidden option
    // (default false). See SyncConfig's "Start sync" handler.
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ includeHidden: false, recentOnly: false, recentDays: 30 }));
  });

  it('defaults block sync OFF once every active course has had a block pass (block_synced_at set)', () => {
    const onStart = vi.fn();
    renderConfig({ onStart }); // COURSES: every active course has block_synced_at
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: false }));
  });

  it('defaults block sync ON for a first block pass (no active course synced yet)', () => {
    const onStart = vi.fn();
    const fresh = [{ id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 }];
    render(
      <SyncConfig courses={fresh} loggedIn={true} busy={false}
        onStart={onStart} onCancel={() => {}} onLogin={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1], expect.objectContaining({ syncBlocks: true }));
  });

  // Regression: right after the yearly rollover, new active courses get
  // routine Schoology data (synced_at) well before anyone runs a block pass
  // for them. The default must key off block_synced_at, not synced_at, or the
  // checkbox silently defaults OFF and blocks/grade-levels never populate.
  it('defaults block sync ON when courses have synced_at but no block_synced_at yet (new-year rollover)', () => {
    const onStart = vi.fn();
    const newYear = [
      { id: 1, course_name: 'AI & Machine Learning', hidden: 0, archived: 0, synced_at: '2026-08-10T12:00:00Z' },
    ];
    render(
      <SyncConfig courses={newYear} loggedIn={true} busy={false}
        onStart={onStart} onCancel={() => {}} onLogin={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1], expect.objectContaining({ syncBlocks: true }));
  });

  // Bug found in prod: school_days is written only by this same block pass,
  // so a calendar that's never loaded (or gone stale) must pre-tick the box
  // even once every active course already has a block pass on record.
  it('defaults block sync ON when the school calendar is missing (no PowerSchool rows)', () => {
    const onStart = vi.fn();
    renderConfig({ onStart, calendar: { source: 'weekdays', totalSchoolDays: 0, syncedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: true }));
    expect(screen.getByText(/school calendar missing/i)).toBeInTheDocument();
  });

  it('defaults block sync ON when the calendar has not synced in over two weeks', () => {
    const onStart = vi.fn();
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    renderConfig({ onStart, calendar: { source: 'powerschool', totalSchoolDays: 120, syncedAt: old } });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: true }));
    expect(screen.getByText(/calendar over 2 weeks old/i)).toBeInTheDocument();
  });

  it('defaults block sync OFF when the calendar is present and synced within two weeks', () => {
    const onStart = vi.fn();
    renderConfig({ onStart }); // FRESH_CALENDAR via renderConfig's default
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: false }));
  });

  it('treats a null calendar (fetch still pending or failed) as missing', () => {
    const onStart = vi.fn();
    renderConfig({ onStart, calendar: null });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: true }));
  });

  it('labels the first-sync reason over the calendar reason when both apply', () => {
    const fresh = [{ id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 }];
    render(
      <SyncConfig courses={fresh} calendar={{ source: 'weekdays', totalSchoolDays: 0, syncedAt: null }}
        loggedIn={true} busy={false} onStart={() => {}} onCancel={() => {}} onLogin={() => {}} />
    );
    expect(screen.getByText(/\(first sync\)/)).toBeInTheDocument();
    expect(screen.queryByText(/school calendar missing/i)).not.toBeInTheDocument();
  });

  it('toggling the block-sync checkbox flips syncBlocks', () => {
    const onStart = vi.fn();
    renderConfig({ onStart }); // defaults OFF (every active COURSES row has block_synced_at)
    fireEvent.click(screen.getByLabelText(/sync from powerschool/i));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ syncBlocks: true }));
  });

  it('group select-all checkbox is indeterminate when only some are selected', () => {
    renderConfig();
    fireEvent.click(screen.getByLabelText('Biology 9')); // deselect one
    const groupCheckbox = screen.getByLabelText(/select all visible/i);
    expect(groupCheckbox.indeterminate).toBe(true);
  });

  it('shows a login prompt instead of the course tree when not logged in', () => {
    render(
      <SyncConfig courses={COURSES} loggedIn={false} busy={false}
        onStart={() => {}} onCancel={() => {}} onLogin={() => {}} />
    );
    expect(screen.getByRole('button', { name: /log in to schoology/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Biology 9')).not.toBeInTheDocument();
  });

  it('group select-all toggles every course in the group', () => {
    renderConfig();
    const groupCheckbox = screen.getByLabelText(/select all visible/i);
    expect(groupCheckbox.checked).toBe(true);
    fireEvent.click(groupCheckbox);
    expect(screen.getByLabelText('Biology 9').checked).toBe(false);
    expect(screen.getByLabelText('Chemistry 11').checked).toBe(false);
    fireEvent.click(groupCheckbox);
    expect(screen.getByLabelText('Biology 9').checked).toBe(true);
  });

  it('disables Cancel and Start while busy', () => {
    renderConfig({ busy: true });
    expect(screen.getByRole('button', { name: /start sync/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('collapses an expanded group when its header is clicked', () => {
    renderConfig();
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Visible courses/));
    expect(screen.queryByLabelText('Biology 9')).not.toBeInTheDocument();
  });
  it('shows a last-synced line on a current course', () => {
    renderConfig();
    // Biology 9 is in the (expanded) visible group; its synced_at renders a line.
    expect(screen.getByText(/synced 20\/05\/2026/)).toBeInTheDocument();
  });

  it('reveals the day stepper only when "recent submissions" is checked', () => {
    renderConfig();
    expect(screen.queryByLabelText(/day window/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/include only recent submissions/i));
    expect(screen.getByLabelText(/day window/i)).toBeInTheDocument();
  });

  it('passes recentOnly + recentDays on Start and persists them', () => {
    const onStart = vi.fn();
    renderConfig({ onStart });
    fireEvent.click(screen.getByLabelText(/include only recent submissions/i));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], expect.objectContaining({ includeHidden: false, recentOnly: true, recentDays: 30 }));
    expect(localStorage.getItem('prism:sync:recent-only')).toBe('true');
  });
});
