import { useState } from 'react';
import { searchPeople } from '../services/api.js';
import { useFeatureFlags } from '../hooks/useFeatureFlags.js';
import { Link } from 'react-router-dom';
import PersonSub from '../components/PersonSub.jsx';
import PersonAvatar, { SCHOOLOGY } from '../components/PersonAvatar.jsx';

export default function PeoplePage() {
  const { features, loading: flagsLoading } = useFeatureFlags();
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const enabled = features.people_search;

  const runSearch = async (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setNeedsLogin(false);
    setData(null);
    try {
      const res = await searchPeople(q);
      setData(res);
    } catch (err) {
      if (/session expired|mastery:login/i.test(err.message)) setNeedsLogin(true);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!flagsLoading && !enabled) {
    return (
      <div className="fade-in">
        <h2 className="page-title">Directory</h2>
        <p className="alert alert-warning">
          People search is disabled. Enable <code>people_search</code> in <code>config.yaml</code> to use it.
        </p>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <h2 className="page-title">Directory</h2>
      <p className="text-muted" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>
        Search the whole school, including people who aren’t in your classes.
      </p>

      <form onSubmit={runSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input
          type="search"
          placeholder="Search by name…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ maxWidth: '400px', flex: '1 1 auto' }}
          autoFocus
        />
        <button type="submit" className="primary" disabled={loading || !query.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {needsLogin && (
        <p className="alert alert-warning">
          Schoology session expired. Run <code>npm run mastery:login</code> in a terminal, then search again.
        </p>
      )}
      {error && !needsLogin && <p className="alert alert-warning">{error}</p>}
      {loading && <p className="text-muted">Searching Schoology…</p>}

      {data && !loading && (
        <div className="card">
          {data.results.length === 0 ? (
            <p className="text-muted">No people found for “{data.query}”.</p>
          ) : (
            <>
              {!data.complete && (
                <p className="text-sm text-muted" style={{ marginBottom: '0.75rem' }}>
                  Showing the first {data.results.length} matches, refine your search to narrow it down.
                </p>
              )}
              <table className="fits-phone">
                <thead>
                  <tr><th></th><th>Name</th><th className="col-desktop">School</th><th></th></tr>
                </thead>
                <tbody>
                  {data.results.map(p => (
                    <tr key={p.userId}>
                      <td style={{ width: '44px', padding: '0.25rem 0.5rem' }}>
                        <PersonAvatar name={p.name} photoUrl={p.photoUrl} />
                      </td>
                      <td>
                        {/* #203: Prism's own profile page (a Prism student opens their student page). */}
                        <Link className="link" to={`/people/${p.userId}`}>{p.name || `User ${p.userId}`}</Link>
                        <PersonSub parts={[p.school]} />
                      </td>
                      <td className="text-sm text-muted col-desktop">{p.school || '-'}</td>
                      <td className="text-sm">
                        {p.messageUserId && (
                          <a className="link" href={`${SCHOOLOGY}/messages/new/${p.messageUserId}`} target="_blank" rel="noreferrer">
                            Message
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
