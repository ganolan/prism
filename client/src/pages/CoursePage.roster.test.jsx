// client/src/pages/CoursePage.roster.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
