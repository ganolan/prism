// Remote sign-in (#136): the server's Microsoft sign-in shown as a picture; taps and
// typed text go to the server's page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RemoteSignIn from './RemoteSignIn.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:screen');
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.mocked(api.startRemoteLogin).mockResolvedValue({ status: 'active', host: 'login.microsoftonline.com' });
  vi.mocked(api.getRemoteLoginScreen).mockResolvedValue({ image: new Blob(['x'], { type: 'image/jpeg' }) });
  vi.mocked(api.remoteLoginClick).mockResolvedValue({ status: 'active' });
  vi.mocked(api.remoteLoginType).mockResolvedValue({ status: 'active' });
  vi.mocked(api.remoteLoginKey).mockResolvedValue({ status: 'active' });
  vi.mocked(api.stopRemoteLogin).mockResolvedValue({ status: 'stopped' });
});
afterEach(() => vi.useRealTimers());

describe('RemoteSignIn', () => {
  it('starts the sign-in and shows the server page', async () => {
    render(<RemoteSignIn onClose={vi.fn()} />);
    const img = await screen.findByRole('img', { name: /sign-in page on the server/i });
    expect(img).toHaveAttribute('src', 'blob:screen');
    expect(api.startRemoteLogin).toHaveBeenCalledTimes(1);
  });

  it('a tap on the picture is sent in page pixels', async () => {
    render(<RemoteSignIn onClose={vi.fn()} />);
    const img = await screen.findByRole('img', { name: /sign-in page/i });
    // Shown at half size: 200 x 360 on screen for a 400 x 720 page.
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 360 });
    fireEvent.click(img, { clientX: 60, clientY: 120 });
    await waitFor(() => expect(api.remoteLoginClick).toHaveBeenCalledWith(100, 200));
  });

  it('typed text is sent, then the field clears; it is hidden until shown', async () => {
    render(<RemoteSignIn onClose={vi.fn()} />);
    const field = await screen.findByLabelText('Text to type');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show' }));
    expect(field).toHaveAttribute('type', 'text');
    fireEvent.change(field, { target: { value: 'teacher@school.edu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type it' }));
    await waitFor(() => expect(api.remoteLoginType).toHaveBeenCalledWith('teacher@school.edu'));
    expect(field).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(api.remoteLoginKey).toHaveBeenCalledWith('Enter'));
  });

  it('when the server lands signed in, says so and reports done', async () => {
    vi.mocked(api.getRemoteLoginScreen).mockResolvedValue({ state: { status: 'done' } });
    const onClose = vi.fn();
    render(<RemoteSignIn onClose={onClose} />);
    expect(await screen.findByText(/Signed in\. Prism saved the session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
    expect(api.stopRemoteLogin).not.toHaveBeenCalled();
  });

  it('a sign-in that timed out offers to start again', async () => {
    vi.mocked(api.getRemoteLoginScreen).mockResolvedValue({ state: { status: 'timed_out', message: 'The sign-in was left too long and closed' } });
    render(<RemoteSignIn onClose={vi.fn()} />);
    expect(await screen.findByText(/left too long/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(api.startRemoteLogin).toHaveBeenCalledTimes(2));
  });

  it('Cancel closes the server browser', async () => {
    const onClose = vi.fn();
    render(<RemoteSignIn onClose={onClose} />);
    await screen.findByRole('img', { name: /sign-in page/i });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(api.stopRemoteLogin).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
