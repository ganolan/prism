import { describe, it, expect } from 'vitest';
import { parseUserSearchResults, PAGE_SIZE } from './parseUserSearch.js';

// Fixture mirrors the verified /search/user result-row structure
// (schoology-api-reference.md "Three high-priority surfaces" #1). Values are
// synthetic — no real PII. Includes header chrome with a stray /user/ link to
// confirm the parser scopes to li.search-summary only.
const FIXTURE = `
<html><body>
  <div id="header">
    <a href="/user/999999" class="profile-nav">My Account</a>
  </div>
  <div class="item-list">
    <ul class="search-summaries">
      <li class="search-summary">
        <div class="item user-list-item">
          <a href="/user/12345">
            <div class="profile-picture-wrapper"><div class="profile-picture">
              <img src="/system/files/imagecache/profile_sm/pictures/picture-abc_123.jpg?1694057983"
                   alt="Ada Lovelace" class="imagecache imagecache-profile_sm">
            </div></div>
          </a>
          <div class="item-title"><a href="/user/12345">Ada Lovelace</a></div>
          <div class="item-info">
            <span class="item-type">Person</span>
            <span class="item-school"><a href="/96044023">HKIS High School</a></span>
          </div>
          <div class="network-button-links">
            <a href="/messages/new/12345?destination=user/12345" class="link-btn action-message">
              <span><span class="visually-hidden">Send message</span></span>
            </a>
          </div>
        </div>
      </li>
      <li class="search-summary">
        <div class="item user-list-item">
          <a href="/user/67890">
            <div class="profile-picture-wrapper"><div class="profile-picture">
              <span class="default-avatar"></span>
            </div></div>
          </a>
          <div class="item-title"><a href="/user/67890">Grace Hopper</a></div>
          <div class="item-info">
            <span class="item-type">Person</span>
            <span class="item-school"><a href="/96044099">HKIS Middle School</a></span>
          </div>
        </div>
      </li>
    </ul>
  </div>
</body></html>
`;

describe('parseUserSearchResults', () => {
  it('extracts all fields from a well-formed result row', () => {
    const results = parseUserSearchResults(FIXTURE);
    expect(results[0]).toEqual({
      userId: '12345',
      name: 'Ada Lovelace',
      type: 'Person',
      school: 'HKIS High School',
      schoolId: '96044023',
      photoUrl: '/system/files/imagecache/profile_sm/pictures/picture-abc_123.jpg?1694057983',
      messageUserId: '12345',
    });
  });

  it('returns one result per search-summary row, in document order', () => {
    const results = parseUserSearchResults(FIXTURE);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.userId)).toEqual(['12345', '67890']);
  });

  it('ignores /user/ links outside the result rows (header chrome)', () => {
    const results = parseUserSearchResults(FIXTURE);
    expect(results.find(r => r.userId === '999999')).toBeUndefined();
  });

  it('tolerates a missing photo and missing message link', () => {
    const results = parseUserSearchResults(FIXTURE);
    expect(results[1]).toEqual({
      userId: '67890',
      name: 'Grace Hopper',
      type: 'Person',
      school: 'HKIS Middle School',
      schoolId: '96044099',
      photoUrl: null,
      messageUserId: null,
    });
  });

  it('returns [] when there are no result rows', () => {
    expect(parseUserSearchResults('<html><body><div class="item-list"></div></body></html>')).toEqual([]);
  });

  it('exposes the verified page size of 10', () => {
    expect(PAGE_SIZE).toBe(10);
  });
});
