import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TriageSection from './TriageSection.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
  recordExtension: vi.fn(),
  undoExtension: vi.fn(),
  getExtensions: vi.fn(),
}));

const SETTINGS = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false };
const PAYLOAD = {
  settings: SETTINGS, includeFormative: false, historyCount: 2, lastSyncAt: '2026-10-01 07:42:00',
  calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
  lateWork: [
    { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false },
    { kind: 'submitted_late', studentId: 2, studentName: 'Ethan Wong', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, submittedOn: '2026-10-05', tone: 'red', approx: false },
    { kind: 'outstanding', studentId: 3, studentName: 'Aiden Li', courseId: 6, courseName: 'AP CSP', blockNumber: '7', assignmentId: 10, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-14', daysLate: 2, tone: 'green', approx: false, extension: { id: 4, lessons: 3, until: '2026-10-15', note: null } },
  ],
  feedbackOwed: [
    { assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 6, courseName: 'AP CSP', blockNumber: '7', title: 'Model Card', dueDate: '2026-09-14', aligned: true, owed: 18, submittedTotal: 22, oldestWaitDays: 11, tone: 'red', approx: false },
  ],
};

function renderSection(props = {}) {
  return render(<MemoryRouter><TriageSection {...props} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTriage.mockResolvedValue(PAYLOAD);
  api.recordReferral.mockResolvedValue({ id: 1 });
  api.recordExtension.mockResolvedValue({ id: 2 });
  api.getReferrals.mockResolvedValue([]);
  api.getExtensions.mockResolvedValue([]);
});

describe('TriageSection', () => {
  it('renders both panels with counts, tags and course chips (all-courses view)', async () => {
    renderSection();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('2 at referral limit')).toBeInTheDocument();
    expect(screen.getByText('submitted day 10')).toBeInTheDocument();
    expect(screen.getByText('6 left')).toBeInTheDocument();
    expect(screen.getByText('18 of 22 ungraded')).toBeInTheDocument();
    expect(screen.getAllByText('AP CSP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('[BK 7] AP CSP')).toHaveLength(2); // one late row + one feedback row
    expect(screen.getByText('ext +3 → 15/10/2026')).toBeInTheDocument();
    expect(screen.getByText(/Referred \/ extended \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('Summative work late or submitted after the limit · school days since due · refer at 8')).toBeInTheDocument();
  });

  it('hides course chips on a course page and passes courseId', async () => {
    renderSection({ courseId: 5 });
    await screen.findByText('Maya Chen');
    expect(api.getTriage).toHaveBeenCalledWith({ courseId: 5, includeFormative: undefined });
    expect(screen.queryByText('AP CSP')).not.toBeInTheDocument();
    expect(screen.queryByText('[BK 7] AP CSP')).not.toBeInTheDocument();
  });

  it('Mark referred posts and reloads', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Mark referred'))[0]);
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'referred', note: undefined }));
    expect(api.getTriage).toHaveBeenCalledTimes(2);
  });

  it('every row offers Extend; Mark referred only on red rows; no Exempt', async () => {
    renderSection();
    expect(await screen.findAllByText('Extend')).toHaveLength(3);
    expect(screen.getAllByText('Mark referred')).toHaveLength(2);
    expect(screen.queryByText('Exempt')).not.toBeInTheDocument();
  });

  it('Extend posts N lessons (default 3) and a note, then reloads', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Extend'))[2]); // the green row
    const lessons = screen.getByLabelText('Extension (lessons)');
    expect(lessons).toHaveValue(3);
    expect(lessons).toHaveAttribute('max', '60');
    fireEvent.click(screen.getByLabelText('Increase'));
    fireEvent.change(screen.getByLabelText('Extension note'), { target: { value: 'sick week' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 3, assignmentId: 10, lessons: 4, note: 'sick week' }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
  });

  it('Extend → Cancel closes the editor without posting', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Extend'))[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
    expect(api.recordExtension).not.toHaveBeenCalled();
  });

  it('Show formative refetches with includeFormative true', async () => {
    renderSection();
    fireEvent.click(await screen.findByLabelText('Show formative'));
    await waitFor(() => expect(api.getTriage).toHaveBeenLastCalledWith({ courseId: null, includeFormative: true }));
  });

  it('hands the payload to onLoaded', async () => {
    const onLoaded = vi.fn();
    renderSection({ onLoaded });
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(PAYLOAD));
  });

  it('renders nothing when the API yields no payload', async () => {
    api.getTriage.mockResolvedValue(undefined);
    const { container } = renderSection();
    await waitFor(() => expect(api.getTriage).toHaveBeenCalled());
    expect(container.querySelector('.triage')).toBeNull();
  });

  it('history rows show the block; a failed undo shows the error inline', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', blockNumber: '7', title: 'CP2', note: null },
    ]);
    api.undoReferral.mockRejectedValue(new Error('Server unreachable'));
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('[BK 7] AP CSP')).toBeInTheDocument();
    fireEvent.click(within(history).getByText('Undo'));
    const alert = await within(history).findByText(/Server unreachable/);
    expect(alert.closest('.alert')).toHaveClass('alert-warning');
    expect(within(history).getByText('Maya Chen')).toBeInTheDocument(); // the row stays
  });

  it('history lists referrals and extensions; Undo on an extension calls undoExtension', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    api.getExtensions.mockResolvedValue([
      { id: 7, lessons: 3, until: '2026-10-15', createdAt: '2026-10-02 01:00:00', studentName: 'Aiden Li', courseName: 'AP CSP', title: 'CP2', note: 'sick' },
    ]);
    api.undoExtension.mockResolvedValue({ deleted: true });
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended +3 → 15/10/2026')).toBeInTheDocument();
    expect(within(history).getByText('Referred · day 9')).toBeInTheDocument();
    // Newest first: the extension (02/10) above the referral (01/10).
    expect(within(history).getAllByText(/Aiden Li|Maya Chen/).map((el) => el.textContent)).toEqual(['Aiden Li', 'Maya Chen']);
    fireEvent.click(within(history).getAllByText('Undo')[0]);
    await waitFor(() => expect(api.undoExtension).toHaveBeenCalledWith(7));
    expect(api.undoReferral).not.toHaveBeenCalled();
  });

  it('an open history reloads after Mark referred', async () => {
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByText('Mark referred')[0]);
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(2));
  });
});
