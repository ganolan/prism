import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { searchStudents } from '../services/api.js';

function matchesQuery(student, query) {
  if (!query.trim()) return true;
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const haystack = [
    student.preferred_name_teacher,
    student.preferred_name,
    student.first_name,
    student.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [allStudents, setAllStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    searchStudents('')
      .then(data => setAllStudents(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const results = allStudents.filter(s => matchesQuery(s, query));

  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;

  return (
    <div className="fade-in">
      <h2 className="page-title">Search Students</h2>

      <input
        type="search"
        placeholder="Search by name..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ maxWidth: '400px', marginBottom: '1.5rem' }}
        autoFocus
      />

      {loading && <p className="text-muted">Loading students…</p>}
      {error && <p className="alert alert-warning">{error}</p>}

      {!loading && !error && (
        <div className="card">
          {results.length === 0 ? (
            <p className="text-muted">No students found{query ? ` for "${query}"` : ''}.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {results.map(s => (
                  <tr key={s.id}>
                    <td style={{ width: '40px', padding: '0.25rem 0.5rem' }}>
                      {s.picture_url ? (
                        <img
                          src={s.picture_url}
                          alt=""
                          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                        />
                      ) : (
                        <div style={{
                          width: 32, height: 32, borderRadius: '50%',
                          background: 'var(--bg-subtle)', display: 'flex',
                          alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.75rem', color: 'var(--text-muted)',
                          fontWeight: 600,
                        }}>
                          {displayName(s)?.[0]}{s.last_name?.[0]}
                        </div>
                      )}
                    </td>
                    <td>
                      <Link to={`/student/${s.id}`} className="link">
                        {displayName(s)} {s.last_name}
                      </Link>
                      {displayName(s) !== s.first_name && (
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
