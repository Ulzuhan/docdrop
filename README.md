# DocDrop

Self-hosted file sharing with expiring links. Someone uploads a file, shares the
link, and whoever wants it downloads it. The file deletes itself once it expires or
runs out of downloads.

The problem it was built for: passing a 7 GB GoPro video between phones and laptops
**without a messaging app recompressing it**.

- Next.js 16 (App Router) · React 19 · Tailwind v4 · shadcn/ui
- No database: files and their metadata live on disk
- Installable PWA, with support for the mobile "Share" menu
- Multi-file and whole-folder uploads, chunked and resumable
- Preview video, audio and images before downloading
- Download several files at once as a streamed ZIP

---

## Quick start

### Docker

```bash
docker run -d --name docdrop \
  -p 127.0.0.1:3010:3010 \
  -v docdrop-data:/data \
  ghcr.io/ulzuhan/docdrop:latest
```

Or with Compose, using the [`compose.yaml`](compose.yaml) in this repo:

```bash
docker compose up -d
```

Uploads live in the `/data` volume, so replacing the container never loses them.
The image runs as an unprivileged user, ships a healthcheck, and is built for
`linux/amd64` and `linux/arm64`.

Exposing it works the same as any other container — a tunnel or reverse proxy points
at the port. Either run the tunnel on the host against `127.0.0.1:3010`, or add
cloudflared as a second service in Compose so it reaches DocDrop over the internal
network and **nothing is published on the host at all**. `compose.yaml` has both
variants commented in.

To set a password:

```bash
docker run --rm ghcr.io/ulzuhan/docdrop:latest node scripts/set-password.mjs
# put the two lines it prints in the container environment and restart
```

### From source

```bash
npm install
npm run build     # builds and prepares the standalone output
npm run start     # runs on http://127.0.0.1:3010
```

