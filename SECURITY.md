# Security policy

DocDrop hands out files through links that expire. Two things carry the weight:
the link is a capability, and since 2.0.0 the file underneath it is encrypted in
the browser. Reports that break either one are the ones we want.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/Ulzuhan/docdrop/security/advisories/new)
on this repository. That channel stays private until we publish it together.

Please do not open a public issue for anything exploitable.

**What to expect:** an acknowledgement within 72 hours, an assessment within
7 days, and a fix or a written explanation of why there is not going to be one.
You will be credited in the advisory unless you would rather not be. There is no
bounty.

## What it is, in security terms

- **End-to-end encrypted uploads.** The file is encrypted in the browser and the
  key travels in the part of the link the server never receives.
- **Download IDs are capabilities, not directory entries.** Anyone holding a
  valid link may use it within its expiry and download budget. Do not log full
  capability URLs: a log that collects them is a list of open doors.
- **No database.** Files and their metadata live on disk, and they delete
  themselves when they expire or run out of downloads.
- **Uploading needs an account; downloading needs the link.** A signed-in person
  lists and deletes only their own files. Files uploaded through a guest link
  belong to the account that minted it — the guest can upload, and cannot
  enumerate the store or enter the panel.
- **Sessions are HMAC-SHA256 cookies**, Secure, HttpOnly and SameSite, 12 hours
  by default and clamped to 1–24. Back-channel logout persists revocations that
  are checked on later requests; without that notification, removing access
  upstream is bounded by the cookie's lifetime. Rotating the session secret
  revokes every session at once.
- **HTTPS is not optional in practice.** Browser encryption, the streaming
  download worker and chunk integrity all use APIs that exist only in secure
  contexts.

## In scope

- Enumerating the store, or reaching a file without its capability link.
- Downloading an expired file, or one whose budget is spent.
- A guest link that reaches the panel, another account's files or the listing.
- Any path where the key or the plaintext reaches the server, a log or a third party.
- Forging or replaying a session; bypassing the size or total-storage limits.
- Chunked or resumable upload flows that let one account write into another's file.

## Out of scope

- Scanner output with no working exploit, or missing headers with no shown impact.
- Volumetric denial of service. A way *around* a documented limit is in scope;
  sending more traffic than a host can take is not.
- Misconfiguration of your own deployment, unless an unsafe default here causes it.
- Sharing a capability link with the wrong person.

## What it does not claim

Files uploaded before 2.0.0 are not encrypted at rest, and their metadata never
was: a copy of the data directory made then is readable. That is also why the
deployment guide says not to back up `/data` — a backup that outlives the expiry
turns "this deletes itself" into decoration, and restoring one revives files
somebody already withdrew.

## Supply chain

Dependencies are pinned by `go.mod`, `go.sum` and `package-lock.json`; Renovate
opens grouped updates weekly and security updates immediately. Every GitHub
Action is pinned by commit SHA. The image is built with signed provenance —
attested to this repository, workflow and commit, and verified in the same run —
carries an SBOM, and every published digest is scanned with Trivy for fixable
critical and high CVEs. A red run is not deployed.
