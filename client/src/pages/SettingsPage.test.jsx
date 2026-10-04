import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SettingsPage from './SettingsPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getTriage: vi.fn(),
  getSyncRuns: vi.fn(),
  getSyncRun: vi.fn(),
  getMasteryLoginStatus: vi.fn(),
  triggerMasteryLogin: vi.fn(),
}));

const TRIAGE = {
  referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4,
  resubmitLessonsDefault: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ triage: TRIAGE });
  api.updateSettings.mockImplementation(async ({ triage }) => ({ triage: { ...TRIAGE, ...triage } }));
  api.getSyncRuns.mockResolvedValue([]);
  api.getTriage.mockResolvedValue({ calendar: { source: 'powerschool', totalSchoolDays: 164, syncedAt: '2026-10-01T00:00:00Z' } });
  api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected', checkedAt: '2026-10-03T06:05:00Z' });
  api.triggerMasteryLogin.mockResolvedValue({ success: true });
});

describe('SettingsPage', () => {
  it('shows the triage limits as day numbers (due date = day 1) and the calendar status', async () => {
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Referral limit (last allowed day)')).toHaveValue(8);
    expect(screen.getByLabelText('Feedback limit (last allowed day)')).toHaveValue(10);
    expect(screen.getByLabelText('Warning lead (school days)')).toHaveValue(3);
    expect(screen.getByText('Late work is allowed through day')).toBeInTheDocument();
    expect(screen.getByText('(due date = day 1); refer after day 8')).toBeInTheDocument();
    expect(screen.getByText('Feedback is overdue after day')).toBeInTheDocument();
    expect(screen.getByText('Amber warning covers the last')).toBeInTheDocument();
    expect(screen.getByText('allowed days')).toBeInTheDocument();
    expect(screen.getByText('Make-up tests turn amber on day')).toBeInTheDocument();
    expect(screen.getByText('and red on day')).toBeInTheDocument();
    expect(screen.getByText('(test day = day 1)')).toBeInTheDocument();
    expect(await screen.findByText(/PowerSchool · 164 school days/)).toBeInTheDocument();
  });

  it('saves a stepper change server-side', async () => {
    render(<SettingsPage />);
    await screen.findByLabelText('Referral limit (last allowed day)');
    fireEvent.click(screen.getAllByLabelText('Increase')[0]);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { referralLimitDays: 9 } }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('make-up clock: amber and red day steppers (amber can\'t pass red), saved server-side', async () => {
    render(<SettingsPage />);
    const amber = await screen.findByLabelText('Make-up amber (day)');
    const red = screen.getByLabelText('Make-up red (day)');
    expect(amber).toHaveValue(2);
    expect(amber).toHaveAttribute('min', '1');
    expect(amber).toHaveAttribute('max', '4'); // capped at the red value
    expect(red).toHaveValue(4);
    expect(red).toHaveAttribute('min', '2');
    expect(red).toHaveAttribute('max', '31');
    fireEvent.change(red, { target: { value: '5' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { makeUpRedDay: 5 } }));
    await waitFor(() => expect(amber).toHaveAttribute('max', '5'));
  });

  it('shows the resubmission deadline default and saves a change server-side', async () => {
    render(<SettingsPage />);
    const stepper = await screen.findByLabelText('Resubmission deadline (lessons)');
    expect(stepper).toHaveValue(3);
    expect(screen.getByText('Resubmission deadline (default)')).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Increase').find((btn) => btn.closest('.settings-row').textContent.includes('Resubmission deadline')));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { resubmitLessonsDefault: 4 } }));
  });

  it('warns when there is no PowerSchool calendar', async () => {
    api.getTriage.mockResolvedValue({ calendar: { source: 'weekdays', totalSchoolDays: 0, syncedAt: null } });
    render(<SettingsPage />);
    expect(await screen.findByText(/counting weekdays/)).toBeInTheDocument();
  });

  it('reverts the value and shows error when updateSettings rejects', async () => {
    api.updateSettings.mockRejectedValue(new Error('Server error'));
    render(<SettingsPage />);
    const input = await screen.findByLabelText('Referral limit (last allowed day)');
    expect(input).toHaveValue(8);
    fireEvent.click(screen.getAllByLabelText('Increase')[0]);
    await waitFor(() => expect(input).toHaveValue(8));
    expect(await screen.findByText(/Not saved: Server error/)).toBeInTheDocument();
  });

  it('shows the Recent syncs card', async () => {
    api.getSyncRuns.mockResolvedValue([
      { id: 1, started_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:01:00Z', status: 'failed', error_count: 1, warning_count: 0, options: {} },
    ]);
    render(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Recent syncs' })).toBeInTheDocument();
    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });
});

describe('SettingsPage — Schoology connection card', () => {
  const card = async () => screen.findByRole('region', { name: 'Schoology connection' });
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  it('is the #schoology anchor and shows "Connected · checked HH:MM"', async () => {
    render(<SettingsPage />);
    const c = await card();
    expect(c).toHaveAttribute('id', 'schoology');
    expect(await within(c).findByText(`Connected · checked ${hhmm('2026-10-03T06:05:00Z')}`)).toBeInTheDocument();
    expect(api.getMasteryLoginStatus).toHaveBeenCalledWith({ refresh: false });
  });

  it('Expired / Not set up', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired', checkedAt: '2026-10-03T06:05:00Z', message: 'bounced' });
    const { unmount } = render(<SettingsPage />);
    expect(await within(await card()).findByText('Expired')).toBeInTheDocument();
    unmount();
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: false, live: 'none', checkedAt: null });
    render(<SettingsPage />);
    const c = await card();
    expect(await within(c).findByText('Not set up')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
  });

  it("'unknown' (the check couldn't tell) is not shown as expired", async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'unknown', checkedAt: '2026-10-03T06:05:00Z', message: 'Could not reach Schoology' });
    render(<SettingsPage />);
    const c = await card();
    expect(await within(c).findByText("Couldn't check, try again")).toBeInTheDocument();
    expect(within(c).queryByText('Expired')).not.toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Check now' })).toBeInTheDocument();
  });

  it('Check now re-checks with refresh', async () => {
    render(<SettingsPage />);
    const c = await card();
    await within(c).findByText(/Connected/);
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired', checkedAt: '2026-10-03T06:30:00Z' });
    fireEvent.click(within(c).getByRole('button', { name: 'Check now' }));
    expect(api.getMasteryLoginStatus).toHaveBeenLastCalledWith({ refresh: true });
    expect(await within(c).findByText('Expired')).toBeInTheDocument();
  });

  it('Log in to Schoology opens the login on the server (says so), then refreshes the status', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired', checkedAt: null });
    let finish;
    api.triggerMasteryLogin.mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<SettingsPage />);
    const c = await card();
    expect(within(c).getByText("Opens a Schoology login window on the server. Screen-share to it if you're away.")).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Mac mini|#136/);
    fireEvent.click(within(c).getByRole('button', { name: 'Log in to Schoology' }));
    expect(api.triggerMasteryLogin).toHaveBeenCalledTimes(1);
    expect(within(c).getByRole('button', { name: 'Waiting for login…' })).toBeDisabled();
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected', checkedAt: '2026-10-03T07:00:00Z' });
    finish({ success: true });
    expect(await within(c).findByText(/^Connected/)).toBeInTheDocument();
    expect(api.getMasteryLoginStatus).toHaveBeenLastCalledWith({ refresh: true });
    expect(within(c).getByText('Login saved.')).toBeInTheDocument();
  });
});

