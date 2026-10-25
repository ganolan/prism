import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import RosterFilters from './RosterFilters.jsx';
import { rosterFilterOptions, applyRosterFilters } from '../../lib/rosterVitals.js';

const A = {
  plan: { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' },
  ls1: { key: 'learning_support_1', label: 'Learning support 1', category: 'learning' },
  epipen: { key: 'epipen', label: 'EpiPen', category: 'health' },
  mobility: { key: 'mobility', label: 'Mobility', category: 'other' },
};
// 12 students, 4 with an alert, 2 with unread comments (one of them also holds an alert).
const STUDENTS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, ps_alerts: [] }));
STUDENTS[0].ps_alerts = [A.plan];
STUDENTS[1].ps_alerts = [A.ls1];
STUDENTS[2].ps_alerts = [A.epipen];
STUDENTS[3].ps_alerts = [A.mobility];
const UNREAD = { 1: 2, 9: 1 };

function Harness({ onCopyEmails = () => {} }) {
  const [selected, setSelected] = useState(new Set());
  const options = rosterFilterOptions(STUDENTS, UNREAD, selected);
  const shown = applyRosterFilters(STUDENTS, selected, UNREAD);
  return <RosterFilters options={options} selected={selected} onChange={setSelected}
    shown={shown.length} total={STUDENTS.length} onCopyEmails={onCopyEmails} />;
}

const alertsPill = () => screen.getByRole('button', { name: /^Alerts/ });
const status = () => document.querySelector('.assessment-filter-status__count');

