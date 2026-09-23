import { useEffect, useState } from 'react';
import { getVersion } from '../services/api.js';

/**
 * Which build is answering /api — small and quiet, at the foot of the sidebar.
 * It names the backend, not the page: when a local client proxies /api at the
 * server, this is what tells you which one you are actually looking at.
 */
export default function VersionBadge() {
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => live && setVersion(null));
    return () => {
      live = false;
    };
  }, []);

  if (!version) return null;

  const label = version.mode === 'release' && version.sha ? version.sha.slice(0, 7) : 'dev';
  const built = version.builtAt ? new Date(version.builtAt) : null;
  const title =
    built && !Number.isNaN(built.getTime())
      ? `Built ${built.toLocaleDateString('en-GB')} ${built.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : 'Development clone — no release deployed';

  return (
    <div className="version-badge" title={title}>
      {label}
    </div>
  );
}
