# Isolated deployment (optional)

Everything needed to run DocDrop as a system service with its own user and a strict
sandbox. **Not required to use it**: `npm run start` (or a user service, see the main
README) is enough. Worth it if the service will be exposed often or left unattended.

## Install

```bash
npm run build
sudo ./deploy/install.sh     # creates the user, deploys and starts it
```

`install.sh` is idempotent: re-running it deploys a new version while keeping
whatever is in `/etc/docdrop.env`.

## What the sandbox contains

If someone found a remote code execution hole in the application, they would run into:

- **A dedicated `docdrop` user that is NOT in the `docker` group.** This is the key
  containment: on a typical single-user machine the login account often is, and from
  there `docker run -v /:/host` hands over the whole box.
- **`ProtectHome=yes`** — no access to `/home`: no SSH keys, no tokens, no other
  projects.
- **`ProtectSystem=strict`** — the whole disk read-only except `/var/lib/docdrop`.
  It cannot even rewrite its own code, which is owned by root.
- **Empty `CapabilityBoundingSet`** and `NoNewPrivileges` — no capabilities and no
  escalation through setuid binaries.
- **`SystemCallFilter`** — no `@privileged`, `@mount`, `@swap` or `@reboot`.
- **`MemoryMax=1G` and `TasksMax=256`** — abuse cannot exhaust the machine's RAM.
- **Listens on `127.0.0.1` only** — the sole way in is a proxy or a tunnel.

Check the resulting exposure score with:

```bash
systemd-analyze security docdrop.service
```

## Configuration

Environment variables live in `/etc/docdrop.env` (mode 640, readable by the service
only). See the main README for the full list.

The service does **not** start open: without a signing secret and an OIDC client
it lets nobody in, and there is no password mode to fall back to — that one was
removed, along with the `set-password` script this section used to point at.

```bash
openssl rand -hex 32          # DOCDROP_SESSION_SECRET
sudo nano /etc/docdrop.env    # that, plus the DOCDROP_OIDC_* values
sudo systemctl restart docdrop
```

Changing `DOCDROP_SESSION_SECRET` invalidates every open session.

## Operations

```bash
systemctl status docdrop
journalctl -u docdrop -f
journalctl -u docdrop | grep mode      # which mode it started in
ss -tlnp | grep 3010                   # confirm it only listens on loopback
```

## Note on `next start`

The unit starts the service with `node start.js`, not `node server.js`. `start.js`
raises the HTTP server's `requestTimeout` before handing over to Next; Node's default
(5 minutes) cuts large uploads off mid-transfer. See the main README for the details.
