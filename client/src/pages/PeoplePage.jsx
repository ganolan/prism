import { useState } from 'react';
import { searchPeople } from '../services/api.js';
import { useFeatureFlags } from '../hooks/useFeatureFlags.js';

const SCHOOLOGY = 'https://schoology.hkis.edu.hk';

const initials = (name) =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();

function Avatar({ person }) {
  const [failed, setFailed] = useState(false);
  if (person.photoUrl && !failed) {
    return (
      <img
        src={person.photoUrl.startsWith('http') ? person.photoUrl : `${SCHOOLOGY}${person.photoUrl}`}
        alt=""
        onError={() => setFailed(true)}
        style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600,
    }}>
      {initials(person.name)}
    </div>
  );
}

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
        Search the whole school — including people who aren’t in your classes.
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
      {loading && <p className="text-muted">Searching Schoology… (this opens a background browser, give it a moment)</p>}

      {data && !loading && (
        <div className="card">
          {data.results.length === 0 ? (
            <p className="text-muted">No people found for “{data.query}”.</p>
          ) : (
            <>
              {!data.complete && (
                <p className="text-sm text-muted" style={{ marginBottom: '0.75rem' }}>
                  Showing the first {data.results.length} matches — refine your search to narrow it down.
                </p>
              )}
              <table>
                <thead>
                  <tr><th></th><th>Name</th><th>School</th><th></th></tr>
                </thead>
                <tbody>
                  {data.results.map(p => (
                    <tr key={p.userId}>
                      <td style={{ width: '44px', padding: '0.25rem 0.5rem' }}>
                        <Avatar person={p} />
                      </td>
                      <td>
                        <a className="link" href={`${SCHOOLOGY}/user/${p.userId}`} target="_blank" rel="noreferrer">
                          {p.name || `User ${p.userId}`}
                        </a>
                      </td>
                      <td className="text-sm text-muted">{p.school || '—'}</td>
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
