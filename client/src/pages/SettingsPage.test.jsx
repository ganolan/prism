import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from './SettingsPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getTriage: vi.fn(),
}));

const TRIAGE = {
  referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDays: 1, makeUpRedDays: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ triage: TRIAGE });
  api.updateSettings.mockImplementation(async ({ triage }) => ({ triage: { ...TRIAGE, ...triage } }));
  api.getTriage.mockResolvedValue({ calendar: { source: 'powerschool', totalSchoolDays: 164, syncedAt: '2026-10-01T00:00:00Z' } });
});

describe('SettingsPage', () => {
  it('shows the triage limits and the calendar status', async () => {
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Referral limit (school days)')).toHaveValue(8);
    expect(screen.getByLabelText('Feedback limit (school days)')).toHaveValue(10);
    expect(await screen.findByText(/PowerSchool · 164 school days/)).toBeInTheDocument();
  });

  it('saves a stepper change server-side', async () => {
    render(<SettingsPage />);
    await screen.findByLabelText('Referral limit (school days)');
    fireEvent.click(screen.getAllByLabelText('Increase')[0]);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { referralLimitDays: 9 } }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('make-up clock: amber and red steppers (amber can\'t pass red), saved server-side', async () => {
    render(<SettingsPage />);
    const amber = await screen.findByLabelText('Make-up amber (school days)');
    const red = screen.getByLabelText('Make-up red (school days)');
    expect(amber).toHaveValue(1);
    expect(amber).toHaveAttribute('min', '0');
    expect(amber).toHaveAttribute('max', '3'); // capped at the red value
    expect(red).toHaveValue(3);
    expect(red).toHaveAttribute('max', '30');
    fireEvent.change(red, { target: { value: '5' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { makeUpRedDays: 5 } }));
    await waitFor(() => expect(amber).toHaveAttribute('max', '5'));
  });

  it('warns when there is no PowerSchool calendar', async () => {
    api.getTriage.mockResolvedValue({ calendar: { source: 'weekdays', totalSchoolDays: 0, syncedAt: null } });
    render(<SettingsPage />);
    expect(await screen.findByText(/counting weekdays/)).toBeInTheDocument();
  });

  it('reverts the value and shows error when updateSettings rejects', async () => {
    api.updateSettings.mockRejectedValue(new Error('Server error'));
    render(<SettingsPage />);
    const input = await screen.findByLabelText('Referral limit (school days)');
    expect(input).toHaveValue(8);
    fireEvent.click(screen.getAllByLabelText('Increase')[0]);
    await waitFor(() => expect(input).toHaveValue(8));
    expect(await screen.findByText(/Not saved: Server error/)).toBeInTheDocument();
  });
});
