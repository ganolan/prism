# API Exploration Playbook

How to discover data/endpoints in this project's ecosystem, written for a session **starting with no context**. The two findings docs — `schoology-api-reference.md` and `powerschool-api-reference.md` — are the *"what we found"*; this is the *"how to look, and why first answers are usually incomplete."*

## The core principle: a spike is a lower bound, not a conclusion

Every "complete" finding here has later turned out to be complete only **for the surface that was tested**. The public REST inventory was "done" — but the rich data was on other surfaces. The mastery internal API was "fully mapped" — until an LTI embed revealed PowerSchool underneath. The alert scrape was "characterized" — until the plugin's own JS revealed a 31-item catalog and structured field reads.

**Rule of thumb:** if a teacher can *see* data on a screen, it is reachable. If your probe didn't find it, you tested the wrong surface — not "it isn't available." So:

- Scope every conclusion: *"complete for surface X; surfaces Y/Z not yet explored."* Never "this is all the data there is."
- Before declaring done, ask: which of the surfaces below have I **not** checked for this data?

## The architecture: data lives across ≥4 surfaces

What looks like "Schoology" is several systems layered behind one domain:

| # | Surface | Where | Auth | Notes |
|---|---|---|---|---|
| A | **Public REST API** | `api.schoology.com/v1` | OAuth 1.0a two-legged (`server/services/schoology.js` `apiGet`) | Documented; many 403s. A *lower bound* on data. |
| B | **Internal web API** | `schoology.hkis.edu.hk/...` (e.g. `/course/{id}/district_mastery/api/...`, `/iapi2/...`) | Browser session (Playwright, `npm run mastery:login`) | Undocumented, much richer. POSTs need CSRF from `Drupal.settings.s_common`. |
| C | **Embedded LTI apps → other systems** | `/apps/lti/{appId}/run/course/{sectionId}` | LTI launch (auto-POST form) | The "Schoology" page is actually a **third-party iframe** (PowerSchool). The launch form carries cross-system ID mappings (`custom_sectiondcid`, `custom_userdcid`). |
| D | **The embedded system's own layers** | `powerschool.hkis.edu.hk/...` | Shared SSO session (same browser context as B) | PowerSchool itself has: OAuth-2 `/ws/v1` (blocked, needs creds), session web services `/ws/...` (working), and **plugin-injected client apps** (MBA alerts) with their own `/teachers/.../queries/*` endpoints. |

The same browser session from `mastery:login` authenticates B **and** D (shared HKIS SSO) — establish the PowerSchool session by loading the LTI app once.

## ID Rosetta stones (the joins)

- Schoology section → PowerSchool `sectionDcid`: from the **LTI launch form** (`GET /apps/lti/{appId}/run/course/{schoologySectionId}` → hidden input `custom_sectiondcid`).
- Schoology enrollment `school_uid` = `1_{PowerSchool student dcid}`.
- PowerSchool `frn` = `001` + dcid (table 001 = students); teacher `userdcid` is prefixed `2_`.
- Prism `students.school_uid` strip the `1_` prefix → PS dcid → join to any PowerSchool data.

## The discovery playbook (in order)

1. **Start from the UI, not the API docs.** Identify the exact screen that shows the data you want.
2. **Drive the real page with Playwright + the saved session** and capture *all* network traffic (`context.on('response')`), not just the call you expect. Trace each XHR to its backend host.
3. **Check `page.frames()` and `<iframe src>`.** If a frame is on a *different origin* (e.g. `powerschool.hkis.edu.hk`), the data is served by another system (surface C/D) — pivot there.
4. **Wait for deferred/async loads, and beware headless render differences.** Grids/badges load after first paint; some only render for valid state (e.g. an *in-session date* — an end-of-year/weekend date yields an empty grid and the data call never fires).
5. **If the render doesn't fire, read the client JS bundle.** Fetch the app's `.js` files and grep for endpoint string literals (`/queries/`, `.json`, `.html`, param names like `sectionIds`, `student_field`). This reveals endpoints the current view never exercised (this is how `getAlertTypes.json` / `stuFieldValues.json` were found).
6. **Prefer a "list definitions/types" endpoint over per-instance guessing.** `getAlertTypes.json` gave the whole catalog; hardcoding IDs from one student missed most of it.
7. **Empirically test params — docs lie.** Field/table names from a config may differ from what works (`U_DEF_EXT_STUDENTS` worked; the catalog's `U_Students_Extension` returned nothing).
8. **Test multiple states/dates.** `studentAlerts`/attendance populate only for the current/valid date; counts are range-scoped; etc.
9. **Reuse the codebase's auth paths.** REST → `apiGet` in `server/services/schoology.js`. Internal/PowerSchool → the Playwright `storageState` pattern in `server/services/masterySync.js`.

## Hygiene

- **PII:** capture *shapes* (keys/types), mask values. Never commit scraped student data. Keep raw dumps in `/tmp`, and delete them when done — especially safeguarding/SEN/medical content.
- **Rate limits:** REST ≈ 50 req/min; add small delays in loops.
- **Iframe fragility:** the embedded PS frame can detach mid-loop. For long sweeps, re-acquire the frame each iteration or navigate the top page onto the PS origin.

## Frontier — surfaces/data known to exist but not yet fully explored

- PowerSchool OAuth-2 `/ws/v1` + PowerQuery (blocked — needs admin `client_id`/`secret`; the clean long-term source).
- Other Schoology LTI apps beyond the attendance app (`/apps/...`).
- The full set of internal Schoology `iapi`/`district_mastery` endpoints.
- MBA `adv`-trigger alert detail popups (MAP, support summary) and the `stuFieldValues.json` batch read (params identified, not finalized).
- Standard PowerSchool alerts (medical/health via `/ws/schema/query/...health...`).

When you extend any of these, append findings to the relevant `*-api-reference.md` and update the Frontier list here.
