// Schoology's API returns an assignment's public `web_url` on the generic
// `app.schoology.com` host (two path shapes observed: `/assignments/{id}/info`
// and `/assignment/{id}`). Schools on SSO use a vanity domain instead
// (HKIS: schoology.hkis.edu.hk), where `app.schoology.com` links don't resolve
// to the right tenant. This rewrites the scheme+host of a captured web_url to
// the configured school web base, preserving the path/query/hash exactly.
//
// Pure + path-agnostic (host swap only), so both observed path shapes survive.
// Returns null for a falsy/unparseable url; returns the url untouched when no
// base is configured.
export function toSchoologyWebUrl(rawUrl, webBaseUrl) {
  if (!rawUrl) return null;
  if (!webBaseUrl) return rawUrl;
  let url, base;
  try {
    url = new URL(rawUrl);
    base = new URL(webBaseUrl);
  } catch {
    return null;
  }
  url.protocol = base.protocol;
  url.host = base.host;
  return url.toString();
}
