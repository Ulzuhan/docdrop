# Reviewed rollback release

`rollback.json` is the exact published Go release to return to after the next
candidate. Its version, digest, source, publication run and attempt are reviewed
in Git. The initial value is the published 3.1.1; changing this file does not
publish an image or deploy anything.

Before building the OCI, CI verifies the baseline signature from this repository's
`docker.yml` on a GitHub-hosted runner, source/tag, exact signed digest and the
certificate's run/attempt against the successful GitHub API record. A missing,
ambiguous, red or mismatched release stops CI. No new credentials or permissions.

The same baseline digest is the OCI `rollback-image` label, the OCI verifier's
expected value and the image compatibility test's previous/current/previous
pair. Node 2.3.1 remains a separate exact-digest regression test. The Go test uses
one synthetic store, one writer at a time, and never restores spent counters,
tombstones, revocations or blobs. No store/config migration is authorized by a
same-contract label.

For successive updates, review an advance of this file to the last release
accepted by the target host **before** publishing the next version. An image
tested against another baseline is valid as an artifact but is ineligible for
that host's automatic deployment. Do not automatically select `latest`, a tag,
an arbitrary 3.x release or an unverified API run. Publication still tests/scans
one OCI artifact, signs and promotes the identical index after all gates; only
tag pushes can publish. Review the exact candidate version/digest in infrastructure
separately. This draft enables CI preparation; it does not activate host CD.
