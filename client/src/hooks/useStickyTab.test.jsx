import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { useStickyTab } from './useStickyTab.js';

beforeEach(() => {
  sessionStorage.clear();
});

// A stand-in for a tabbed page: shows the active tab, can switch tabs, can
// navigate away and back the two ways a user does it (a plain Link, and the
// browser back button — `navigate(-1)`).
function TabbedPage({ storageKey = 'course', fallback = 'roster', param = 'tab' }) {
  const [tab, setTab] = useStickyTab(storageKey, fallback, { param });
  const navigate = useNavigate();
  const { search } = useLocation();
  return (
    <div>
      <span data-testid="tab">{tab}</span>
      <span data-testid="search">{search}</span>
      <button onClick={() => setTab('gradebook')}>pick gradebook</button>
      <Link to="/assessment/9">open assessment</Link>
      <button onClick={() => navigate(-1)}>browser back</button>
    </div>
  );
}

function AssessmentPage() {
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="assessment">assessment</span>
      <Link to="/course/5">Back to course</Link>
      <button onClick={() => navigate(-1)}>browser back</button>
    </div>
  );
}

function renderApp({ entries = ['/course/5'], index } = {}) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/course/5" element={<TabbedPage />} />
        <Route path="/assessment/9" element={<AssessmentPage />} />
        <Route path="/elsewhere" element={<span data-testid="elsewhere">elsewhere</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useStickyTab — reading the active tab', () => {
  it('falls back to the default when the URL and sessionStorage are both empty', () => {
    renderApp();
    expect(screen.getByTestId('tab')).toHaveTextContent('roster');
  });

  it('reads the tab from the URL query param', () => {
    renderApp({ entries: ['/course/5?tab=assessments'] });
    expect(screen.getByTestId('tab')).toHaveTextContent('assessments');
  });

  it('falls back to the remembered tab when the URL has no param', () => {
    sessionStorage.setItem('prism.tab.course', 'analytics');
    renderApp();
    expect(screen.getByTestId('tab')).toHaveTextContent('analytics');
  });

  it('prefers the URL param over the remembered tab', () => {
    sessionStorage.setItem('prism.tab.course', 'analytics');
    renderApp({ entries: ['/course/5?tab=gradebook'] });
    expect(screen.getByTestId('tab')).toHaveTextContent('gradebook');
  });

  it('honours a custom param name', () => {
    render(
      <MemoryRouter initialEntries={['/x?view=compact']}>
        <TabbedPage storageKey="assessment-view" fallback="descriptors" param="view" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('tab')).toHaveTextContent('compact');
  });
});

describe('useStickyTab — writing the active tab', () => {
  it('puts the chosen tab in the URL so it can be linked', () => {
    renderApp();
    fireEvent.click(screen.getByText('pick gradebook'));
    expect(screen.getByTestId('tab')).toHaveTextContent('gradebook');
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=gradebook');
  });

  it('remembers the chosen tab for pages reached without a param', () => {
    renderApp();
    fireEvent.click(screen.getByText('pick gradebook'));
    expect(sessionStorage.getItem('prism.tab.course')).toBe('gradebook');
  });

  it('preserves unrelated query params already on the URL', () => {
    renderApp({ entries: ['/course/5?student=42'] });
    fireEvent.click(screen.getByText('pick gradebook'));
    expect(screen.getByTestId('search').textContent).toContain('student=42');
    expect(screen.getByTestId('search').textContent).toContain('tab=gradebook');
  });
});

describe('useStickyTab — getting back to the tab you were on', () => {
  it('restores the tab when the browser back button returns to the page', () => {
    renderApp();
    fireEvent.click(screen.getByText('pick gradebook'));
    fireEvent.click(screen.getByText('open assessment'));
    expect(screen.getByTestId('assessment')).toBeInTheDocument();

    // Wipe the remembered tab so only the URL can carry it back. Without this
    // the sessionStorage fallback would satisfy the assertion on its own and
    // the test would pass even if the tab never reached the URL.
    sessionStorage.clear();
    fireEvent.click(screen.getByText('browser back'));
    expect(screen.getByTestId('tab')).toHaveTextContent('gradebook');
  });

  it('restores the tab when a plain link returns to the page without a param', () => {
    renderApp();
    fireEvent.click(screen.getByText('pick gradebook'));
    fireEvent.click(screen.getByText('open assessment'));
    fireEvent.click(screen.getByText('Back to course'));
    expect(screen.getByTestId('tab')).toHaveTextContent('gradebook');
  });

  it('does not push a history entry per tab click, so back leaves the page', () => {
    renderApp({ entries: ['/elsewhere', '/course/5'], index: 1 });
    fireEvent.click(screen.getByText('pick gradebook'));
    fireEvent.click(screen.getByText('browser back'));
    // If tab changes pushed history, back would land on the roster tab instead.
    expect(screen.getByTestId('elsewhere')).toBeInTheDocument();
  });
});
