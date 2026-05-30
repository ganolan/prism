// browserSession.js
// Shared constants/helpers for the Playwright browser-session services
// (grader submissions, past-course discovery, mastery sync). Single source for
// the school domain and the "still logged in?" URL check, so a domain or SSO
// change is a one-file edit.
export const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';

export function isLoggedInUrl(url) {
  return url.includes('schoology.hkis.edu.hk') &&
    !/\/login|\/saml|accounts\.google\.com|microsoftonline/.test(url);
}
