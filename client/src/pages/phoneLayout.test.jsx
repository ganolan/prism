// Phone layouts for the quick-lookup pages (#134). jsdom can't evaluate the
// PHONE LAYOUT media query, so these pin the markup it relies on (the folded
// line under a name, the columns it hides) and the tap interactions; the layout
// itself is checked in a real browser by `npm run check:mobile`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useProficiencyScale.js', () => ({ useProficiencyScale: () => ({ pointsToLevel: () => null }) }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParent: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  searchStudents: vi.fn(),
  searchPeople: vi.fn(),
  getFeatures: vi.fn(),
  getCourses: vi.fn(), getCoursesByView: vi.fn(), getSyncStatus: vi.fn(), toggleCourseVisibility: vi.fn(),
  discoverArchivedCourses: vi.fn(), importCourse: vi.fn(), getTriage: vi.fn(),
  recordReferral: vi.fn(), getReferrals: vi.fn(), undoReferral: vi.fn(), getMasteryLoginStatus: vi.fn(),
}));

import * as api from '../services/api.js';
import StudentPage from './StudentPage.jsx';
import SearchPage from './SearchPage.jsx';
import PeoplePage from './PeoplePage.jsx';
import Dashboard from './Dashboard.jsx';
import { RosterView } from './CoursePage.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-01-15'));
});
afterEach(() => { vi.useRealTimers(); });

const ana = { id: 7, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027 };

describe('Student page: adding a note by touch', () => {
  const student = {
    ...ana, courses: [{ id: 3, course_name: 'Robotics' }], grades: [], notes: [], flags: [],
    parents: [{ id: 1, first_name: 'Mei', last_name: 'Lee', email: 'mei.lee.a.very.long.address@example.com' }],
    grading_scales: {},
  };
  const renderPage = () => render(
    <MemoryRouter initialEntries={['/student/7']}>
      <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
    </MemoryRouter>,
  );

  it('the pencil opens the note form; Save sends the note with its course', async () => {
    api.getStudent.mockResolvedValue(student);
    api.createNote.mockResolvedValue({ id: 1 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add new note' }));
    const box = screen.getByPlaceholderText('Add a note...');
    // The form the phone layout stacks: the note, then the course + buttons.
    expect(box.closest('.note-form')).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'Note course' }).closest('.note-form__side')).not.toBeNull();
    fireEvent.change(box, { target: { value: 'Left early for the dentist' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Note course' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith({ student_id: 7, course_id: 3, content: 'Left early for the dentist' }));
  });

  it('marks the small buttons as fingertip targets and the header for the phone rules', async () => {
    api.getStudent.mockResolvedValue({ ...student, notes: [{ id: 4, content: 'Hi', created_at: '2026-01-10', course_id: null }] });
    const { container } = renderPage();
    await screen.findByRole('button', { name: 'Add new note' });
    expect(container.querySelector('.card.student-header .student-photo, .card.student-header .student-profile')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveClass('tap-target');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('tap-target');
    expect(screen.getByRole('button', { name: 'Edit extra phone and email' })).toHaveClass('tap-target');
    expect(screen.getByRole('link', { name: 'mei.lee.a.very.long.address@example.com' }).closest('.contact-email')).not.toBeNull();
  });
});

describe('Search, roster and Directory: secondary columns fold under the name', () => {
  it('Search: email + grade as one phone-only line, and the desktop columns marked col-desktop', async () => {
    api.searchStudents.mockResolvedValue([ana, { id: 8, first_name: 'Bo', last_name: 'Ng', email: null, grad_year: 2025 }]);
    const { container } = render(<MemoryRouter><SearchPage /></MemoryRouter>);
    await screen.findByText('Ana Lee');
    const sub = screen.getByText('ana@hkis.edu.hk · Grade 11');
    expect(sub).toHaveClass('person-sub', 'phone-only');
    expect(screen.getByRole('columnheader', { name: 'Email' })).toHaveClass('col-desktop');
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toHaveClass('col-desktop');
    expect(container.querySelector('table')).toHaveClass('fits-phone');
    // Bo has neither an email nor a current grade: no empty line.
    expect(container.querySelectorAll('.person-sub')).toHaveLength(1);
  });

  it('Roster: the same folded line, the Email and Grade headers marked col-desktop', () => {
    render(
      <MemoryRouter>
        <RosterView students={[ana]} mastery={null} courseId={1} displayName={(s) => s.first_name} onOverrideClick={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('ana@hkis.edu.hk · Grade 11')).toHaveClass('phone-only');
    expect(screen.getByRole('columnheader', { name: 'Email' })).toHaveClass('col-desktop');
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toHaveClass('col-desktop');
  });

  it('Directory: the school folds under the name', async () => {
    api.getFeatures.mockResolvedValue({ people_search: true });
    api.searchPeople.mockResolvedValue({ query: 'bo', complete: true, results: [{ userId: 5, name: 'Bo Test', school: 'High School', messageUserId: 5 }] });
    render(<MemoryRouter><PeoplePage /></MemoryRouter>);
    fireEvent.change(await screen.findByPlaceholderText('Search by name…'), { target: { value: 'bo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Bo Test');
    expect(screen.getAllByText('High School').find((el) => el.classList.contains('person-sub'))).toHaveClass('phone-only');
    expect(screen.getByRole('columnheader', { name: 'School' })).toHaveClass('col-desktop');
  });
});

describe('Dashboard: "Show hidden" toggles from its words as well as its track', () => {
  it('tapping the label text shows hidden courses', async () => {
    api.getCoursesByView.mockResolvedValue([]);
    api.getCourses.mockResolvedValue([]);
    api.getSyncStatus.mockResolvedValue({});
    api.getTriage.mockResolvedValue(null);
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected' });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const toggle = await screen.findByRole('switch', { name: 'Show hidden' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByText('Show hidden'));
    await waitFor(() => expect(api.getCourses).toHaveBeenCalledWith(true, true));
    expect(screen.getByRole('switch', { name: 'Show hidden' })).toHaveAttribute('aria-checked', 'true');
  });
});
