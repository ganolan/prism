import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParent: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
}));

import { getStudent, updateParent } from '../services/api.js';
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
// contact as the API sends it (#173): ps = the PowerSchool slot's details, email = the
// address to show, copy = the addresses that may be linked and copied ([] unless contactable).
const contactFor = (n, status, more = {}) => ({
  status, primary: false, reason: REASON[status], ps: null, email: `guardian${n}@example.test`,
  copy: status === 'contactable' ? [`guardian${n}@example.test`] : [], ...more,
});
const parent = (n, status, extra = {}) => ({
  id: n, first_name: 'Guardian', last_name: `Number${n}`, email: `guardian${n}@example.test`, relationship: null, phone: null,
  extra_email: null, contact: contactFor(n, status), ...extra,
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
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    await showAlerts(1);
    expect(screen.getByText('Do not contact (PowerSchool)')).toBeInTheDocument();
    expect(screen.getByText('guardian3@example.test')).toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    // No edit on a revealed do-not-contact card.
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
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

  it('Primary contact shows without the reveal, and still after it', async () => {
    load({ parents: [parent(1, 'contactable', { contact: contactFor(1, 'contactable', { primary: true }) })],
      ps_alerts: [{ key: 'corr_g1', label: 'Correspondence G1', category: 'family' }] });
    renderPage();
    await screen.findByText('Guardian Number1');
    expect(screen.getByText('Primary contact')).toBeInTheDocument();
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

  it('not matched and not checked phones are plain text, with no tel link', async () => {
    load({ parents: [parent(4, 'not_matched', { phone: '0000 0004' }), parent(5, 'not_checked', { phone: '0000 0005' })] });
    const { container } = renderPage();
    expect(await screen.findByText('0000 0004')).toBeInTheDocument();
    expect(screen.getByText('0000 0005')).toBeInTheDocument();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('with the feature on, a parent with no contact is not checked: not copied, reason shown', async () => {
    const bare = { id: 2, first_name: 'Guardian', last_name: 'Number2', email: 'guardian2@example.test', relationship: null, phone: null };
    load({ parents: [parent(1, 'contactable'), bare] });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy all emails' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('Guardian Number1 <guardian1@example.test>'));
    expect(screen.getByText('1 not copied')).toBeInTheDocument();
    expect(screen.getByText('Not checked against PowerSchool yet')).toHaveClass('text-muted');
    expect(screen.getByText('guardian2@example.test')).toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:guardian2"]')).toBeNull();
  });

  it('an uncertain deceased parent is hidden until the reveal, then shows its reason as sent', async () => {
    const reason = 'Not matched to a PowerSchool guardian. Guardian 2 is flagged: Deceased (PowerSchool)';
    load({ parents: [parent(1, 'contactable'), parent(2, 'deceased', { contact: contactFor(2, 'deceased', { uncertain: true, reason }) })] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(screen.queryByText(/Number2/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('guardian2@example.test');
    expect(container.textContent).not.toContain('flagged');
    await showAlerts(1);
    expect(screen.getByText('Guardian Number2')).toBeInTheDocument();
    expect(screen.getByText(reason)).toHaveClass('text-muted');
    expect(container.querySelector('a[href^="mailto:guardian2"]')).toBeNull();
  });

  it('the reveal is cleared when the page moves to another student, and again on the way back', async () => {
    const students = {
      7: { ...base, guardians_synced_at: '2026-10-20T08:00:00.000Z', parents: [parent(2, 'deceased')] },
      8: { ...base, id: 8, first_name: 'Bo', guardians_synced_at: '2026-10-20T08:00:00.000Z', parents: [parent(3, 'deceased')],
        ps_alerts: [{ key: 'allergies', label: 'Allergies', category: 'health' }] },
    };
    getStudent.mockImplementation((id) => Promise.resolve(students[id]));
    function Go() {
      const navigate = useNavigate();
      return (<>
        <button onClick={() => navigate('/student/8')}>to 8</button>
        <button onClick={() => navigate('/student/7')}>to 7</button>
      </>);
    }
    render(
      <MemoryRouter initialEntries={['/student/7']}>
        <Go />
        <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
      </MemoryRouter>
    );
    await showAlerts(1);
    expect(screen.getByText('Guardian Number2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'to 8' }));
    expect(await screen.findByRole('button', { name: 'Show alerts (2)' })).toBeInTheDocument();
    expect(screen.queryByText('Guardian Number3')).not.toBeInTheDocument();
    expect(screen.queryByText('Allergies')).not.toBeInTheDocument();
    expect(screen.queryByText('Guardian Number2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'to 7' }));
    expect(await screen.findByRole('button', { name: 'Show alerts (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Guardian Number2')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide alerts' })).not.toBeInTheDocument();
  });

  it('shows the not-synced message only when there are no parents', async () => {
    load({ parents: [] });
    renderPage();
    expect(await screen.findByText(/No parent\/guardian contacts synced yet/)).toBeInTheDocument();
  });
});

describe('StudentPage guardian details from PowerSchool (#173)', () => {
  const PS1 = 'home1@example.test';
  const matched = (more = {}, parentMore = {}) => parent(1, 'contactable', {
    contact: contactFor(1, 'contactable', { ps: { email: PS1, phone: '0000 1001' }, email: PS1, copy: [PS1], ...more }),
    ...parentMore,
  });
  beforeEach(() => { updateParent.mockReset(); });
  const links = (container, scheme) => [...container.querySelectorAll(`a[href^="${scheme}:"]`)].map((a) => a.getAttribute('href'));

  it('shows the PowerSchool email and phone for a matched guardian', async () => {
    load({ parents: [matched()] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(links(container, 'mailto')).toEqual([`mailto:${PS1}`]);
    expect(links(container, 'tel')).toEqual(['tel:0000 1001']);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    // The Schoology address is not shown when PowerSchool has one.
    expect(container.textContent).not.toContain('guardian1@example.test');
  });

  it('falls back to the Schoology email', async () => {
    load({ parents: [parent(1, 'contactable', { contact: contactFor(1, 'contactable', { ps: { email: null, phone: '0000 1001' } }) })] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(links(container, 'mailto')).toEqual(['mailto:guardian1@example.test']);
    expect(links(container, 'tel')).toEqual(['tel:0000 1001']);
  });

  it("shows the teacher's extra phone and email with Added in Prism", async () => {
    load({ parents: [matched({ copy: [PS1, 'extra1@example.test'] }, { phone: '0000 2002', extra_email: 'extra1@example.test' })] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(links(container, 'tel')).toEqual(['tel:0000 1001', 'tel:0000 2002']);
    expect(links(container, 'mailto')).toEqual([`mailto:${PS1}`, 'mailto:extra1@example.test']);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    const labels = screen.getAllByText('Added in Prism');
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l).toHaveClass('text-muted');
  });

  it('Edit saves the extra phone and email', async () => {
    load({ parents: [matched()] });
    updateParent.mockResolvedValue({});
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit extra phone and email' }));
    fireEvent.change(screen.getByLabelText('Extra phone'), { target: { value: ' 0000 3003 ' } });
    fireEvent.change(screen.getByLabelText('Extra email'), { target: { value: 'extra1@example.test' } });
    const loads = getStudent.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateParent).toHaveBeenCalledWith('7', 1, { phone: '0000 3003', extra_email: 'extra1@example.test' }));
    await waitFor(() => expect(getStudent.mock.calls.length).toBeGreaterThan(loads));
    await waitFor(() => expect(screen.queryByLabelText('Extra phone')).not.toBeInTheDocument());

    // Cancel closes the inputs without saving, and they open again with the stored values.
    updateParent.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Edit extra phone and email' }));
    fireEvent.change(screen.getByLabelText('Extra phone'), { target: { value: '0000 9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Extra phone')).not.toBeInTheDocument();
    expect(updateParent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit extra phone and email' }));
    expect(screen.getByLabelText('Extra phone')).toHaveValue('');
  });

  it("Edit shows the server's message for a bad email", async () => {
    load({ parents: [matched({}, { phone: '0000 2002' })] });
    updateParent.mockRejectedValue(Object.assign(new Error('Extra email must be an email address'), { status: 400 }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit extra phone and email' }));
    expect(screen.getByLabelText('Extra phone')).toHaveValue('0000 2002');
    fireEvent.change(screen.getByLabelText('Extra email'), { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Extra email must be an email address')).toBeInTheDocument();
    // The inputs stay open with what the teacher typed.
    expect(screen.getByLabelText('Extra email')).toHaveValue('not an address');
    expect(updateParent).toHaveBeenCalledWith('7', 1, { phone: '0000 2002', extra_email: 'not an address' });
  });

  it("a deceased guardian's extra phone is hidden before the reveal", async () => {
    const dead = parent(2, 'deceased', {
      phone: '0000 2002', extra_email: 'extra2@example.test',
      contact: contactFor(2, 'deceased', { ps: { email: 'ps.guardian2@example.test', phone: '0000 2001' }, email: 'ps.guardian2@example.test' }),
    });
    load({ parents: [parent(1, 'contactable'), dead] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    for (const s of ['0000 2002', '0000 2001', 'extra2@example.test', 'ps.guardian2@example.test', 'Added in Prism']) {
      expect(container.textContent).not.toContain(s);
    }
    await showAlerts(1);
    expect(screen.getByText('0000 2002')).toBeInTheDocument();
    expect(screen.getByText('0000 2001')).toBeInTheDocument();
    expect(screen.getByText('extra2@example.test')).toBeInTheDocument();
    expect(links(container, 'tel')).toEqual([]);
    expect(links(container, 'mailto')).toEqual(['mailto:guardian1@example.test']);
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeInTheDocument(); // Guardian 1's only
    expect(screen.getAllByRole('button', { name: /Edit/ })).toHaveLength(1);
  });

  it('a restricted card has no tel or mailto link for any detail', async () => {
    const details = (n, status) => parent(n, status, {
      phone: `0000 ${n}002`, extra_email: `extra${n}@example.test`,
      contact: contactFor(n, status, { ps: { email: `ps.guardian${n}@example.test`, phone: `0000 ${n}001` }, email: `ps.guardian${n}@example.test` }),
    });
    load({ parents: [details(3, 'do_not_contact'), details(4, 'not_matched'), details(5, 'not_checked')] });
    const { container } = renderPage();
    await showAlerts(1);
    for (const n of [3, 4, 5]) {
      for (const s of [`0000 ${n}001`, `0000 ${n}002`, `ps.guardian${n}@example.test`, `extra${n}@example.test`]) {
        expect(screen.getByText(s)).toBeInTheDocument();
      }
    }
    expect(container.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy all/ })).not.toBeInTheDocument();
    // Not matched and not checked can still be edited; do not contact cannot.
    expect(screen.getAllByRole('button', { name: 'Edit extra phone and email' })).toHaveLength(2);
  });

  it('an address a contactable guardian shows but may not copy is plain text', async () => {
    // Guardian 1's extra email is held by a do-not-contact guardian, so the API leaves it out of copy.
    load({ parents: [parent(1, 'contactable', { extra_email: 'shared@example.test' })] });
    const { container } = renderPage();
    expect(await screen.findByText('shared@example.test')).toBeInTheDocument();
    expect(links(container, 'mailto')).toEqual(['mailto:guardian1@example.test']);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
  });

  it('a guardian not cleared is never linked or copied, even if copy lists an address', async () => {
    load({ parents: [parent(4, 'not_matched', { contact: contactFor(4, 'not_matched', { copy: ['guardian4@example.test'] }) })] });
    const { container } = renderPage();
    expect(await screen.findByText('guardian4@example.test')).toBeInTheDocument();
    expect(links(container, 'mailto')).toEqual([]);
    expect(screen.queryByRole('button', { name: /Copy/ })).not.toBeInTheDocument();
  });

  it("Copy all includes a copyable guardian's extra email", async () => {
    load({ parents: [
      matched({ copy: [PS1, 'extra1@example.test'] }, { extra_email: 'extra1@example.test' }),
      parent(4, 'not_matched', { extra_email: 'extra4@example.test' }),
    ] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy all emails' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(`Guardian Number1 <${PS1}>; Guardian Number1 <extra1@example.test>`));
    expect(screen.getByText('1 not copied')).toBeInTheDocument();
  });

  it('the checked line is hidden while every card is hidden', async () => {
    load({ parents: [parent(2, 'deceased')] });
    renderPage();
    await screen.findByRole('heading', { name: 'Family Contacts' });
    expect(screen.queryByText(/against PowerSchool/)).not.toBeInTheDocument();
    await showAlerts(1);
    expect(screen.getByText('Checked against PowerSchool 20/10/2026')).toBeInTheDocument();
  });

  it('feature off: the extra email shows and is copied', async () => {
    getStudent.mockResolvedValue({ ...base, parents: [{
      id: 1, first_name: 'Guardian', last_name: 'Number1', email: 'guardian1@example.test', relationship: null,
      phone: '0000 2002', extra_email: 'extra1@example.test',
    }] });
    const { container } = renderPage();
    await screen.findByText('Guardian Number1');
    expect(links(container, 'mailto')).toEqual(['mailto:guardian1@example.test', 'mailto:extra1@example.test']);
    expect(links(container, 'tel')).toEqual(['tel:0000 2002']);
    expect(screen.getAllByText('Added in Prism')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Copy all emails' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('Guardian Number1 <guardian1@example.test>; Guardian Number1 <extra1@example.test>'));
  });
});
