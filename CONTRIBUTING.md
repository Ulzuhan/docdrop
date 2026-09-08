# Contributing

DocDrop has one Go backend and one React/Vite frontend. Node is build/test
infrastructure, not an application server. Start with the [architecture](README.md#architecture)
and [HTTP/data contracts](CONTRATOS.md).

## Working locally

Use the Go version in go.mod and Node 22+. Run npm ci, then npm run dev.
The development launcher binds to loopback:13010 and defaults to .local/data.
Configure a dedicated OIDC test client if you need authenticated access; do not
reuse production stores, credentials, guest links or browser sessions.

Before submitting:

```bash
npm run lint && npm run typecheck
npm test
go vet ./cmd/... ./internal/...
npx playwright install chromium
npm run test:navegador
npm run test:compatibilidad
```

Docker is required for the pinned compatibility test. Frontend or Dockerfile
changes also need the [final-image browser check](README.md#validation).
Use gofmt for Go. Keep changes focused; do not commit compiled assets, binaries,
node_modules, environment files, certificates or real uploaded content.

## Invariants worth reviewing

- Browser encryption must never send fragment keys or decrypted metadata to Go.
- Preserve the JSON/blob format, millisecond timestamps and explicit zero counters.
- A cut transfer must release reservations without spending its download slot.
- Keep ownership isolation, expiry, tombstones and revocations across restarts.
- Each functional suite owns an isolated store; never share production data.
- Avoid timing-based race tests; control ordering explicitly.

Add a regression for behavior changes and update contracts and the Unreleased
changelog when necessary. A new framework, analytics SDK or external runtime
service is an architectural decision, not an incidental dependency update.

## Publication is separate from deployment

A push to main publishes a development image automatically. Version tags publish
releases. Neither updates production, which must pin a verified digest. Review
[DEPLOYMENT.md](DEPLOYMENT.md) before changing runtime commands or data handling.
Never restore spent download counters as part of a rollback.
