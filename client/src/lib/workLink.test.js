import { describe, test, expect } from 'vitest';
import { workLinkText, workLinksStatusText } from './workLink.js';
import { formatDateTime } from './formatDate.js';

describe('workLinkText', () => {
  test('OneDrive: names OneDrive and when the copy was last edited', () => {
    const at = '2026-09-28T06:27:25Z';
    expect(workLinkText({ url: 'u', provider: 'onedrive', modifiedAt: at }, 'Ada Lovelace')).toEqual({
      ariaLabel: "Open Ada Lovelace's work in OneDrive",
      title: `Open Ada Lovelace's work in OneDrive: last edited ${formatDateTime(at)}`,
    });
  });

  test('a link with no provider is OneDrive (links from before #142)', () => {
    expect(workLinkText({ url: 'u', modifiedAt: null }, 'Ada').ariaLabel).toBe("Open Ada's work in OneDrive");
    expect(workLinkText({ url: 'u', modifiedAt: null }, 'Ada').title).toBe("Open Ada's work in OneDrive");
  });

  test('Google Drive: names Google Drive and when the work was submitted', () => {
    const at = '2023-03-16T05:52:00.000Z';
    expect(workLinkText({ url: 'u', provider: 'google_drive', submittedAt: at }, 'Ada')).toEqual({
      ariaLabel: "Open Ada's work in Google Drive",
      title: `Open Ada's work in Google Drive: submitted ${formatDateTime(at)}`,
    });
    expect(workLinkText({ url: 'u', provider: 'google_drive', submittedAt: null }, 'Ada').title)
      .toBe("Open Ada's work in Google Drive");
  });
});

describe('workLinksStatusText', () => {
  test('names the store the lookup is reading', () => {
    expect(workLinksStatusText({ status: 'loading' })).toEqual({ kind: 'loading', text: 'Finding students’ files…' });
    expect(workLinksStatusText({ status: 'sso_failed', provider: 'onedrive' })).toMatchObject({ kind: 'unavailable', text: 'OneDrive links unavailable' });
    expect(workLinksStatusText({ status: 'session_expired', provider: 'google_drive' })).toMatchObject({ kind: 'unavailable', text: 'Google Drive links unavailable' });
    expect(workLinksStatusText({ status: 'error' })).toMatchObject({ kind: 'unavailable', text: 'OneDrive links unavailable' });
  });

  test('nothing to say when the links loaded, or the task has none', () => {
    for (const status of [null, 'ok', 'not_lti', 'no_folder', 'unsupported_app']) {
      expect(workLinksStatusText({ status })).toBeNull();
    }
  });
});
