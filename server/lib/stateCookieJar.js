// A cookie jar over a saved Playwright storage state's cookies (storage-state.json), across hosts, for
// the plain-HTTP Microsoft sign-ins (#141): SharePoint (services/sharePointWeb.js) and the Schoology
// session renewal (services/schoologySession.js). Set-Cookie answers update it as a browser would: a
// cookie is replaced by name, domain and path; an expiring one (Max-Age=0, or an Expires in the past)
// is removed. cookies() hands the jar back in the same format, so a renewal can save it.
// Expiry stamps of saved cookies are not used to drop them: they read "expired" long before the server
// stops honouring them (AGENTS.md); the server decides.

// SharePoint answers 403 to Node's own User-Agent ("node"), 2026-10-19; Microsoft's and Schoology's
// sign-ins are sent the same browser-like value.
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Prism';

const bare = (domain) => String(domain).replace(/^\./, '').toLowerCase();

export function stateCookieJar(saved = [], { exclude = () => false, now = Date.now } = {}) {
  let cookies = saved.filter((c) => c?.name && c?.domain && !exclude(c)).map((c) => ({ ...c }));
  const same = (a, b) => a.name === b.name && bare(a.domain) === bare(b.domain) && (a.path || '/') === (b.path || '/');
  const matches = (c, host) => {
    const d = bare(c.domain);
    // A domain cookie (".x.com") goes to x.com and its subdomains; a host-only cookie to its host only.
    return host === d || (c.domain.startsWith('.') && host.endsWith(`.${d}`));
  };
  return {
    header: (url) => {
      const host = new URL(url).host.toLowerCase();
      return cookies.filter((c) => matches(c, host)).map((c) => `${c.name}=${c.value}`).join('; ');
    },
    take(res, url) {
      const host = new URL(url).host.toLowerCase();
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...parts] = line.split(';');
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        const attrs = new Map(parts.map((p) => p.trim()).filter(Boolean).map((p) => {
          const j = p.indexOf('=');
          return j < 0 ? [p.toLowerCase(), true] : [p.slice(0, j).trim().toLowerCase(), p.slice(j + 1).trim()];
        }));
        const domain = attrs.get('domain') ? `.${bare(attrs.get('domain'))}` : host;
        const maxAge = attrs.has('max-age') ? Number(attrs.get('max-age')) : null;
        const expiresAt = maxAge != null ? now() / 1000 + maxAge
          : attrs.get('expires') ? Date.parse(attrs.get('expires')) / 1000 : -1;
        const cookie = {
          name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain, path: attrs.get('path') || '/',
          expires: expiresAt, httpOnly: attrs.has('httponly'), secure: attrs.has('secure'),
          sameSite: ({ none: 'None', strict: 'Strict' })[String(attrs.get('samesite') || '').toLowerCase()] || 'Lax',
        };
        const expired = (maxAge != null && maxAge <= 0) || (expiresAt !== -1 && expiresAt * 1000 < now());
        const at = cookies.findIndex((c) => same(c, cookie));
        if (expired) { if (at >= 0) cookies.splice(at, 1); } else if (at >= 0) cookies[at] = cookie; else cookies.push(cookie);
      }
    },
    cookies: () => cookies.map((c) => ({ ...c })),
  };
}