describe('RosterFilters', () => {
  it('the Alerts group pill cycles none, all, none, and shows some when one pill is on; the status line reads "Showing 4 of 12 students"', () => {
    render(<Harness />);
    expect(alertsPill()).toHaveAttribute('data-state', 'none');
    expect(alertsPill()).toHaveTextContent('Alerts4');
    expect(status()).toHaveTextContent('Showing all 12 students');
    expect(screen.queryByRole('button', { name: /Clear all/ })).not.toBeInTheDocument();

    fireEvent.click(alertsPill());
    expect(alertsPill()).toHaveAttribute('data-state', 'all');
    expect(alertsPill()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Learning plan/ })).toHaveAttribute('aria-pressed', 'true');
    expect(status()).toHaveTextContent('Showing 4 of 12 students');

    fireEvent.click(alertsPill());
    expect(alertsPill()).toHaveAttribute('data-state', 'none');
    expect(status()).toHaveTextContent('Showing all 12 students');

    fireEvent.click(screen.getByRole('button', { name: /^Learning plan/ }));
    expect(alertsPill()).toHaveAttribute('data-state', 'some');
    expect(alertsPill()).toHaveAttribute('aria-pressed', 'mixed');
    expect(status()).toHaveTextContent('Showing 2 of 12 students');
    // From some, the group pill selects the whole row.
    fireEvent.click(alertsPill());
    expect(alertsPill()).toHaveAttribute('data-state', 'all');
  });

  it('one pill per alert type with its count; learning alerts share Learning plan', () => {
    render(<Harness />);
    const row = screen.getByRole('group', { name: 'Alerts' });
    expect([...row.querySelectorAll('.filter-btn')].map((b) => b.textContent)).toEqual(['Learning plan2', 'EpiPen1', 'Mobility1']);
  });

  it('Follow up has the muted group pill and Unread comments; it combines with alerts as any of', () => {
    render(<Harness />);
    const follow = screen.getByRole('button', { name: /^Follow up/ });
    expect(follow).toHaveClass('group-pill--watch');
    expect(follow).toHaveTextContent('Follow up2');
    fireEvent.click(screen.getByRole('button', { name: /^Unread comments/ }));
    expect(status()).toHaveTextContent('Showing 2 of 12 students');
    fireEvent.click(screen.getByRole('button', { name: /^EpiPen/ }));
    expect(status()).toHaveTextContent('Showing 3 of 12 students');
  });

  it('Clear all sits on the right while a filter is on, and clears every pill', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Mobility/ }));
    const clear = screen.getByRole('button', { name: /Clear all/ });
    expect(clear).toHaveClass('filter-btn-clear');
    fireEvent.click(clear);
    expect(status()).toHaveTextContent('Showing all 12 students');
    expect(screen.getByRole('button', { name: /^Mobility/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Copy emails (N) sits beside the count and counts the students shown', () => {
    const onCopyEmails = vi.fn();
    render(<Harness onCopyEmails={onCopyEmails} />);
    expect(screen.getByRole('button', { name: 'Copy emails (12)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Learning plan/ }));
    const copy = screen.getByRole('button', { name: 'Copy emails (2)' });
    expect(copy.closest('.roster-filter-status__left')).toContainElement(status());
    fireEvent.click(copy);
    expect(onCopyEmails).toHaveBeenCalledWith(copy);
  });
});

describe('RosterFilters Gender row', () => {
  const PEOPLE = [
    { id: 1, gender: 'F', ps_alerts: [] }, { id: 2, gender: 'F', ps_alerts: [] },
    { id: 3, gender: 'M', ps_alerts: [] }, { id: 4, ps_alerts: [] },
  ];
  function GenderHarness({ people = PEOPLE }) {
    const [selected, setSelected] = useState(new Set());
    const options = rosterFilterOptions(people, null, selected);
    const shown = applyRosterFilters(people, selected, null);
    return <RosterFilters options={options} selected={selected} onChange={setSelected}
      shown={shown.length} total={people.length} onCopyEmails={() => {}} />;
  }

  it('is a group pill with the F, M and ? codes, built from the same pills as Alerts', () => {
    render(<GenderHarness />);
    const row = screen.getByRole('group', { name: 'Gender' });
    expect(row.querySelector('.group-pill')).toHaveTextContent('Gender4');
    expect([...row.querySelectorAll('.filter-btn')].map((b) => b.textContent)).toEqual(['F2', 'M1', '?1']);
    fireEvent.click(screen.getByRole('button', { name: /^Female/ }));
    expect(screen.getByRole('button', { name: /^Gender/ })).toHaveAttribute('data-state', 'some');
    expect(status()).toHaveTextContent('Showing 2 of 4 students');
    fireEvent.click(screen.getByRole('button', { name: /^Gender/ }));
    expect(screen.getByRole('button', { name: /^Gender/ })).toHaveAttribute('data-state', 'all');
    expect(status()).toHaveTextContent('Showing 4 of 4 students');
  });

  it('lists only the pills someone matches', () => {
    render(<GenderHarness people={[{ id: 1, gender: 'M', ps_alerts: [] }]} />);
    const row = screen.getByRole('group', { name: 'Gender' });
    expect([...row.querySelectorAll('.filter-btn')].map((b) => b.textContent)).toEqual(['M1']);
  });

  it('a pill names itself in full (aria-label) and shows the full label in an instant popover', () => {
    render(<GenderHarness people={[...PEOPLE, { id: 5, gender: 'X', ps_alerts: [] }]} />);
    const row = screen.getByRole('group', { name: 'Gender' });
    const nb = within(row).getByRole('button', { name: 'Recorded in PowerSchool as "X", 1' });
    expect(nb).toHaveTextContent('NB1');
    expect(within(row).getByRole('button', { name: 'Not recorded in PowerSchool, 1' })).toHaveTextContent('?1');
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.mouseEnter(nb);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
    fireEvent.mouseLeave(nb);
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.focus(nb);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Recorded in PowerSchool as "X"');
  });

  it('the NB and ? pills filter', () => {
    render(<GenderHarness people={[...PEOPLE, { id: 5, gender: 'X', ps_alerts: [] }]} />);
    fireEvent.click(screen.getByRole('button', { name: /^Recorded in PowerSchool/ }));
    expect(status()).toHaveTextContent('Showing 1 of 5 students');
    fireEvent.click(screen.getByRole('button', { name: /^Not recorded/ }));
    expect(status()).toHaveTextContent('Showing 2 of 5 students');
    fireEvent.click(screen.getByRole('button', { name: /^Recorded in PowerSchool/ }));
    expect(status()).toHaveTextContent('Showing 1 of 5 students');
  });
});
