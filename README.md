# DocDrop

[![CI](https://github.com/Ulzuhan/docdrop/actions/workflows/ci.yml/badge.svg)](https://github.com/Ulzuhan/docdrop/actions/workflows/ci.yml)
[![Container image](https://github.com/Ulzuhan/docdrop/actions/workflows/docker.yml/badge.svg)](https://github.com/Ulzuhan/docdrop/pkgs/container/docdrop)
[![Release](https://img.shields.io/github/v/release/Ulzuhan/docdrop)](https://github.com/Ulzuhan/docdrop/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Self-hosted file sharing with expiring links. Someone uploads a file, shares the
link, and whoever wants it downloads it. The file deletes itself once it expires or
runs out of downloads.

The problem it was built for: passing a 7 GB GoPro video between phones and laptops
**without a messaging app recompressing it**.

- **Go** on the server · React 19 with a hand-written CSS design system, built with Vite
- One binary: the interface is embedded, and the production image has no Node
- No database: files and their metadata live on disk
- Installable PWA, with support for the mobile "Share" menu
- Multi-file and whole-folder uploads, chunked and resumable
- End-to-end encrypted: files are encrypted in the browser and the key travels in
  the part of the link the server never receives
- Preview video, audio and images before downloading
- Download several files at once as a streamed ZIP

![Dashboard: the drop zone, the settings for new uploads, a multi-GB upload in flight with its speed and time left, and the active files with their remaining life](assets/dashboard.png)

<p align="center">
  <img src="assets/mobile.png" alt="The dashboard on a phone: single column, touch-sized controls" width="49%">
  <img src="assets/download.png" alt="What the recipient of a link sees: the file, its expiry and download limit, and the download button" width="49%">
</p>

## Quick start

DocDrop runs one Go process with an embedded React interface. There is no Node
server, Next.js application or database to operate. An OIDC provider is required
for sign-in; without credentials, uploads and the dashboard remain closed.

### Docker

Copy [`.env.example`](.env.example) to `.env`, generate a session secret with
`openssl rand -hex 32`, and configure the OIDC client, issuer and callback URL.
Then:

```bash
docker compose up -d
```

The supplied Compose file reads `.env`, binds to `127.0.0.1:3010`, and keeps
uploads in a named volume at `/data`. Put a TLS proxy in front of it. The image
runs as uid **1001** and includes the `docdrop sonda` healthcheck.

For standalone Docker, pass the same configuration explicitly:

```bash
docker run -d --name docdrop --env-file .env \
  -p 127.0.0.1:3010:3010 -v docdrop-data:/data \
  ghcr.io/ulzuhan/docdrop:3.0.0
```

Pin a verified image digest for production. `:latest` follows releases;
`:main` follows development and is not a release. See
[deployment and rollback](DEPLOYMENT.md) for proxy requirements, update procedure
and the no-payload-backup policy.

### Development and building

Build prerequisites: **Go 1.27.1**, **Node 22+** and npm. Node only builds the
frontend or runs test tooling; React executes in the user's browser.

```bash
npm ci
npm run dev
```

This builds React and Go, then runs the binary on `http://127.0.0.1:13010` with
an isolated local store in `.local/data`. It does not start Next or offer hot
reload: rerun it after changes. Credentials are not invented for development.
For an authenticated local session, export a trusted env file first:

```bash
cp .env.example .env
# Fill in OIDC credentials and a callback matching the local origin.
set -a
source .env
set +a
npm run dev
```

The dev launcher permits non-Secure cookies on loopback HTTP only. All normal
starts use Secure cookies unless explicitly overridden. The binary does **not**
load env files automatically.

To build a distributable binary:

```bash
npm run build               # Vite assets, then go build with -trimpath
HOSTNAME=127.0.0.1 ./docdrop # port 3010 by default
```

Copy that binary to a compatible host; there is no npm install or separate asset
folder at runtime. For systemd installation with a dedicated user and sandbox,
see [deploy/README.md](deploy/README.md).

## Architecture

```text
cmd/docdrop/       process, healthcheck and bounded shutdown
internal/auth/     OIDC/PKCE, signed sessions, revocations and guest links
internal/httpapi/  HTTP routes, streaming transfers, HTML and security headers
internal/store/    JSON metadata, blobs, quotas and download reservations
internal/uploads/ resumable chunk state and synchronization
internal/web/     embedded build output (not committed)
src/screens/      dashboard, recipient and guest React screens
src/components/   shared UI, account controls and upload queue
src/lib/          browser encryption, resumable transport and presentation helpers
src/styles/       design tokens, hand-written CSS and locally hosted fonts
public/           PWA service worker, manifest resources and icons
scripts/          isolated functional/browser tests and pinned rollback test
```

Go renders the HTML shell and supplies validated page data to React. Vite compiles
hashed assets, copied into `go:embed`; navigation is ordinary links handled by Go.
`next-themes` remains a React theme utility: it does not require a Next server.
There is a single maintained implementation of each screen and of the backend.

## Access model

Accounts come from the configured OIDC provider. A signed-in user lists and deletes
**only their own files**. Files uploaded through a guest link belong to the account
that minted it; the guest can upload, but cannot enumerate the store or enter the
panel. Legacy files without an owner are not listed to any account; their existing
capability links still work until expiry.

Download IDs are capabilities, not public directory entries. Anyone with a valid
link can use it within its expiry/download limits. Do not log full capability URLs.

Sessions are HMAC-SHA256 cookies, Secure and HttpOnly with SameSite protection.
The provider can revoke them through `POST /api/auth/backchannel-logout`, which
persists revocations checked on subsequent requests. Without a notification,
provider-side access removal is bounded by the cookie lifetime: 12 hours by
default, configurable from 1 to 24. Rotating `DOCDROP_SESSION_SECRET` revokes all
sessions. Configure the provider's logout callback; account removal alone is not
an immediate revocation mechanism.

## End-to-end encryption

Files encrypt **in the browser by default**, using AES-256-GCM in 4 MiB chunks.
The content, real filename and MIME type are inside the authenticated envelope;
the server stores ciphertext with the neutral name `encrypted`.

The key travels in the link's **#fragment**, which browsers do not send to the
server. Keys are also kept in the uploading browser's local keyring. Losing both
the complete link and that browser profile loses access: there is no recovery key.
A guest must send the complete link back to the person requesting the upload.

- Chunk ordering, truncation and extension are authenticated.
- Downloads decrypt through a streaming service worker where supported. Browsers
  without that path fall back to memory with a warning for very large files.
- Unencrypted uploads remain an explicit option for server previews and ZIPs.
  Encrypted files are excluded from server-side ZIP and preview paths.
- Size, ownership, expiry and counters remain visible metadata.

[`src/lib/e2ee.ts`](src/lib/e2ee.ts), its client helper and the resumable transport
were kept intact through the backend cleanup. The server never receives the key.

## Large files and transfer correctness

The default limits are **10 GiB per file** and **20 GiB total**. Files and whole
folders are queued two at a time; uploads use 32 MiB chunks, checksums and resume
markers. Picking the same file after an interruption resumes its missing chunks.
Half-finished uploads expire after 24 hours.

Transfers stream instead of buffering whole files. Each chunk writes directly to
its final offset; duplicate writes of the same index are serialized, and completion,
cancellation and cleanup cannot race a chunk into a published corrupted file.

A download counts only after a complete server-side transfer. In-flight requests
reserve a slot so concurrent readers cannot exceed the limit. Interrupted transfers
release their slot; previews do not consume one, and range continuations follow
the existing download contract.

ZIP output streams without compression, supports ZIP64 and disambiguates duplicate
names. Missing, expired or size-mismatched entries are skipped without consuming a
download. A file truncated during transfer must not produce a falsely successful ZIP.

The hourly sweep removes expired payloads and abandoned uploads. Exhausted files
leave a seven-day tombstone so a link can explain why it no longer works.

## PWA

The service worker supports mobile sharing and streaming decrypted downloads; it
deliberately does not cache an old application shell. HTTPS is required outside
localhost for these browser APIs. Icons and fonts are self-hosted; regenerate icons
only when the design changes with `node scripts/generate-icons.mjs`.

## Configuration

Everything is environment variables. Only the sign-in ones are required; the rest have
working defaults.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3010 | Listening port |
| `DOCDROP_DATA_DIR` | `.docdrop-uploads` | Where files live |
| `DOCDROP_MAX_FILE_BYTES` | 10 GiB | Maximum size per file |
| `DOCDROP_MAX_TOTAL_BYTES` | 20 GiB | Total storage; keeps the disk from filling |
| `DOCDROP_CHUNK_BYTES` | 32 MiB | Chunk size |
| `DOCDROP_REQUEST_TIMEOUT_MS` | 12h | Maximum duration of a request |
| `DOCDROP_SESSION_SECRET` | — | Signs the session cookie. **Required** to sign in |
| `DOCDROP_SESSION_TTL_HOURS` | 12 | Session lifetime, clamped to 1–24 hours |
| `DOCDROP_OIDC_CLIENT_ID` | — | **Required.** See [Access model](#access-model) |
| `DOCDROP_OIDC_CLIENT_SECRET` | — | **Required** |
| `DOCDROP_OIDC_REDIRECT_URI` | — | **Required.** `https://your-host/api/auth/callback` |
| `DOCDROP_OIDC_ISSUER` | — | **Required.** The provider's issuer URL. Every endpoint (authorize, token, userinfo, end-session, JWKS) is read from its `/.well-known/openid-configuration`, so no provider-specific paths are baked in |
| `DOCDROP_OIDC_INTERNAL_BASE` | issuer origin | Where the server talks to the provider, if that differs from the public origin |
| `DOCDROP_OIDC_TIMEOUT_MS` | 10000 | Timeout for token and userinfo calls |
| `DOCDROP_PUBLIC_HOST` | unset | Public hostname the origin check compares against. Unset, the incoming `Host` is used, for a proxy that preserves it. Only needed behind a proxy that rewrites `Host` with an internal name. |
| `DOCDROP_ENROLL_URL` | unset | Where the landing's "Request an account" button sends people — your provider's self-service enrollment flow, if it has one. Unset, the button is not rendered and the landing only offers sign-in. |
| `DOCDROP_ACCOUNT_URL` | unset | The provider's own account page — email, password, second factor, sessions. None of that belongs to this app, and without it the account menu simply does not link anywhere. The path is the provider's own; copy it from there. |
| `DOCDROP_INSECURE_COOKIES` | unset | Set to `1` only for local HTTP development; cookies are Secure otherwise. |
| `DOCDROP_SHUTDOWN_MS` | 8000 | Total shutdown budget; keep below the container or service stop timeout. |

## Validation

```bash
npm ci
npm run lint && npm run typecheck
npm test                       # build, crypto, Go -race, HTTP and back-channel
go vet ./cmd/... ./internal/...
npx playwright install chromium
npm run test:navegador          # real browser + synthetic OIDC over HTTPS
npm run test:compatibilidad     # Docker: pinned Node 2.3.1 -> Go -> same Node
```

For the final image, not just the local binary:

```bash
docker build -t docdrop-go:ci .
DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh \
  DOCDROP_TEST_BUILD_STAMP=Dockerfile npm run test:http
DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh \
  DOCDROP_RED_HOST=1 npm run test:navegador
```

CI retains frontend checks, Go race tests, **156 HTTP checks**, back-channel logout,
**39 browser checks against the binary and final image**, and **55 rollback
compatibility checks**. Stores and identities are synthetic and isolated; never
point these suites at production. They are functional tests, not a load campaign.
The browser journey checks login, owner and guest uploads, actual decryption,
byte-for-byte downloads, deletion, logout, styles and PWA resources.

## Security and maintenance

Run **one process per store** behind a trusted TLS proxy. Quota, rate limits and
in-flight reservations are process-local. The proxy must replace forwarded IP
headers and preserve the public Host (or configure `DOCDROP_PUBLIC_HOST`).
Do not expose the application port directly to untrusted clients.

Data retention is part of the product: **do not back up payloads beyond their
promised lifetime**. Rolling back means restarting the old verified image over the
**current** store, never restoring expired files or spent download counters.

The active branch contains no legacy backend. Historical source remains in Git;
the published 2.3.1 image remains the pinned compatibility/rollback reference.
Node/npm, Playwright and browsers belong to build/test environments only.

- [Deployment and rollback](DEPLOYMENT.md)
- [HTTP and data contracts](CONTRATOS.md)
- [Repository cleanup and validation record](docs/CLEANUP-2026-09-08.md)
- [Original migration plan](docs/PLAN-MIGRACION-GO.md)
- [Historical security audit](docs/SECURITY-AUDIT.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
