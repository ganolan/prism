/**
 * True when the module at `metaUrl` is the script node was started with.
 *
 * The usual guard — `import.meta.url === pathToFileURL(process.argv[1]).href`
 * — compares a resolved path with an unresolved one. Node resolves the main
 * module through symlinks for import.meta.url but leaves argv[1] as typed, so
 * through any symlink the guard is false and the script exits 0 having done
 * nothing. On the server every script runs through ~/prism/current, which is a
 * symlink: the deploy poller, the nightly backup and PrisMCP would all silently
 * no-op. (Even /var on macOS is a symlink, to /private/var.)
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
