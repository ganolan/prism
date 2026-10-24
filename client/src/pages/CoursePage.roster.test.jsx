// client/src/pages/CoursePage.roster.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RosterView } from './CoursePage.jsx';

// RosterView calls useProficiencyScale(); stub it (no mastery categories rendered here).
vi.mock('../hooks/useProficiencyScale.js', () => ({
  useProficiencyScale: () => ({ pointsToLevel: () => null }),
}));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15')); });
afterEach(() => { vi.useRealTimers(); });

const students = [
  { id: 1, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027 },
];

describe('RosterView grade column', () => {
  it('renders a Grade header and the derived grade', () => {
    render(
      <MemoryRouter>
        <RosterView
          students={students}
          mastery={null}
          courseId={1}
          displayName={(s) => s.first_name}
          onOverrideClick={() => {}}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toBeInTheDocument();
    expect(screen.getByText('Grade 11')).toBeInTheDocument();
  });
});

// ── Dropped students (#128) ──
// Schoology keeps returning dropped students, so the roster receives them with
// a `dropped_at` marker. They must be out of the way by default but still
// reachable, since their grades and notes are preserved.
describe('RosterView dropped students', () => {
  const withDropped = [
    { id: 1, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027, dropped_at: null },
    { id: 2, first_name: 'Anant', last_name: 'Sachdeva', email: 'anant@hkis.edu.hk', grad_year: 2027, dropped_at: '2026-08-13T00:00:00Z' },
  ];

  const renderRoster = (rows) => render(
    <MemoryRouter>
      <RosterView
        students={rows}
        mastery={null}
        courseId={1}
        displayName={(s) => s.first_name}
        onOverrideClick={() => {}}
      />
    </MemoryRouter>
  );

  it('hides dropped students from the table by default', () => {
    renderRoster(withDropped);
    expect(screen.getByText('Ana Lee')).toBeInTheDocument();
    expect(screen.queryByText('Anant Sachdeva')).not.toBeInTheDocument();
  });

  it('summarises how many dropped, so they are never silently lost', () => {
    renderRoster(withDropped);
    expect(screen.getByRole('button', { name: /1 dropped/i })).toBeInTheDocument();
  });

  it('reveals dropped students with their drop date in DD/MM/YYYY', () => {
    renderRoster(withDropped);

    // fireEvent, not userEvent — this suite runs on fake timers, which
    // userEvent's internal delay loop would hang on.
    fireEvent.click(screen.getByRole('button', { name: /1 dropped/i }));

    expect(screen.getByText('Anant Sachdeva')).toBeInTheDocument();
    // en-GB per the project's date convention — never US M/D/YYYY.
    expect(screen.getByText(/dropped 13\/08\/2026/)).toBeInTheDocument();
  });

  it('shows no toggle when nobody has dropped', () => {
    renderRoster([withDropped[0]]);
    expect(screen.queryByRole('button', { name: /dropped/i })).not.toBeInTheDocument();
  });
});
