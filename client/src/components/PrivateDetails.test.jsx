// The app-wide Private details switch (#197): in the sidebar, its state in the phone's top bar, and the
// box that stands in place of private content.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrivateDetailsSwitch, PrivateDetailsState, PrivateHidden } from './PrivateDetails.jsx';
import { setPrivateDetails, setPrivateDetailsDefault } from '../lib/privateDetails.js';

beforeEach(() => { setPrivateDetailsDefault(false); localStorage.clear(); });
afterEach(() => { setPrivateDetailsDefault(true); });

describe('Private details', () => {
  it('is off by default; the switch turns it on and off, and the top bar follows', () => {
    render(<><PrivateDetailsSwitch /><PrivateDetailsState /></>);
    const sw = screen.getByRole('button', { name: 'Private details' });
    expect(sw).toHaveAttribute('aria-pressed', 'false');
    expect(sw).toHaveTextContent('Off');
    expect(screen.getByRole('status')).toHaveTextContent('Private details off');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-pressed', 'true');
    expect(sw).toHaveTextContent('On');
    expect(screen.getByRole('status')).toHaveTextContent('Private details on');
    expect(screen.getByRole('status')).toHaveClass('private-details-state--on');
    expect(localStorage.getItem('prism:private-details')).toBe('true');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-pressed', 'false');
  });

  it('explains itself in an instant popover on hover, never a native title', () => {
    render(<PrivateDetailsSwitch />);
    const sw = screen.getByRole('button', { name: 'Private details' });
    expect(sw).not.toHaveAttribute('title');
    fireEvent.mouseEnter(sw);
    expect(document.querySelector('.help-pop')).toHaveTextContent(/Keep it off while the screen is projected\./);
    fireEvent.mouseLeave(sw);
    expect(document.querySelector('.help-pop')).toBeNull();
  });

  it('a stored choice is used on the next visit', () => {
    setPrivateDetails(true);
    render(<PrivateDetailsSwitch />);
    expect(screen.getByRole('button', { name: 'Private details' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the box names what is withheld and the switch that shows it', () => {
    render(<PrivateHidden title="Grades are private." />);
    expect(screen.getByText('Grades are private.')).toBeInTheDocument();
    expect(screen.getByText('Turn on Private details in the side menu to see it. It stays hidden so the page is safe to project.')).toBeInTheDocument();
  });
});
