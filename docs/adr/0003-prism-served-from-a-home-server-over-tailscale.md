# ADR 0003 — Prism is served from a home Mac mini; the tailnet is the perimeter, not app auth

**Status:** Accepted (2026-09-23)
**Amends:** ADR 0002's "local-first" premise — see *Relationship to ADR 0002*.
**Implements:** the "server + Tailscale" target end state in #121.
**Design:** `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`

## Context

Prism ran from a OneDrive-synced folder with the work laptop as master and a
drifted second copy at home. #121 documents the failure modes; on 2026-09-22 one
of them materialised — the OneDrive clone's `.git` was missing 8 objects and
could not read its own HEAD commit.

The blocker on #121's preferred fix (an always-on server reachable over
Tailscale) was a work VPN that conflicted with Tailscale. That cleared: Tailscale
from the work network to a home Mac mini is reliable.

Prism has **no application authentication** — no auth middleware, unrestricted
CORS, and `app.listen(PORT)` binding every interface. A laptop process started
and stopped is one risk profile; a service running continuously is another.

## Decision

1. **A home Mac mini is the single production instance** and holds the one
   authoritative database. Other machines hold disposable dev copies.
2. **The tailnet is the security perimeter. No application auth is added.** The
   server binds `127.0.0.1` and is published by `tailscale serve`, so the tailnet
   is the only route in. Binding loopback is what makes this true — Tailscale
   adds a private path, it does not remove the public one, and an
   all-interfaces bind would leave the app served to the mini's LAN regardless.
3. **Push to `main` deploys automatically, gated on CI.** Tests run on GitHub's
   cloud runners; the mini polls, pulls and deploys itself. The mini accepts no
   inbound connections and runs no GitHub-dispatched code.
4. **No self-hosted GitHub runner.** The repo is public, so any pull request
   could execute code on the machine holding student data. This holds even if
   the repo goes private: a reused runner defeats the clean-environment property
   the gate exists for, and a runner is a standing execution channel into that
   machine.
5. **The production checkout is machine-owned.** Deploys write it; humans never
   edit it. Development on the mini happens in a separate clone with its own
   database and port.
6. **Processes move to the data, not the reverse.** PrisMCP reads and writes
   SQLite directly, so it runs on the mini (over SSH) rather than against a
   network-mounted database. SQLite's multi-process safety is a same-host
   guarantee.

## Guardrails

- **The database never lives in a cloud-synced folder.** This is the #121
  lesson and it now extends to `~/Documents`, where macOS Desktop & Documents
  sync is a settings toggle away.
- **Snapshots, never the live file.** `db:backup` uses SQLite's backup API; the
  live `.db`/`-wal`/`-shm` trio is never copied by a syncing tool.
- **Tailnet hygiene.** Key expiry disabled on the mini's node, or the server
  silently drops off the tailnet in ~180 days. Anyone holding an unlocked
  enrolled device is inside with no second check — that is the accepted
  trade-off for having no app auth.
- **No credentials in GitHub Actions secrets.** Not Schoology's, not the
  tailnet's. The CI gate runs entirely on mocks and needs none, and this rules
  out the "runner joins the tailnet to deploy" variant.

## Relationship to ADR 0002

ADR 0002 permits storing teacher-accessible PII locally, resting on Prism being
"local-first" — student data on "the teacher's machine," not hosted. This ADR
narrows that premise rather than discarding it: the data still sits on hardware
the teacher owns, in their home, reachable only from their own devices over a
private encrypted network, and is still never sent to a third party beyond the
model the teacher invokes.

What changes is that "local" now means *one* of the teacher's machines rather
than *the* machine in front of them. ADR 0002's PII stance and guardrails stand
unmodified. If Prism is ever exposed beyond the tailnet, both this ADR and 0002's
premise need revisiting — that would be a new decision, not an extension.

## Consequences

- #121's two-master database problem dissolves: one authoritative DB, with other
  copies explicitly disposable. The drift the issue managed around stops
  mattering.
- The laptop's disposable copy doubles as a degraded-mode fallback when the mini
  is unreachable.
- Deploys become routine and reversible (symlink swap, previous release
  retained), so the 903-test suite becomes load-bearing infrastructure rather
  than a quality nicety.
- Any new process that touches student data must answer "which machine does this
  run on, and which database does it open?" before it is written. PrisMCP is the
  worked example: run it where the data is, and make a misconfigured launch fail
  loudly rather than write to a scratch copy.
- Development against live prod data is possible (mode 3 in the design) and
  carries the cost that writes land in real student records.
