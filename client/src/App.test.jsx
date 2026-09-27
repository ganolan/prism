// The app shell's phone menu. Below 768px the sidebar becomes a drawer that a
// top-bar button opens; the CSS does the hiding, so these tests pin the state
// the CSS keys off (`.app.nav-open`) and the ways the drawer closes again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App.jsx';
import { ThemeProvider } from './hooks/useTheme.jsx';

// The shell is under test, not the pages — stub each one out.
vi.mock('./pages/Dashboard.jsx', () => ({ default: () => <h2>Dashboard page</h2> }));
vi.mock('./pages/SearchPage.jsx', () => ({ default: () => <h2>Search page</h2> }));
vi.mock('./pages/PeoplePage.jsx', () => ({ default: () => <h2>People page</h2> }));
vi.mock('./pages/CoursePage.jsx', () => ({ default: () => null }));
vi.mock('./pages/StudentPage.jsx', () => ({ default: () => null }));
vi.mock('./pages/ImportPage.jsx', () => ({ default: () => null }));
vi.mock('./pages/ToolsPage.jsx', () => ({ default: () => null }));
vi.mock('./pages/AnalyticsPage.jsx', () => ({ default: () => null }));
vi.mock('./pages/FeedbackPage.jsx', () => ({ default: () => null }));
vi.mock('./pages/AssessmentSummaryPage.jsx', () => ({ default: () => null }));
vi.mock('./components/SyncDialog.jsx', () => ({ default: () => <div>Sync dialog</div> }));
vi.mock('./components/VersionBadge.jsx', () => ({ default: () => null }));

const renderApp = () => render(<ThemeProvider><App /></ThemeProvider>);
const menuButton = () => screen.getByRole('button', { name: 'Menu' });
const shell = (container) => container.querySelector('.app');

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

describe('App shell — phone menu', () => {
  it('starts with the menu closed', () => {
    const { container } = renderApp();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(shell(container)).not.toHaveClass('nav-open');
  });

  it('points the menu button at the sidebar it controls', () => {
    renderApp();
    const nav = screen.getByRole('navigation');
    expect(menuButton()).toHaveAttribute('aria-controls', nav.id);
  });

  it('opens the menu from the top-bar button', () => {
    const { container } = renderApp();
    fireEvent.click(menuButton());
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    expect(shell(container)).toHaveClass('nav-open');
  });

  it('closes the menu once a link is followed', async () => {
    const { container } = renderApp();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('link', { name: 'Directory' }));
    expect(await screen.findByText('People page')).toBeInTheDocument();
    expect(shell(container)).not.toHaveClass('nav-open');
  });

  it('closes the menu when the backdrop is tapped', () => {
    const { container } = renderApp();
    fireEvent.click(menuButton());
    fireEvent.click(container.querySelector('.nav-backdrop'));
    expect(shell(container)).not.toHaveClass('nav-open');
  });

  it('closes the menu on Escape', () => {
    const { container } = renderApp();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shell(container)).not.toHaveClass('nav-open');
  });

  it('closes the menu when Sync opens its dialog', () => {
    const { container } = renderApp();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(screen.getByText('Sync dialog')).toBeInTheDocument();
    expect(shell(container)).not.toHaveClass('nav-open');
  });
});
