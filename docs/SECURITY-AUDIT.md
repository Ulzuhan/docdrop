# Security and infrastructure audit

Last re-audited: 2026-08-27.

## Scope and threat model

DocDrop is treated as Internet-facing and as a host for attacker-controlled bytes. The
review covers every route handler; OIDC and signed sessions; public capability URLs;
guest credentials; direct and chunked upload; download counters, previews and ZIP;
filesystem paths, quotas, cleanup and races; browser headers; service worker/share
target; dependencies, CI, Docker/Compose and systemd deployment.

Attackers may be anonymous, possess one public download id or guest link, hold a normal
account, control a sibling origin under the same parent domain, send malformed or
concurrent streams, interrupt transfers, forge proxy headers when reaching an
untrusted listener, and try to exhaust disk, memory, CPU or descriptors.

## Findings and disposition

Fixed during this audit:

1. The raw-file POST accepted simple cross-origin requests. A sibling origin could use
   a SameSite session cookie to upload attacker-chosen bytes. It now validates Fetch
   Metadata and Origin.
2. Cleanup and logout were bodyless simple POSTs with the same CSRF gap. Both now use
   the same-origin guard.
3. OIDC token and userinfo requests had no timeout and could retain request handlers
   indefinitely. Both now abort after 10 seconds by default.
4. A session secret of any length was accepted. At least 32 UTF-8 bytes are now
   required; missing or weak configuration fails closed.
5. Documentation incorrectly promised immediate provider-side account revocation.
   Stateless cookies cannot provide that without introspection. Sessions now last 12
   hours by default, are clamped to 1–24 hours, and the limitation is explicit.
6. Direct uploads checked quota outside the reservation lock. Concurrent streams could
   both observe the same free space and exceed the total cap. Direct streaming now
   remains under the same quota lock used for chunked reservations.
7. HSTS included subdomains. It is now host-only. (The stated reason — sibling
   hostnames — was not quite right: `includeSubDomains` on `docdrop.<domain>` covers
   its own subdomains, never its siblings. The change is still the conservative one,
   since this application does not serve any.)
8. The systemd unit described absent configuration as open mode although the
   application fails closed. The comment now matches behavior.
9. The CI lint command exposed pre-existing errors and warning: immutable let
   declarations, an intentional any without a local exception, and an unused import.
   The gate is now clean.
10. store.ts contained a literal NUL byte. Runtime behavior was valid, but audit/search
    tools classified the source as binary. It now uses the equivalent textual escape.
11. Several security and maintenance statements and suite counts were stale. They were
    corrected and the suite gained six assertions covering CSRF and concurrent quota.
12. The runner reused one temporary store across suites despite claiming isolation; preallocated
    uploads leaked state into later suites. It now recreates the temporary store per suite.
13. The dev-only Hono dependency had a moderate advisory. The lockfile now resolves
    4.13.5 and both full and production npm audits report zero vulnerabilities.
14. OIDC public/internal bases used deployment-specific silent defaults. Public base is
    now required and validated; internal base safely defaults to it.
15. Numeric timeout and chunk configuration is now bounded against invalid or extreme values.

Found while re-checking that work, and fixed:

16. The origin check preferred X-Forwarded-Host over Host. That header is written by the
    caller and **this deployment does not replace it** — verified live against the tunnel:
    it arrives untouched while Host still reads the real name. Sending it with a matching
    Origin got past all three guards: session destroyed, sweep triggered, and
    attacker-chosen bytes written, which is exactly what finding 1 set out to stop. Host
    is now the source of truth, with `DOCDROP_PUBLIC_HOST` for proxies that rewrite it.
17. `POST /api/upload/[uploadId]/complete` was a fourth bodyless simple POST with no
    guard. A sibling origin got 200 and closed somebody else's in-flight upload; the
    ownership check does not help, because the credential riding along is the victim's.
18. Holding the quota lock across the whole direct-upload stream closed the race but
    serialized every upload. Measured: a 1 MB upload took 3.2 seconds waiting behind a
    trickling one, and a multi-gigabyte transfer from a home connection would hold the
    lock for its whole duration — on a tool whose large-upload handling is most of the
    work. Space is now reserved under the lock and the body streams outside it. The
    concurrent-quota assertion still fails without the reservation, so the race stays
    closed.

## Re-audited controls

- Download ids are 72-bit random capabilities and guest tokens are 128-bit random
  capabilities. All URL-derived filesystem ids are syntactically constrained.
