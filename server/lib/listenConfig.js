/**
 * Where the Express server binds.
 *
 * Prism has no application auth: the tailnet is the security perimeter
 * (docs/adr/0003). That only holds if the process listens on loopback, so
 * `tailscale serve` is the single route in. Widening it is a deliberate act
 * via HOST, never the default.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3001;

export function resolveHost(env = process.env) {
  const host = String(env.HOST ?? '').trim();
  return host || DEFAULT_HOST;
}

// `Number('')` is 0, which is a *valid* port — so an unset PORT has to be
// caught as an empty string before it reaches the range check, or every
// default boot would bind an ephemeral port.
export function resolvePort(env = process.env) {
  const raw = String(env.PORT ?? '').trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  const valid = Number.isInteger(port) && port >= 0 && port <= 65535;
  return valid ? port : DEFAULT_PORT;
}
