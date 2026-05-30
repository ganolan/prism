import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { useState } from 'react';
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
import { useTheme } from './hooks/useTheme.jsx';
import SyncDialog from './components/SyncDialog.jsx';
import './app.css';

export default function App() {
  const [syncOpen, setSyncOpen] = useState(false);
  const { theme, setTheme, themes } = useTheme();

  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <h1 className="logo">Prism</h1>
          <div className="sidebar-section-label">Navigation</div>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/search">Search Students</NavLink>
          <NavLink to="/people">Directory</NavLink>
          <div className="sidebar-section-label">Tools</div>
          <NavLink to="/feedback">Feedback Review</NavLink>
          <NavLink to="/tools">Class Tools</NavLink>
          <NavLink to="/import">Import CSV</NavLink>
          <div className="sidebar-spacer" />
          <button className="sync-btn" onClick={() => setSyncOpen(true)}>
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
          </Routes>
        </main>
        {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}
      </div>
    </BrowserRouter>
  );
}
