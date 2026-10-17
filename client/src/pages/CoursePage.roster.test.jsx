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

// ── PowerSchool alerts (#117) ──
// A roster may be projected to a class: alerts are off until the teacher turns
// them on (remembered per browser), and family alerts never show here.
describe('RosterView PowerSchool alerts', () => {
  const renderRoster = (rows) => render(
    <MemoryRouter>
      <RosterView students={rows} mastery={null} courseId={1} displayName={(s) => s.first_name} onOverrideClick={() => {}} />
    </MemoryRouter>
  );
  const ROWS = [
    { id: 1, first_name: 'Ana', last_name: 'Lee', ps_alerts: [
      { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' },
      { key: 'epipen', label: 'EpiPen', category: 'health' },
      { key: 'siblings', label: 'Siblings', category: 'family' },
    ] },
    { id: 2, first_name: 'Ben', last_name: 'Ng', ps_alerts: [] },
  ];
  const toggle = () => screen.getByRole('button', { name: 'PowerSchool alerts' });

  beforeEach(() => localStorage.clear());

  it('hides every alert by default, with the toggle off', () => {
    renderRoster(ROWS);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText('PowerSchool alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Accommodation plan')).not.toBeInTheDocument();
  });

  it('the toggle shows learning, health and other alerts beside the name, never family ones, and is remembered', () => {
    const { unmount } = renderRoster(ROWS);
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    const nameCell = screen.getByRole('link', { name: 'Ana Lee' }).closest('td');
    expect(nameCell).toHaveTextContent('Accommodation plan');
    expect(nameCell).toHaveTextContent('EpiPen');
    expect(screen.queryByText('Siblings')).not.toBeInTheDocument();
    expect(localStorage.getItem('prism:roster:show-ps-alerts')).toBe('true');
    unmount();

    renderRoster(ROWS); // a later visit in this browser
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('EpiPen')).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(screen.queryByText('EpiPen')).not.toBeInTheDocument();
    expect(localStorage.getItem('prism:roster:show-ps-alerts')).toBe('false');
  });

  it('still works when storage throws (stays off, toggles for the page)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      renderRoster(ROWS);
      expect(toggle()).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(toggle());
      expect(screen.getByText('EpiPen')).toBeInTheDocument();
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it('no toggle and no badges when the API sends no alerts (feature off)', () => {
    renderRoster([{ id: 1, first_name: 'Ana', last_name: 'Lee' }]);
    expect(screen.queryByRole('button', { name: 'PowerSchool alerts' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('PowerSchool alerts')).not.toBeInTheDocument();
  });
});
