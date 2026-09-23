import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import VersionBadge from './VersionBadge.jsx';
import { getVersion } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getVersion: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VersionBadge', () => {
  it('shows the short sha of a deployed release', async () => {
    getVersion.mockResolvedValue({
      sha: '1e96c01abcdef',
      builtAt: '2026-09-23T01:06:43Z',
      mode: 'release',
    });

    render(<VersionBadge />);

    expect(await screen.findByText('1e96c01')).toBeInTheDocument();
  });

  it('formats the build date the way the user reads dates (en-GB)', async () => {
    getVersion.mockResolvedValue({
      sha: '1e96c01',
      builtAt: '2026-09-23T01:06:43Z',
      mode: 'release',
    });

    render(<VersionBadge />);

    // Computed rather than hardcoded so the test does not depend on the
    // runner's timezone — but still pins DD/MM/YYYY: an en-US component would
    // render 9/23/2026, which does not contain this string.
    const expected = new Date('2026-09-23T01:06:43Z').toLocaleDateString('en-GB');
    const badge = await screen.findByText('1e96c01');
    expect(badge).toHaveAttribute('title', expect.stringContaining(expected));
  });

  it('says dev on a clone with no release deployed', async () => {
    getVersion.mockResolvedValue({ sha: null, builtAt: null, mode: 'dev' });

    render(<VersionBadge />);

    expect(await screen.findByText('dev')).toBeInTheDocument();
  });

  it('renders nothing when the server cannot be reached', async () => {
    getVersion.mockRejectedValue(new Error('Failed to fetch'));

    const { container } = render(<VersionBadge />);

    await waitFor(() => expect(getVersion).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
