import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PsAlertBadges from './PsAlertBadges.jsx';

const ALERTS = [
  { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' },
  { key: 'epipen', label: 'EpiPen', category: 'health' },
  { key: 'no_photo', label: 'No photo', category: 'other' },
  { key: 'ilp', label: 'ILP', category: 'learning', title: 'Individual learning plan' },
];

describe('PsAlertBadges (#117)', () => {
  it('renders one badge per alert, coloured by category, in a labelled group', () => {
    render(<PsAlertBadges alerts={ALERTS} />);
    expect(screen.getByLabelText('PowerSchool alerts')).toBeInTheDocument();
    expect(screen.getByText('Accommodation plan')).toHaveClass('badge', 'badge-blue');
    expect(screen.getByText('EpiPen')).toHaveClass('badge', 'badge-amber');
    expect(screen.getByText('No photo')).toHaveClass('badge', 'badge-gray');
  });

  it('family alerts are pink', () => {
    render(<PsAlertBadges alerts={[{ key: 'siblings', label: 'Siblings', category: 'family' }]} />);
    expect(screen.getByText('Siblings')).toHaveClass('badge', 'badge-pink');
  });

  it('names the source, and the read date day-first, on hover', () => {
    render(<PsAlertBadges alerts={ALERTS} syncedAt="2026-10-07T03:00:00.000Z" />);
    expect(screen.getByText('ILP')).toHaveAttribute('aria-label', 'Individual learning plan. From PowerSchool, read 07/10/2026');
    expect(screen.getByText('EpiPen')).toHaveAttribute('aria-label', 'EpiPen. From PowerSchool, read 07/10/2026');
  });

  it('renders nothing for no alerts, or when the feature is off (no field)', () => {
    const { container: none } = render(<PsAlertBadges alerts={[]} />);
    expect(none).toBeEmptyDOMElement();
    const { container: off } = render(<PsAlertBadges alerts={undefined} />);
    expect(off).toBeEmptyDOMElement();
  });
});
