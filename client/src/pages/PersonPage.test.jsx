import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setPrivateDetails } from '../lib/privateDetails.js';

vi.mock('../services/api.js', () => ({ getPerson: vi.fn(), addPersonNote: vi.fn(), deletePersonNote: vi.fn(), deletePerson: vi.fn() }));

import { getPerson, addPersonNote, deletePerson } from '../services/api.js';
import PersonPage from './PersonPage.jsx';

// #203. Masked fixtures: no real names or emails.
const STUDENT = {
  schoology_uid: '600', kind: 'student', name_display: 'Ana Ng', name_first: 'Ana', email: '280123@example.test', picture_url: null,
  parents: [{ uid: '11', name: 'Parent One', email: 'parent@example.test' }], courses: [{ title: 'Robotics: ASA' }],
  groups: [{ title: 'Robotics Club' }], read_at: '2026-10-28T12:00:00.000Z', notes: [{ id: 1, content: 'Met at Robotics', created_at: '2026-10-28T12:00:00.000Z' }],
};
const renderAt = (uid) => render(
  <MemoryRouter initialEntries={[`/people/${uid}`]}>
    <Routes>
      <Route path="/people/:uid" element={<PersonPage />} />
      <Route path="/student/:id" element={<p>Student page {'#'}</p>} />
      <Route path="/people" element={<p>Directory page</p>} />
    </Routes>
  </MemoryRouter>
);

describe('PersonPage (#203)', () => {
  it('a student not in Prism: kind, courses, groups, parents and notes with Private details on', async () => {
    getPerson.mockResolvedValue({ profile: STUDENT });
    renderAt('600');
    expect(await screen.findByRole('heading', { name: /Ana Ng/ })).toHaveTextContent('Student');
    expect(screen.getByText('Robotics: ASA')).toBeInTheDocument();
    expect(screen.getByText('Robotics Club')).toBeInTheDocument();
    expect(screen.getByText('parent@example.test')).toBeInTheDocument();
    expect(screen.getByText('Met at Robotics')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Schoology' })).toHaveAttribute('href', 'https://schoology.hkis.edu.hk/user/600');
  });

  it('with Private details off, parents and notes are not in the page', async () => {
    setPrivateDetails(false);
    getPerson.mockResolvedValue({ profile: STUDENT });
    const { container } = renderAt('600');
    await screen.findByText('Robotics: ASA');
    expect(container.textContent).not.toContain('parent@example.test');
    expect(container.textContent).not.toContain('Met at Robotics');
    expect(screen.getByText('Parents and notes are private.')).toBeInTheDocument();
    setPrivateDetails(true);
  });

  it('staff: position and subjects; Read again asks for a fresh read', async () => {
    getPerson.mockResolvedValue({ profile: { schoology_uid: '500', kind: 'staff', name_display: 'Sam Lee', position: 'HS Counselor', subjects: 'Advisory', read_at: '2026-10-28T12:00:00.000Z', notes: [] } });
    renderAt('500');
    expect(await screen.findByText('HS Counselor')).toBeInTheDocument();
    expect(screen.queryByText('Current courses')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(getPerson).toHaveBeenLastCalledWith('500', { refresh: true }));
  });

  it('a Prism student opens their student page', async () => {
    getPerson.mockResolvedValue({ student_id: 42 });
    renderAt('601');
    expect(await screen.findByText(/Student page/)).toBeInTheDocument();
  });

  it('a note is saved and shown first', async () => {
    getPerson.mockResolvedValue({ profile: STUDENT });
    addPersonNote.mockResolvedValue({ id: 2, content: 'Second note', created_at: '2026-10-29T12:00:00.000Z' });
    renderAt('600');
    fireEvent.change(await screen.findByRole('textbox', { name: 'New note' }), { target: { value: 'Second note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Second note')).toBeInTheDocument();
    expect(addPersonNote).toHaveBeenCalledWith('600', 'Second note');
  });

  it('Delete profile asks once, then deletes and returns to the Directory', async () => {
    getPerson.mockResolvedValue({ profile: STUDENT });
    deletePerson.mockResolvedValue({ deleted: true });
    renderAt('600');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete profile' }));
    expect(deletePerson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Directory page')).toBeInTheDocument();
    expect(deletePerson).toHaveBeenCalledWith('600');
  });

  it('a profile Schoology could not read again shows the date it was last read, and why', async () => {
    getPerson.mockResolvedValue({ profile: { ...STUDENT, read_at: '2025-09-01T00:00:00.000Z', read_error: 'the Schoology session has expired' } });
    renderAt('600');
    expect(await screen.findByText(/Could not read this profile again from Schoology \(the Schoology session has expired\)\. It shows what Schoology held on 01\/09\/2025\./)).toBeInTheDocument();
  });
});