> **Always start it with `npm run start`, never with `next start`.**
>
> `npm run start` runs `scripts/start.js`, which raises the HTTP server's
> `requestTimeout` before handing control to Next (see
> [Wall 2](#wall-2--nodes-5-minute-request-timeout)). Running `npx next start`
> brings the cut-off back: large uploads die mid-transfer. It is also incompatible
> with `output: standalone`.

The port comes from `PORT`. For development, `npm run dev` works as usual.

### Reaching it from outside

The service listens on **127.0.0.1 only**. To reach it from a phone or from outside
the network, put a tunnel or a reverse proxy in front:

```bash
# Temporary public tunnel (Ctrl-C closes it)
cloudflared tunnel --url http://127.0.0.1:3010

# Private mesh, only your own devices
tailscale serve --bg --https=8443 http://127.0.0.1:3010
```

Both give you HTTPS, which is required to install the PWA and to receive files from
the phone's share sheet.

### Keeping it running

`npm run start` dies when the terminal closes. A user service is usually enough:

```ini
# ~/.config/systemd/user/docdrop.service
[Unit]
Description=DocDrop
[Service]
WorkingDirectory=%h/path/to/docdrop
ExecStart=/usr/local/bin/node scripts/start.js
Environment=PORT=3010
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now docdrop
sudo loginctl enable-linger "$USER"   # survives without an open session
```

For a properly isolated deployment — dedicated user, sandboxed systemd unit — see
[`deploy/`](deploy/README.md). It is optional.

---

## Access model

By default it starts **open**: anyone who reaches the service can upload and see the
full listing. That suits a private network, or a tunnel that is opened and closed by
hand — but while that tunnel is up, anyone with the URL has write access.

Adding a password splits it in two:

| Route | With a password configured |
|---|---|
| `/`, `/api/upload*`, `/api/files*`, `/api/cleanup` | Requires a session |
| `/d/[id]`, `/api/info/[id]`, `/api/download/[id]` | Public (the 72-bit id is the secret) |

That way a file can be shared with someone without handing out credentials.

```bash
npm run set-password        # or: npm run set-password 'my password'
# paste the two lines it prints into the process environment and restart
```

The mode it started in is logged on boot (`[docdrop] mode: OPEN` or `PROTECTED`), so
running open is always a decision rather than the result of a lost config file.

---

## Large uploads

This is where most of the work went, because a multi-gigabyte file hits three
different walls, each with its own symptom.

### Wall 1 — server memory

The naive implementation reads the whole file into memory (`request.formData()` on
the way in, `readFile()` on the way out). With a 10 GB limit advertised, the process
dies long before getting there: Node's `Buffer` cap is around 2 GB.

Everything is streamed in both directions instead. Verified with a 3 GB file: it goes
up and comes back byte-for-byte identical with server memory flat at ~160 MB.

### Wall 2 — Node's 5-minute request timeout

Node aborts with **408** any request lasting longer than `server.requestTimeout`,
whose default is **300,000 ms (5 minutes)**. An upload is *one single* HTTP request,
so a large file is cut off mid-transfer: at ~19 MB/s the limit lands around 5.6 GB,
meaning a 7 GB video dies just past 80% with no clear error.

Reproduced with an upload rate-limited to 512 KB/s:

```
before:  http=408  time=306.06s  uploaded=160,563,200 of 200,000,000  (76%)
after:   http=200  time=380.79s  uploaded=200,000,000                 (100%)
```

Next only exposes `keepAliveTimeout`, not `requestTimeout`, and its documentation
rules out combining `output: standalone` with a custom server. So `scripts/start.js`
intercepts the creation of the HTTP server, raises the per-request limit to 12h and
then starts Next. `headersTimeout` stays at 60s — that is the one protecting against
clients dribbling headers out — and the body cannot grow unbounded because
`/api/upload` cuts it off at the maximum size.

### Wall 3 — the proxy's per-request cap

Measured against a Cloudflare quick tunnel:

| Size in a single request | Result |
|---|---|
| 500 MiB (524,288,000 B) | HTTP 200 |
| 511.99 MiB | HTTP 413 |
| 512 MiB and above | HTTP 413 **in 0.55s** |

The rejection is immediate: Cloudflare cuts it off after reading `Content-Length`,
without transferring anything. (Cloudflare's docs quote 100 MB for the free plan; the
limit actually measured on quick tunnels is 500 MiB.) **Downloads have no such cap**:
600 MB came back through the same tunnel at 30 MB/s.

### The fix: chunked uploads

The browser no longer sends one giant request. It splits the file into 32 MiB chunks
and sends each one separately. Every chunk is written **straight into its position**
inside the final file, so there is no assembly phase and no duplicated disk space.
Which chunks arrived is tracked with empty marker files, atomic and lock-free.

```
POST   /api/upload/init             opens the upload → { uploadId, chunkSize, totalParts }
PUT    /api/upload/[id]/part/[n]    sends one chunk (idempotent)
GET    /api/upload/[id]             which chunks are missing
POST   /api/upload/[id]/complete    closes it and publishes the file
DELETE /api/upload/[id]             cancels
```

While an upload is in flight the on-disk entry looks like this:

```
<id>/file          final file, pre-allocated at its definitive size
<id>/session.json  upload metadata
<id>/parts/<n>     marker for "chunk n is written"
```

On completion `<id>/meta.json` appears and `session.json` and `parts/` go away, so it
becomes a regular file for the rest of the app.

**Resuming.** The browser remembers the upload id under a fingerprint of the file
(name + size + last modified). If the upload is interrupted — screen locked, wifi
switched to mobile data, tab closed — picking the same file again asks which chunks
are missing and **carries on where it left off**. Half-finished uploads stay
resumable for 24h, then the sweep clears them.

Verified with the same file through the same tunnel:

```
600 MB in one request  ->  HTTP 413
600 MB in 18 chunks    ->  completed in 46s, no failures
download back          ->  identical SHA-256
```

---

## Uploading several at once

Drop several files, pick them from the file dialog, or drag a whole folder (walked
recursively). The queue uploads **two at a time**: firing them all at once splits the
bandwidth across many connections and nothing finishes, which with multi-GB videos is
the worst outcome.

While anything is uploading a **Wake Lock** is held so the phone screen does not turn
off. Without it the system suspends the upload on lock: progress is not lost, but the
user has to come back and pick the file again.

## Downloading several as a ZIP

Select files in the listing and grab them in one go. The archive is generated **by
streaming and without compression** ("store"): video and photos are already
compressed, so deflate would only burn CPU. It streams at disk speed and uses no
temporary space on the server.

- **ZIP64 when needed.** A 7 GB video does not fit in the 32-bit fields of the classic
  format; without it the archive would be corrupt in exactly the case this exists for.
  Verified with a 4.5 GB file: `unzip -t` validates it, the content comes out intact,
  and the format overhead is 250 bytes.
- **Data descriptors**, so each file is not read twice nor buffered just to compute
  its CRC up front.
- Duplicate names get renamed inside the archive (`photo.jpg`, `photo (2).jpg`).
- Each included file counts as one of its own downloads. Files that are no longer
  available are skipped rather than failing the whole archive.

```
GET /api/zip?ids=a,b,c&name=trip
```

## Integrity

The browser sends each chunk's SHA-256 in `X-Chunk-Sha256` and the server verifies it
before accepting the chunk; on mismatch it answers 422 and does **not** mark it as
received, so the client re-sends it. Without this, with automatic retries in play, a
corrupted chunk would slip through unnoticed because the size still added up.

The header is optional: `crypto.subtle` only exists in secure contexts (HTTPS or
localhost), so over plain HTTP on a local IP uploads still work, just unverified.

## PWA

Installable on a phone's home screen. The manifest declares `share_target`, so
DocDrop shows up in the **share sheet**: pick a video in the gallery, share it to
DocDrop, done — no browser, no hunting for the file. The service worker receives that
POST, stores the file briefly and redirects to the page, which uploads it.

The service worker **deliberately does not cache the app**: for a self-hosted service,
serving a stale version causes more problems than it solves.

Icons are generated with `node scripts/generate-icons.mjs`, which rasterises them and
writes the PNG using only `zlib` — no ImageMagick, no Pillow. The PNGs are committed;
re-run it only if the design changes.

HTTPS is required: through a tunnel it works, over plain HTTP on a local IP the
browser will not allow installing or sharing.

## Tests

```bash
npm run start &
npm run test:upload
```

18 checks over the upload protocol: chunking, resuming, idempotency, checksums,
invalid indexes and limits. No dependencies and no test framework — it runs against a
live server and cleans up after itself.

---

## API

| Method and route | Purpose |
|---|---|
| `POST /api/upload` | Single-request upload (small files) |
| `POST /api/upload/init` | Opens a chunked upload |
| `PUT /api/upload/[id]/part/[n]` | Sends one chunk |
| `GET /api/upload/[id]` | Status, used to resume |
| `POST /api/upload/[id]/complete` | Closes the upload |
| `DELETE /api/upload/[id]` | Cancels a half-finished upload |
| `GET /api/files` | Active files + storage usage |
| `DELETE /api/files/[id]` | Deletes a file |
| `GET /api/info/[id]` | File metadata · **public** |
| `GET /api/download/[id]` | Download, supports `Range` · **public** |
| `GET /api/download/[id]?inline=1` | Preview without consuming a download · **public** |
| `GET /api/zip?ids=a,b,c` | Several files as one archive · **public** |
| `POST /api/cleanup` | Purges expired, exhausted and abandoned uploads |
| `POST /api/auth/login` · `/api/auth/logout` | Session, when a password is set |

## Configuration

Everything is environment variables; none is required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3010 | Listening port |
| `DOCDROP_DATA_DIR` | `.docdrop-uploads` | Where files live |
| `DOCDROP_MAX_FILE_BYTES` | 10 GB | Maximum size per file |
| `DOCDROP_MAX_TOTAL_BYTES` | 20 GB | Total storage; keeps the disk from filling |
| `DOCDROP_CHUNK_BYTES` | 32 MiB | Chunk size |
| `DOCDROP_REQUEST_TIMEOUT_MS` | 12h | Maximum duration of a request |
| `DOCDROP_PASSWORD_HASH` | — | Enables the dashboard password |
| `DOCDROP_SESSION_SECRET` | — | Signs the session cookie |

## Security

Written on the assumption that it may be exposed to the internet through a tunnel
that provides no WAF and no filtering of its own.

- **Total storage quota**, so nobody can fill the machine's disk and take every other
  service on it down.
- **Per-IP rate limiting**: 5 login attempts per 15 min, 30 uploads/hour, 240
  downloads/min. The IP comes from the **last** value of `X-Forwarded-For`, which the
  proxy overwrites. `X-Real-Ip` is deliberately not used: Tailscale was verified to
  pass it through untouched, so a client could invent one per request and dodge the
  limit.
- **Ids are validated** before touching the filesystem: without that, an id like
  `../../etc` escapes the data directory.
- **Headers**: CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `nosniff`, and no `X-Powered-By`.
- **Uploads are only served inline for types that cannot run scripts** (video, audio,
  images except SVG, PDF). Anything else is forced to `attachment`. Serving arbitrary
  uploads inline from the same origin is what turns a file service into stored XSS.
- The password is stored only as a **scrypt** hash and compared in constant time; the
  session is an HMAC-SHA256 signed cookie, `httpOnly` + `secure` + `sameSite`.

## Maintenance

The server **sweeps the store every hour** on its own (see `instrumentation-node.ts`):
expired files, exhausted ones and abandoned uploads. Without it an expired file was
only deleted when someone tried to open it, so it kept eating into the quota forever.

To force it by hand:

```bash
curl -X POST http://127.0.0.1:3010/api/cleanup
```

When a file runs out of downloads its content is deleted but a tombstone is kept for
7 days, so the link can answer "max downloads reached" instead of an ambiguous 404.

---

## Dependencies

`npm audit` reports **0 vulnerabilities**. Two things were needed to get there and are
worth knowing if the report ever looks alarming again:

- **`npm audit` over-reports Next.** It merges the ranges of every advisory, including
  the ones that only affect `canary`/`preview` branches, so a version that is already
  patched still shows up as affected. Checking the advisories one by one
  (`gh api /advisories/GHSA-...`) showed all nine were fixed in 16.2.11 — the version
  here is newer. **Never run `npm audit fix --force` on this**: its "fix" is to
  downgrade Next to 9.3.3, a release from 2020.
- **`overrides`** pin `sharp` and `postcss` to patched versions inside Next's own
  dependency tree, where the real (not over-reported) advisories were.

## Implementation notes

Things that were hard to find and are worth not breaking again:

- **One source of truth.** There used to be two in-memory caches (one module-scoped
  in `/api/upload`, another on `globalThis` in `/api/download`) that drifted apart
  from each other and from disk, so the listing showed stale download counters. Disk
  decides, full stop.
- **The download counter is serialised per id.** Without it, simultaneous downloads
  read the same value and slipped past the limit.
- **The sweep respects uploads in flight.** It used to delete any directory without a
  `meta.json` older than an hour, which would have killed a multi-GB upload mid-way.
- **`Content-Length` comes from the real file**, not from the stored metadata.
- **`Content-Disposition` uses `filename*`** (RFC 5987) or non-ASCII names arrive
  mangled.
- **`serverExternalPackages` is not for native modules.** It listed `fs`, `path` and
  `crypto` "to allow large uploads"; it did absolutely nothing.
- **`Date.now()` is never read during render.** It is impure and it also left the
  expiry countdowns frozen at whatever value they had when the page opened.
- **The build tracer copies uploaded files into the standalone output.** It cannot
  resolve the data directory statically (env var or `process.cwd()`), so it traces the
  whole project — putting user content inside the deployment artifact and inflating it
  from 34 MB to 200+ MB. Neither `outputFileTracingExcludes` (ignored by the Turbopack
  tracer) nor a `turbopackIgnore` comment prevents it, so the postbuild step removes
  it explicitly. If the data directory is ever renamed, keep that step in sync.

This project targets a Next version whose conventions differ from older docs
(`middleware.ts` → `proxy.ts`, `RouteContext<'/route'>`, route handlers uncached by
default). See `AGENTS.md`: check `node_modules/next/dist/docs/` before assuming an
API behaves the way you remember.

## License

MIT — see [LICENSE](LICENSE).
