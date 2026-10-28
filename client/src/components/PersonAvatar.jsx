import { useState } from 'react';

export const SCHOOLOGY = 'https://schoology.hkis.edu.hk';

const initials = (name) =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();

// A person's Schoology photo, or their initials when there is none or it fails to load (People search, #203 profile).
export default function PersonAvatar({ name, photoUrl, size = 36 }) {
  const [failed, setFailed] = useState(false);
  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl.startsWith('http') ? photoUrl : `${SCHOOLOGY}${photoUrl}`}
        alt=""
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--bg-subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size > 40 ? '1.1rem' : '0.8rem', color: 'var(--text-muted)', fontWeight: 600,
    }}>
      {initials(name)}
    </div>
  );
}
