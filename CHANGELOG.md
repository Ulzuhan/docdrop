# Changelog

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
