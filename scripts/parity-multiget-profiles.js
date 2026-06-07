// scripts/parity-multiget-profiles.js
// Live parity (#105): POST /multiget must return the same primary_email,
// preferred-name fields, and guardian set as per-student GET /users/{uid}.
// Usage: node scripts/parity-multiget-profiles.js [limit]
import 'dotenv/config';
import { getUserProfile, getUserProfilesBatch } from '../server/services/schoology.js';
import { getDb } from '../server/db/index.js';

const limit = Number(process.argv[2] || 60);
const db = getDb();
const uids = db.prepare('SELECT schoology_uid FROM students WHERE schoology_uid IS NOT NULL LIMIT ?').all(limit).map(r => String(r.schoology_uid));
if (!uids.length) { console.error('No students in DB — run a sync first'); process.exit(1); }

// Guardians can come back as an array OR a lone object — normalise both, like
// enrichStudentProfiles does, before comparing.
const parentKey = (p) => {
  const raw = p?.parent ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(x => `${x.id}:${x.primary_email || ''}`).sort().join(',');
};
const profKey = (u) => `email=${u?.primary_email || ''}|pref=${u?.name_first_preferred || ''}:${u?.use_preferred_first_name || ''}|parents=[${parentKey(u?.parents)}]`;

const batch = await getUserProfilesBatch(uids);
let mismatches = 0, missing = 0;
for (const uid of uids) {
  const single = await getUserProfile(uid).catch(() => null);
  const b = batch.get(uid);
  if (!b) { missing++; console.log(`  MISSING from batch: ${uid}`); continue; }
  const a = profKey(single), c = profKey(b);
  if (a !== c) { mismatches++; console.log(`  MISMATCH ${uid}\n    per-student: ${a}\n    batch:       ${c}`); }
}
console.log(`\n=== PARITY #105 ===`);
console.log(`uids: ${uids.length} | missing-from-batch: ${missing} | mismatches: ${mismatches}`);
const ok = mismatches === 0 && missing === 0;
console.log(ok ? '✅ PARITY OK' : '❌ PARITY FAILED');
process.exit(ok ? 0 : 1);
