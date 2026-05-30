import { Router } from 'express';
import { searchPeople, hasSession, DEFAULT_MAX_PAGES } from '../services/peopleSearch.js';
import { featureGate } from '../middleware/featureGate.js';

const router = Router();

// GET /api/people/session-status — does a saved Schoology browser session file
// exist? (Best-effort; does not prove the session is still valid.) People
// search rides the same session as the mastery sync.
router.get('/session-status', (req, res) => {
  res.json({ loggedIn: hasSession() });
});

// GET /api/people/search?q=...&maxPages=N — school-wide people search.
// Finds users outside the teacher's own sections via Schoology's internal
// /search/user (browser-session auth). Feature-gated.
router.get('/search', featureGate('people_search'), async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ query: '', results: [], pagesFetched: 0, complete: true });

  const maxPages = Math.min(Math.max(parseInt(req.query.maxPages, 10) || DEFAULT_MAX_PAGES, 1), 20);

  try {
    const data = await searchPeople(q, { maxPages });
    res.json(data);
  } catch (err) {
    if (err.needsLogin) {
      return res.status(409).json({ error: err.message, needsLogin: true });
    }
    console.error('[people search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