- Session signatures use HMAC-SHA256 and constant-time comparison. Cookies are
  HttpOnly, SameSite=Lax and Secure in production. Local user records are checked on
  every request.
- OIDC uses authorization code, PKCE and state. Redirect targets reject absolute,
  protocol-relative, backslash-normalized and control-character variants.
- Dashboard, upload, cleanup, file-management and guest-link administration routes
  require the appropriate account or guest credential. Upload sessions are bound to
  the exact account or guest link that opened them.
- Upload bodies stream to disk, have per-file and total caps, clean partial failures,
  and validate chunk size plus optional SHA-256. Completion requires every marker.
- Download counts are serialized per id; continuation ranges require a recent counted
  transfer; exhausted content is retired after streams close. Content length comes
  from disk, not metadata.
- Content-Disposition is sanitized and arbitrary active content is attachment-only.
  Public responses use no-store and nosniff where relevant. ZIP output is streamed,
  entry-count capped and uses safe unique names.
- CSP uses per-request nonces. Clickjacking, MIME sniffing, referrer, permissions,
  opener and host-only HSTS headers are configured; framework disclosure is disabled.
- The store sweeps expired content, tombstones, abandoned sessions and guest links.
  systemd and Compose run unprivileged with read-only code, no added capabilities and
  bounded exposure. The systemd unit also limits memory, tasks and file descriptors.

## Internet-facing deployment requirements

- Bind DocDrop only to loopback or an internal container network. Terminate TLS at a
  maintained reverse proxy/tunnel; never publish the application listener directly.
- The closest proxy must replace inbound X-Forwarded-For, which rate limiting trusts.
  **Cloudflare Tunnel does not replace X-Forwarded-Host**, verified live, which is why
  origin reconstruction no longer reads it: it uses Host, which the tunnel sets and a
  page cannot forge cross-origin without turning the request into one that needs
  permission first. Set `DOCDROP_PUBLIC_HOST` only behind a proxy that rewrites Host.
- Run one process. In-memory rate limits, quota/download locks and transfer continuation
  state are process-local; multiple replicas require shared coordination.
- Use at least 32 random bytes for DOCDROP_SESSION_SECRET, keep the environment file
  owner-readable only, rotate it after suspected disclosure, and configure the OIDC
  client for an exact HTTPS callback.
- Apply independent edge connection, request-rate and body limits. App limits bound
  stored bytes but do not eliminate bandwidth, slow-client or descriptor exhaustion.
- Monitor service restarts, disk free space, quota usage, cleanup failures and health.
  Alert before the filesystem containing the data volume approaches exhaustion.
- Keep Node, the container base, npm dependencies, proxy and host OS patched. Pin a
  release tag rather than latest/main when controlled upgrades matter.
- Test the deployed response headers, callback URL, forwarded-address behavior and a
  representative upload/download through the real proxy.

## Retention and backup policy

Payloads promise expiry and self-destruction. A conventional snapshot of the data
volume silently breaks that promise because deleted files remain recoverable from the
backup. Choose and document one policy:

- Privacy-first default: do not back up the payload volume. Treat uploads as transient
  transfer copies, not durable storage.
- Recovery policy: encrypt backups, restrict operators, and expire every snapshot no
  later than the shortest promised file TTL. State clearly to users that deletion from
  the live store does not immediately erase existing snapshots.

The data directory also contains local user records and guest-link metadata. If those
small records require disaster recovery, separate them from payloads before adopting
a different retention schedule; copying the whole directory also copies file content.

## Verification gates

Run against a fresh production build:

    npx next typegen
    npx tsc --noEmit
    npx eslint src scripts
    npm run build
    npm test
    npm audit
    docker compose config

Results on 2026-08-27:

- Clean lockfile install and full dependency audit: pass, 0 vulnerabilities.
- Type generation, TypeScript, ESLint, production standalone build and diff check: pass.
- Three isolated suites: 109 passed, 0 failed.
- Docker Compose validation: pass.
- Standalone contains no upload directory or environment file.
- Tracked private-key and pending-marker scan: no actionable findings.

Also inspect the standalone artifact to confirm it contains no upload directory or
environment file, and scan tracked files for credentials/private keys.

Repository checks cannot prove the live firewall, TLS configuration, proxy header
replacement, DNS, host filesystem permissions, monitoring or backup retention. Those
are deployment acceptance checks on the actual host.
