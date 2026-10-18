// Writes only from Prism's own pages. Prism sends no CORS headers, so a browser hides
// Prism's answers from other sites; but a browser still SENDS a simple cross-site POST
// (no JSON body, no preflight), e.g. one that starts a sync. This refuses any request
// but GET / HEAD / OPTIONS whose Origin is another site. Allowed: no Origin (curl,
// PrisMCP and other non-browser clients), an Origin on the host the request came in on
// (Host, or X-Forwarded-Host behind a proxy), or one listed in config.yaml
// server.allowedOrigins (prod's tailnet address, in case the proxy rewrites Host).
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isAllowedOrigin({ origin, host, forwardedHost, allowed = [] }) {
  if (origin === undefined) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin === 'null') return false;
  if (url.host === host || (forwardedHost && url.host === forwardedHost)) return true;
  return allowed.includes(url.origin);
}

export function originGuard({ allowed = [] } = {}) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const ok = isAllowedOrigin({
      origin: req.headers.origin, host: req.headers.host, forwardedHost: req.headers['x-forwarded-host'], allowed,
    });
    if (ok) return next();
    console.warn(`[originGuard] refused ${req.method} ${req.path} from ${req.headers.origin}`);
    res.status(403).json({ error: 'Refused: this request came from another site' });
  };
}
