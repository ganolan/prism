import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParentPhone: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
}));

import { getStudent } from '../services/api.js';
import StudentPage from './StudentPage.jsx';

// Masked fixtures: no real names, emails or phone numbers.
const base = { id: 7, first_name: 'Ana', last_name: 'Lee', courses: [], grades: [], notes: [], flags: [], parents: [], grading_scales: {} };
const REASON = {
  do_not_contact: 'Do not contact (PowerSchool)',
  deceased: 'Deceased (PowerSchool)',
  not_matched: 'Not matched to a PowerSchool guardian',
  not_checked: 'Not checked against PowerSchool yet',
  contactable: null,
};
const parent = (n, status, extra = {}) => ({
  id: n, first_name: 'Guardian', last_name: `Number${n}`, email: `guardian${n}@example.test`, relationship: null, phone: null,
  contact: { status, primary: false, reason: REASON[status] }, ...extra,
});
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>
);
const load = (fields) => getStudent.mockResolvedValue({ ...base, guardians_synced_at: '2026-10-20T08:00:00.000Z', ...fields });
const showAlerts = async (n) => fireEvent.click(await screen.findByRole('button', { name: `Show alerts (${n})` }));

let clipboard;
beforeEach(() => {
  clipboard = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

describe('StudentPage family contacts (#66)', () => {
  it('a deceased parent has no card and no email in the page until Show alerts', async () => {
    load({ parents: [parent(1, 'contactable'), parent(2, 'deceased')] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(screen.queryByText(/Number2/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('guardian2@example.test');
    expect(container.textContent).not.toContain('Deceased');
    expect(container.querySelector('a[href="mailto:guardian2@example.test"]')).toBeNull();
  });

  it('a lone deceased parent shows neither a card nor the not-synced message', async () => {
    load({ parents: [parent(2, 'deceased')] });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Family Contacts' });
    expect(screen.queryByText(/No parent\/guardian contacts synced yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Number2/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('guardian2@example.test');
    expect(screen.queryByRole('button', { name: /Copy all emails/ })).not.toBeInTheDocument();
  });

  it('the reveal shows the deceased card with its reason and a plain email', async () => {
    load({ parents: [parent(2, 'deceased')] });
    const { container } = renderPage();
    await showAlerts(1);
    expect(screen.getByText('Guardian Number2')).toBeInTheDocument();
    expect(screen.getByText('Deceased (PowerSchool)')).toBeInTheDocument();
    expect(screen.getByText('guardian2@example.test')).toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:guardian2"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide alerts' }));
    expect(screen.queryByText('Guardian Number2')).not.toBeInTheDocument();
  });

  it('a do-not-contact parent shows the name only until the reveal', async () => {
    load({ parents: [parent(3, 'do_not_contact', { phone: '0000 0000', relationship: 'Guardian' })] });
    const { container } = renderPage();
    expect(await screen.findByText('Guardian Number3')).toBeInTheDocument();
    expect(container.textContent).not.toContain('guardian3@example.test');
    expect(container.textContent).not.toContain('0000 0000');
    expect(screen.queryByText('Do not contact (PowerSchool)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Phone/ })).not.toBeInTheDocument();
    await showAlerts(1);
    expect(screen.getByText('Do not contact (PowerSchool)')).toBeInTheDocument();
    expect(screen.getByText('guardian3@example.test')).toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('not matched and not checked show their reason and a plain email, with no mailto link or copy button', async () => {
    load({ parents: [parent(4, 'not_matched'), parent(5, 'not_checked')] });
    const { container } = renderPage();
    expect(await screen.findByText('Not matched to a PowerSchool guardian')).toHaveClass('text-muted');
    expect(screen.getByText('guardian4@example.test')).toBeInTheDocument();
    expect(screen.getByText('guardian5@example.test')).toBeInTheDocument();
    // The parent's reason line plus the section line for a student not yet checked would both say it;
    // here the student was checked, so the one line is the parent's.
    expect(screen.getByText('Not checked against PowerSchool yet')).toHaveClass('text-muted');
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    // Neither is flagged, so no reveal button.
    expect(screen.queryByRole('button', { name: /Show alerts/ })).not.toBeInTheDocument();
  });

  it('Primary contact appears only after the reveal', async () => {
    load({ parents: [parent(1, 'contactable', { contact: { status: 'contactable', primary: true, reason: null } })],
      ps_alerts: [{ key: 'corr_g1', label: 'Correspondence G1', category: 'family' }] });
    renderPage();
    await screen.findByText('Guardian Number1');
    expect(screen.queryByText('Primary contact')).not.toBeInTheDocument();
    await showAlerts(1);
    expect(screen.getByText('Primary contact')).toBeInTheDocument();
  });

  it('Copy all copies contactable parents only and states the number not copied', async () => {
    load({ parents: [parent(1, 'contactable'), parent(2, 'deceased'), parent(3, 'do_not_contact'), parent(4, 'not_matched')] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy all emails' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('Guardian Number1 <guardian1@example.test>'));
    expect(screen.getByText('3 not copied')).toBeInTheDocument();
  });

  it('Copy all is hidden when no parent is contactable', async () => {
    load({ parents: [parent(3, 'do_not_contact'), parent(4, 'not_matched')] });
    renderPage();
    await screen.findByText('Guardian Number3');
    expect(screen.queryByRole('button', { name: 'Copy all emails' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not copied/)).not.toBeInTheDocument();
  });

  it('states when the guardians were checked against PowerSchool', async () => {
    load({ parents: [parent(1, 'contactable')] });
    const first = renderPage();
    expect(await screen.findByText('Checked against PowerSchool 20/10/2026')).toHaveClass('text-muted');
    first.unmount();
    load({ parents: [parent(1, 'not_checked')], guardians_synced_at: null });
    renderPage();
    await screen.findByText('Guardian Number1');
    // The section line and the parent's own reason line.
    expect(screen.getAllByText('Not checked against PowerSchool yet')).toHaveLength(2);
  });

  it('Show alerts appears for a flagged parent when the student has no other alert, and counts them', async () => {
    load({ parents: [parent(1, 'contactable'), parent(2, 'deceased'), parent(3, 'do_not_contact')], ps_alerts: [] });
    const { container } = renderPage();
    await showAlerts(2);
    // Revealed with no alerts: no empty badge row and no alerts read line.
    expect(container.querySelector('.ps-alerts')).toBeNull();
    expect(screen.queryByText(/from PowerSchool, read/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide alerts' })).toBeInTheDocument();
  });

  it('counts flagged parents with the alerts', async () => {
    load({ parents: [parent(2, 'deceased')], ps_alerts: [{ key: 'allergies', label: 'Allergies', category: 'health' }] });
    renderPage();
    await showAlerts(2);
    expect(screen.getByText('Allergies')).toBeInTheDocument();
    expect(screen.getByText('Deceased (PowerSchool)')).toBeInTheDocument();
  });

  it('with no contact field the cards are as before', async () => {
    getStudent.mockResolvedValue({ ...base, parents: [{ id: 1, first_name: 'Guardian', last_name: 'Number1', email: 'guardian1@example.test', relationship: null, phone: null }] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(container.querySelector('a[href="mailto:guardian1@example.test"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy all emails' })).toBeInTheDocument();
    expect(screen.queryByText(/not copied/)).not.toBeInTheDocument();
    expect(screen.queryByText(/against PowerSchool/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show alerts/ })).not.toBeInTheDocument();
  });

  it('shows the not-synced message only when there are no parents', async () => {
    load({ parents: [] });
    renderPage();
    expect(await screen.findByText(/No parent\/guardian contacts synced yet/)).toBeInTheDocument();
  });
});
