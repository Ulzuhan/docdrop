# Changelog

## 3.0.0 — 2026-09-07

The server is now a single Go binary with the interface embedded. **The
production image no longer contains Node**; Node stays to build the interface
and run the test suites.

Nothing about the service changes for whoever uses it: same routes, same status
codes, same headers, same on-disk format and the same links. Encryption stays in
the browser — `src/lib/e2ee.ts` was not ported, duplicated or touched — and the
server still cannot open what it stores.

The major bump is for **whoever runs it**: the entrypoint changes. A compose file
carrying `exec node start.js` must be changed to `exec docdrop`. The image still
runs as uid 1001 and still keeps its data in `/data`.

- **Same data, both ways.** The format is exactly 2.3.1's: same paths, timestamps
  in milliseconds and optional fields absent when they do not apply. Counters are
  always written even when zero — with them missing, the Node rollback would do
  `undefined++`, write `null`, and the download limit would stop existing.
  `scripts/test-compatibilidad.sh` proves the round trip against the exact
  rollback digest, by turns and with no simultaneous writers.
- **Shutdown designed for hours-long transfers.** Admission closes, in-flight
  transfers are cut in a controlled way rather than waited for, and each one
  leaves the store as if it had never happened: the download does not count and
  releases its slot, a half-written chunk is not marked received, and the space
  reservation is freed. The budget (8 s, `DOCDROP_SHUTDOWN_MS`) fits inside the
  10 s the container grants.
- **`exp` is now required** in a back-channel `logout_token`, and a notice
  carrying only `sid` is answered with 400 instead of a 200 that revoked nothing.
  An `iat` older than 5 minutes is rejected.
- **The session sweep can no longer delete a finished file.** If completing an
  upload wrote `meta.json` but failed to remove `session.json`, the old sweep
  removed the whole entry 24 hours later — a valid file, with its link already
  shared, gone with no explanation.
- **`/api/zip` refuses encrypted bundles** with a reason. The dashboard already
  excluded them from the selection; what was left open was the URL by hand, which
  packed unusable ciphertext and spent one download of each.
- **Two writes of the same chunk no longer interleave.** Each chunk is written
  at its position inside the final file, so two requests for the same index
  write to the same place. They used to interleave, and the bad part was not the
  ordering: a request *rejected* by checksum had already left its bytes there.
  The good one answered 200, marked the chunk received, and the file somebody
  downloaded carried the rejected bytes inside — with nothing failing anywhere.
  Each index now has its own lock and the check is repeated inside it: a resend
  arriving after the chunk is already stored and verified answers
  `alreadyReceived` **without writing**. Different chunks still go in parallel.
- **Completing and cancelling now take the upload exclusively.** A chunk still
  being written could previously outlive them: it wrote into a file the
  application already considered finished — with its link already shared and its
  record claiming another size — and recreated `parts/` inside it.
- **The ZIP takes each size from disk and checks it against the record.** It used
  to trust the record and copy through a reader capped at that size: a shorter
  file — truncated by a write failure or a full disk — ended at EOF with no
  error, the archive closed as good, and **every file counted as downloaded**.
  Whoever opened it got a short file with nothing to say so. A file that does not
  match now stays out and releases its slot without counting, and one that runs
  short mid-send leaves the archive unclosed, so the recipient sees a broken
  archive rather than a mutilated file that looks whole.
- **A request carrying both a session and a guest token now counts as both.**
  Signing in and then opening a guest link in the same browser — the operator
  testing their own link, or anyone with an account who receives one — opened the
  chunked upload as `guest:<token>` and then identified every chunk as
  `user:<id>`. They never matched, and the upload died with 404 "Upload session
  not found". Found by driving the guest page in a browser, and reproduced
  against the published 2.3.1 image before changing anything. What the check
  protects still holds: with two different guest links, the second one still
  cannot touch the first one's upload.
- **Own healthcheck** (`/healthz`, `docdrop sonda`) instead of `/api/info/<id>`,
  which goes through the rate limiter and shares its bucket with real traffic.
- Cookies are `Secure` by default, with an explicit exception
  (`DOCDROP_INSECURE_COOKIES=1`) for local HTTP. It used to depend on `NODE_ENV`,
  which does not exist in a binary.
- The image is about 26 MB instead of ~150 MB.

Node is kept as the rollback reference: `Dockerfile.node` builds the 2.3.1 image
and every suite still runs against it. It will be retired once the deployment has
been observed and accepted, not before.

## 2.3.1 — 2026-09-04

- Validate byte ranges and blob availability before reserving a download.
  Invalid ranges and cancelled transfers cannot grant free resume credit.
  Register continuations only after successful delivery and accounting.
- Keep quota reservations until their counter update finishes; distinguish
  reservations created in the same millisecond and settle each only once.
- Release idle per-file serialization queues, including failures and unknown
  IDs, without removing queues belonging to subsequent operations.
- Add regression tests for ranges, interrupted reads, concurrent reservations,
  quota failures and queue retention. Unit tests use isolated temporary stores.
- CI now runs every HTTP suite: access, files, upload and end-to-end encryption,
  in addition to unit and OIDC back-channel tests.

No configuration or data migration is needed. Existing inline previews and
continuations of already-accounted downloads remain supported while available.
