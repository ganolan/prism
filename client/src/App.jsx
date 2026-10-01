import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useState, useCallback, useEffect } from 'react';
import Dashboard from './pages/Dashboard.jsx';
import CoursePage from './pages/CoursePage.jsx';
import StudentPage from './pages/StudentPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import PeoplePage from './pages/PeoplePage.jsx';
import ImportPage from './pages/ImportPage.jsx';
import ToolsPage from './pages/ToolsPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import FeedbackPage from './pages/FeedbackPage.jsx';
import AssessmentSummaryPage from './pages/AssessmentSummaryPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { useTheme } from './hooks/useTheme.jsx';
import { DataVersionContext } from './hooks/useDataVersion.jsx';
import SyncDialog from './components/SyncDialog.jsx';
import VersionBadge from './components/VersionBadge.jsx';
import PrismLogo from './components/PrismLogo.jsx';
import './app.css';

export default function App() {
  // Bumped when a sync completes; data pages depend on it to re-fetch (#…).
  const [dataVersion, setDataVersion] = useState(0);
  const bumpDataVersion = useCallback(() => setDataVersion((v) => v + 1), []);

  return (
    <DataVersionContext.Provider value={dataVersion}>
    <BrowserRouter>
      <Shell onSyncComplete={bumpDataVersion} />
    </BrowserRouter>
    </DataVersionContext.Provider>
  );
}

// Inside the router so the phone menu can close itself on navigation.
function Shell({ onSyncComplete }) {
  const [syncOpen, setSyncOpen] = useState(false);
  // Phone menu: below 768px the sidebar is a drawer (app.css). On desktop the
  // top bar and backdrop are hidden, so this state changes nothing visible.
  const [navOpen, setNavOpen] = useState(false);
  const { theme, setTheme, themes } = useTheme();
  const location = useLocation();

  useEffect(() => { setNavOpen(false); }, [location]);

  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <header className="mobile-topbar">
        <button
          type="button"
          className="menu-btn"
          aria-label="Menu"
          aria-expanded={navOpen}
          aria-controls="sidebar-nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <PrismLogo width={110} className="mobile-topbar-logo" />
      </header>
      <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
      <nav className="sidebar" id="sidebar-nav">
        <h1 className="logo"><PrismLogo /></h1>
        <div className="sidebar-section-label">Navigation</div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/search">Search Students</NavLink>
        <NavLink to="/people">Directory</NavLink>
        <div className="sidebar-section-label">Tools</div>
        <NavLink to="/feedback">Feedback Review</NavLink>
        <NavLink to="/tools">Class Tools</NavLink>
        <NavLink to="/import">Import CSV</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="sidebar-spacer" />
        <button className="sync-btn" onClick={() => { setNavOpen(false); setSyncOpen(true); }}>
          Sync
        </button>
        <div className="theme-switcher">
          {Object.keys(themes).map(key => (
            <button
              key={key}
              className={`theme-dot ${theme === key ? 'active' : ''}`}
              data-theme={key}
              onClick={() => setTheme(key)}
              title={themes[key].description}
            />
          ))}
        </div>
        <VersionBadge />
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/course/:id" element={<CoursePage />} />
          <Route path="/course/:id/analytics" element={<AnalyticsPage />} />
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
          <Route path="/student/:id" element={<StudentPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      {syncOpen && (
        <SyncDialog
          onClose={() => setSyncOpen(false)}
          onSyncComplete={onSyncComplete}
        />
      )}
    </div>
  );
}
