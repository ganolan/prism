// Make-up tracking chip on the Assessments tab: a Schoology test/quiz can be
// ignored for make-ups (all students), or tracked again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage, { AssessmentsView } from './CoursePage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

const quiz = { id: 11, title: 'Unit 1 quiz', schoology_assignment_id: 'q1', aligned: 0, is_test: 1, makeup_ignored: 0, due_date: null };
const result = { id: 12, title: 'Unit 1 quiz - Result', schoology_assignment_id: 'r1', aligned: 1, is_test: 0, makeup_ignored: 0, due_date: null };

function renderView(props) {
  return render(<MemoryRouter><AssessmentsView data={{ assignments: [quiz, result], folders: [] }} courseId="5" {...props} /></MemoryRouter>);
}

describe('AssessmentsView — make-up tracking chip', () => {
  it('only Schoology tests get the chip, and only when tracking can change (a live course)', () => {
    const { unmount } = renderView({ onToggleMakeUp: vi.fn() });
    expect(screen.getAllByRole('button', { name: /Make-ups:/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Make-ups: tracked' })).toHaveAttribute('aria-pressed', 'true');
    unmount();
    renderView({});
    expect(screen.queryByRole('button', { name: /Make-ups:/ })).not.toBeInTheDocument();
  });

  it('shows "ignored" and flips on click', () => {
    const onToggleMakeUp = vi.fn().mockResolvedValue();
    render(<MemoryRouter><AssessmentsView data={{ assignments: [{ ...quiz, makeup_ignored: 1 }], folders: [] }} courseId="5" onToggleMakeUp={onToggleMakeUp} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Make-ups: ignored' }));
    expect(onToggleMakeUp).toHaveBeenCalledWith(expect.objectContaining({ id: 11, makeup_ignored: 1 }));
  });

  it('a failed flip shows the error', async () => {
    renderView({ onToggleMakeUp: vi.fn().mockRejectedValue(new Error('Server unreachable')) });
    fireEvent.click(screen.getByRole('button', { name: 'Make-ups: tracked' }));
    expect((await screen.findByText(/Server unreachable/)).closest('.alert')).toHaveClass('alert-warning');
  });
});

describe('CoursePage — make-up tracking round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 0 });
    vi.mocked(api.getCourseStudents).mockResolvedValue([]);
    vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [quiz], folders: [], students: [], grades: {} });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(null);
    vi.mocked(api.getTriage).mockResolvedValue(null);
    vi.mocked(api.setMakeUpIgnored).mockResolvedValue({ assignmentId: 11, title: 'Unit 1 quiz', ignored: true });
  });

  it('the chip calls the API, flips to "ignored" and reloads the triage panels', async () => {
    render(
      <MemoryRouter initialEntries={['/course/5?tab=assessments']}>
        <Routes><Route path="/course/:id" element={<CoursePage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Make-ups: tracked' }));
    await waitFor(() => expect(api.setMakeUpIgnored).toHaveBeenCalledWith(11, true));
    expect(await screen.findByRole('button', { name: 'Make-ups: ignored' })).toBeInTheDocument();
    // The Triage section re-fetches (version bump, no remount).
    await waitFor(() => expect(vi.mocked(api.getTriage).mock.calls.filter(([o]) => o.includeFormative === undefined)).toHaveLength(2));
  });
});
