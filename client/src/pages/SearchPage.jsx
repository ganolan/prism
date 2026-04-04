import { useState } from 'react';
import { Link } from 'react-router-dom';
import { searchStudents } from '../services/api.js';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await searchStudents(query.trim());
      setResults(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const displayName = (s) => s.preferred_name || s.first_name;

  return (
    <div>
      <h2 className="page-title">Search Students</h2>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input
          type="search"
          placeholder="Search by name..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ maxWidth: '400px' }}
        />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {results !== null && (
        <div className="card">
          {results.length === 0 ? (
            <p className="text-muted">No students found for "{query}"</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {results.map(s => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/student/${s.id}`} className="link">
                        {displayName(s)} {s.last_name}
                      </Link>
                      {s.preferred_name && (
                        <span className="text-sm text-muted" style={{ marginLeft: '0.5rem' }}>
                          ({s.first_name})
                        </span>
                      )}
                    </td>
                    <td className="text-sm">{s.email || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
