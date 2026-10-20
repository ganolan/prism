import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncHelp from './SyncHelp.jsx';

const LIVE = 'Courses, students, grades and submissions: refreshed when you open a page, if older than 10 minutes.';
const label = (button, text) => `Prism keeps this up to date for you. ${LIVE} ${text} Press ${button} only if you changed something in Schoology just now.`;

function open(props) {
  const { container } = render(<SyncHelp {...props} />);
  fireEvent.click(container.querySelector('.help-dot'));
  return container;
}

describe('SyncHelp', () => {
  it('nightly on: blocks, calendar and alerts are refreshed every night', () => {
    const c = open({ button: 'Sync Course', nightly: true });
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', label('Sync Course', 'Blocks, calendar and alerts: refreshed every night.'));
    const pop = c.querySelector('.help-pop');
    expect(pop.querySelectorAll('ul > li')).toHaveLength(2);
    expect([...pop.querySelectorAll('strong')].map((n) => n.textContent)).toEqual([
      'Courses, students, grades and submissions:', 'Blocks, calendar and alerts:',
    ]);
    expect(pop).toHaveTextContent('Prism keeps this up to date for you.');
    expect(pop).toHaveTextContent('Press Sync Course only if you changed something in Schoology just now.');
  });

  it('nightly off on the dashboard: the second bullet is the dashboard button', () => {
    open({ button: 'Sync Courses', nightly: false, onDashboard: true });
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', label('Sync Courses', 'Blocks, calendar and alerts: refreshed when you press Sync Courses.'));
  });

  it('nightly off on another page: the second bullet points to the dashboard', () => {
    open({ button: 'Sync Assignment', nightly: false });
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', label('Sync Assignment', 'Blocks, calendar and alerts: refreshed when you press Sync Courses on the dashboard.'));
  });

  it('names no system but Schoology, in the last line only', () => {
    const c = open({ button: 'Sync Courses', nightly: true });
    const text = c.querySelector('.help-pop').textContent;
    expect(text).not.toMatch(/PowerSchool/);
    expect(text.match(/Schoology/g)).toHaveLength(1);
    expect(text).not.toMatch(/—/);
  });

  describe('archived (final review ruling): no automatic refresh, and how to read it again', () => {
    const ARCHIVED = 'Prism does not refresh past courses automatically.';
    it.each([
      ['the dashboard\'s Archived tab', { archived: true, onDashboard: true }, 'Open a course and press Sync Course to read it again.'],
      ['an archived course page', { archived: true, button: 'Sync Course' }, 'Press Sync Course to read it again.'],
      ['an archived assessment page', { archived: true, button: 'Sync Assignment' }, 'Press Sync Assignment to read it again.'],
    ])('%s', (_, props, second) => {
      const c = open(props);
      expect(screen.getByRole('img')).toHaveAttribute('aria-label', `${ARCHIVED} ${second}`);
      const pop = c.querySelector('.help-pop');
      expect(pop.querySelector('ul')).toBeNull(); // no bullets
      expect(pop.querySelector('.sync-help__intro')).toHaveTextContent(ARCHIVED);
      expect(pop.querySelector('.sync-help__last')).toHaveTextContent(second);
      expect(pop.textContent).not.toMatch(/—|nightly|every night/);
    });
  });
});
