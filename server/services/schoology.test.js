import { describe, test, expect, vi, afterEach } from 'vitest';

// schoology.js reads OAuth credentials from the environment at import time.
// Seed harmless values BEFORE the module is dynamically imported (a static
// import would be hoisted above these assignments). fetch is stubbed per-test,
// so the real network is never touched.
process.env.SCHOOLOGY_BASE_URL ||= 'https://api.schoology.com';
process.env.SCHOOLOGY_CONSUMER_KEY ||= 'test-key';
process.env.SCHOOLOGY_CONSUMER_SECRET ||= 'test-secret';

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

describe('getSectionFolders', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Regression for the dropped-folder bug: Schoology pages the folders endpoint
  // at 20 items by default, so a single un-paginated GET silently truncates any
  // course with more than 20 folders. The 21st+ folder (and every assignment in
  // it) then disappears from grouped views.
  test('paginates through every page instead of truncating at the default page size', async () => {
    const { getSectionFolders } = await import('./schoology.js');

    const page1 = { folders: Array.from({ length: 100 }, (_, i) => ({ id: i, title: `F${i}` })) };
    const page2 = { folders: Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, title: `F${100 + i}` })) };

    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(url);
      return jsonResponse(url.includes('start=100') ? page2 : page1);
    }));

    const folders = await getSectionFolders('7899896088');

    expect(folders).toHaveLength(105);
    expect(folders.at(-1).id).toBe(104);
    expect(calls.some((u) => u.includes('start=0'))).toBe(true);
    expect(calls.some((u) => u.includes('start=100'))).toBe(true);
  });

  test('requests a page size large enough to clear the default 20-item cap', async () => {
    const { getSectionFolders } = await import('./schoology.js');

    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(url);
      return jsonResponse({ folders: [] });
    }));

    await getSectionFolders('123');

    expect(calls[0]).toMatch(/limit=100/);
  });
});

describe('getAssignmentSubmissions (bulk #55)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('returns the flat revision[] for one assignment in one call', async () => {
    const { getAssignmentSubmissions } = await import('./schoology.js');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      revision: [
        { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
        { revision_id: 1, uid: '702', created: 2000, late: 1, draft: 0 },
      ],
      total: 2,
    })));
    const revs = await getAssignmentSubmissions('sec-1', 'A1');
    expect(revs).toHaveLength(2);
    expect(revs.map(r => r.uid).sort()).toEqual(['701', '702']);
  });

  test('follows links.next pagination and concatenates every page', async () => {
    const { getAssignmentSubmissions } = await import('./schoology.js');
    const page1 = {
      revision: Array.from({ length: 20 }, (_, i) => ({ revision_id: 1, uid: String(i), created: 1, late: 0, draft: 0 })),
      links: { next: 'https://api.schoology.com/v1/sections/sec-1/submissions/A1?start=20&limit=20' },
    };
    const page2 = {
      revision: [{ revision_id: 1, uid: '99', created: 1, late: 0, draft: 0 }],
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(url);
      return jsonResponse(url.includes('start=20') ? page2 : page1);
    }));
    const revs = await getAssignmentSubmissions('sec-1', 'A1');
    expect(revs).toHaveLength(21);
    expect(calls.some(u => u.includes('start=20'))).toBe(true);
  });
});
