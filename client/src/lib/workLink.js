// Wording for the "Open" link to a student's own copy of an lti_submission task:
// OneDrive (#120) or Google Drive (#142). The server names the provider on each
// link (GET …/submission-links); a link without one is OneDrive.
import { formatDateTime } from './formatDate.js';

const STORE = { onedrive: 'OneDrive', google_drive: 'Google Drive' };
const storeName = (provider) => STORE[provider] || STORE.onedrive;

/** { ariaLabel, title } for one student's link. */
export function workLinkText(link, name) {
  const store = storeName(link?.provider);
  const ariaLabel = `Open ${name}'s work in ${store}`;
  const when = link?.provider === 'google_drive'
    ? (link.submittedAt ? `submitted ${formatDateTime(link.submittedAt)}` : '')
    : (link?.modifiedAt ? `last edited ${formatDateTime(link.modifiedAt)}` : '');
  return { ariaLabel, title: when ? `${ariaLabel}: ${when}` : ariaLabel };
}

const UNAVAILABLE = ['no_session', 'sso_failed', 'session_expired', 'error'];

/**
 * The toolbar note for the whole assignment's lookup, or null when there is
 * nothing to say: { kind: 'loading' | 'unavailable', text, title? }.
 */
export function workLinksStatusText({ status, provider } = {}) {
  if (status === 'loading') return { kind: 'loading', text: 'Finding students’ files…' };
  if (!UNAVAILABLE.includes(status)) return null;
  if (provider === 'google_drive') {
    return {
      kind: 'unavailable',
      text: 'Google Drive links unavailable',
      title: "Prism couldn't read the Schoology grader through the saved session. Refresh to retry; if it keeps failing, log in again (npm run mastery:login).",
    };
  }
  return {
    kind: 'unavailable',
    text: 'OneDrive links unavailable',
    title: "Prism couldn't read your OneDrive through the saved Schoology session. Refresh to retry; if it keeps failing, log in again (npm run mastery:login).",
  };
}
