// PowerSchool alerts (#117) on the client: which may show on a roster.
//
// A roster may be projected to a class, so it shows only learning, health and
// other alerts (never family ones: correspondence, divorced, staff child,
// siblings), and only with Private details on (lib/privateDetails.js, #160).
// The server already leaves family alerts out of roster data; this is the
// second guard.

export const ROSTER_CATEGORIES = ['learning', 'health', 'other'];
export const forRoster = (alerts) => (alerts || []).filter((a) => ROSTER_CATEGORIES.includes(a.category));
