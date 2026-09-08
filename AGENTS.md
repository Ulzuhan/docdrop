# DocDrop: React + Go

Go owns HTTP, OIDC, storage and lifecycle. React in src/ is built by Vite and
embedded in internal/web/dist. Node is a build/test dependency, never a server.

- Keep src/lib/e2ee.ts, e2ee-client.ts and chunked-upload.ts shared by UI and tests.
  Never send fragment keys or decrypted filenames to the server.
- Preserve the JSON/blob format, millisecond timestamps, explicit zero counters,
  tombstones and revocations. No concurrent writers across processes.
- Server regressions belong in Go; HTTP/browser suites exercise the final binary
  and image. Preserve the pinned Node 2.3.1 image compatibility test, not its source.
- Run npm run lint, npm run typecheck, npm test, browser and compatibility suites
  for relevant changes. Build assets before building a distributable binary.
- Never use production stores or sessions for tests. Preserve unrelated changes.
- Publishing, deploying and git push require authorization: push to main publishes.
- Roll back using the current store, never by restoring spent download counters.
