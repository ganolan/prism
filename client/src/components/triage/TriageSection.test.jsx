import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TriageSection from './TriageSection.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
}));

const SETTINGS = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false };
const PAYLOAD = {
  settings: SETTINGS, includeFormative: false, referralCount: 2, lastSyncAt: '2026-10-01 07:42:00',
  calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
  lateWork: [
    { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false },
    { kind: 'submitted_late', studentId: 2, studentName: 'Ethan Wong', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, submittedOn: '2026-10-05', tone: 'red', approx: false },
    { kind: 'outstanding', studentId: 3, studentName: 'Aiden Li', courseId: 6, courseName: 'AP CSP', blockNumber: '7', assignmentId: 10, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-14', daysLate: 2, tone: 'green', approx: false },
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
    expect(screen.getByText(/Referred \/ exempt \(2\)/)).toBeInTheDocument();
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

  it('Exempt takes an optional note', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Exempt'))[0]);
    fireEvent.change(screen.getByLabelText('Exemption note'), { target: { value: 'agreed extension' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'exempt', note: 'agreed extension' }));
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
});
