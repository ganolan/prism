/**
 * Where the Vite dev server proxies /api.
 *
 * Follows PORT, so `PORT=3002 npm run dev` on the mini — where prod owns 3001 —
 * talks to its own API. A hard-coded 3001 there would send the "dev" UI's
 * syncs, notes and edits to prod's real student data.
 */
export function devApiTarget(env = process.env) {
  const port = String(env.PORT ?? '').trim() || '3001';
  return `http://localhost:${port}`;
}
