import { Router } from 'express';
import { searchPeople, hasSession, DEFAULT_MAX_PAGES } from '../services/peopleSearch.js';
import { featureGate } from '../middleware/featureGate.js';
import { getDb } from '../db/index.js';
import { getPersonProfile, addPersonNote, deletePersonNote, deletePerson } from '../services/personProfile.js';
import { getUserProfile, getUserProfilesBatch, getMySections, getUserGroups } from '../services/schoology.js';
import { cookieJar, getResource } from '../services/schoologyWeb.js';

const router = Router();

// GET /api/people/session-status — does a saved Schoology browser session file
// exist? (Best-effort; does not prove the session is still valid.) People
// search rides the same session as the mastery sync.
router.get('/session-status', (req, res) => {
  res.json({ loggedIn: hasSession() });
});

// GET /api/people/search?q=...&maxPages=N — school-wide people search.
// Finds users outside the teacher's own sections via Schoology's internal
// /search/user (saved-session auth, plain HTTP). Feature-gated.
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

// #203: the Schoology reads behind a profile (services/personProfile.js). The Info page rides the saved session.
function profileReaders() {
  const jar = cookieJar();
  return {
    getProfile: getUserProfile,
    getProfiles: getUserProfilesBatch,
    getSections: getMySections,
    getGroups: getUserGroups,
    readInfoPage: async (uid) => {
      if (!jar) throw Object.assign(new Error('Schoology session expired: run `npm run mastery:login`.'), { needsLogin: true });
      let r;
      try {
        r = await getResource(jar, `/user/${uid}/info`, { accept: 'text/html' });
      } catch (err) {
        if (err.code === 'SESSION_EXPIRED') throw Object.assign(new Error('Schoology session expired: run `npm run mastery:login`.'), { needsLogin: true });
        throw err;
      }
      if (r.status !== 200) throw new Error(`Schoology answered ${r.status} for this person's page`);
      return r.text;
    },
  };
}

const fail = (res, err) => {
  if (err.needsLogin) return res.status(409).json({ error: err.message, needsLogin: true });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error('[people profile] Error:', err);
  return res.status(500).json({ error: err.message });
};

// GET /api/people/:uid[?refresh=1] — a person's profile: { student_id } for a Prism student (open their student
// page), else { profile } (read from Schoology when not stored or older than 7 days).
router.get('/:uid', featureGate('people_search'), async (req, res, next) => {
  if (!/^\d+$/.test(req.params.uid)) return next();
  try {
    res.json(await getPersonProfile(getDb(), req.params.uid, { readers: profileReaders(), refresh: req.query.refresh === '1' }));
  } catch (err) { fail(res, err); }
});

// DELETE /api/people/:uid — the teacher deletes a profile and its notes (Prism keeps profiles until then).
router.delete('/:uid', featureGate('people_search'), (req, res) => {
  res.json({ deleted: deletePerson(getDb(), req.params.uid) });
});

// POST /api/people/:uid/notes { content } and DELETE /api/people/:uid/notes/:noteId — the teacher's notes.
router.post('/:uid/notes', featureGate('people_search'), (req, res) => {
  try { res.json(addPersonNote(getDb(), req.params.uid, req.body?.content)); } catch (err) { fail(res, err); }
});
router.delete('/:uid/notes/:noteId', featureGate('people_search'), (req, res) => {
  res.json({ deleted: deletePersonNote(getDb(), req.params.uid, req.params.noteId) });
});

export default router;
