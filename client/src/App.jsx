import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { useState } from 'react';
import Dashboard from './pages/Dashboard.jsx';
import CoursePage from './pages/CoursePage.jsx';
import StudentPage from './pages/StudentPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import ImportPage from './pages/ImportPage.jsx';
import ToolsPage from './pages/ToolsPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import FeedbackPage from './pages/FeedbackPage.jsx';
import { triggerSync, getSyncStatus } from './services/api.js';
import './app.css';

export default function App() {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await triggerSync();
      setSyncResult({ success: true, records: result.records });
    } catch (err) {
      setSyncResult({ success: false, error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <h1 className="logo">Prism</h1>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/search">Search Students</NavLink>
          <NavLink to="/feedback">Feedback Review</NavLink>
          <NavLink to="/tools">Class Tools</NavLink>
          <NavLink to="/import">Import CSV</NavLink>
          <div className="sidebar-spacer" />
          <button className="sync-btn" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Schoology'}
          </button>
          {syncResult && (
            <div className={`sync-result ${syncResult.success ? 'success' : 'error'}`}>
              {syncResult.success
                ? `Synced ${syncResult.records} records`
                : `Error: ${syncResult.error}`}
            </div>
          )}
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/course/:id" element={<CoursePage />} />
            <Route path="/course/:id/analytics" element={<AnalyticsPage />} />
            <Route path="/student/:id" element={<StudentPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/feedback" element={<FeedbackPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/import" element={<ImportPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
