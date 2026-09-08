#!/usr/bin/env bash
# Install the already-built Go binary. Keeps configuration and current data.
# Updates stop the service: schedule them outside active transfers.
set -euo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == --help ]]; then
  echo "Build with npm ci && npm run build, then sudo bash deploy/install.sh."
  echo "Installs /opt/docdrop/docdrop, preserves /etc/docdrop.env and /var/lib/docdrop."
  exit 0
fi
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -x "$SRC_DIR/docdrop" ]] || { echo "Run npm run build first." >&2; exit 1; }
for path in /opt/docdrop /var/lib/docdrop /etc/docdrop.env; do
  [[ ! -L "$path" ]] || { echo "Refusing symlink: $path" >&2; exit 1; }
done
if ! id -u docdrop >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin docdrop
fi
if id -nG docdrop | tr ' ' '\n' | grep -qx docker; then
  echo "Refusing a service user in the docker group." >&2; exit 1
fi
install -d -o root -g root -m 0755 /opt/docdrop /opt/docdrop/deploy
install -d -o docdrop -g docdrop -m 0700 /var/lib/docdrop
if [[ ! -e /etc/docdrop.env ]]; then
  install -o root -g docdrop -m 0640 "$SRC_DIR/.env.example" /etc/docdrop.env
fi
# Copy to a private temporary file, then rename atomically. Never erase /opt/docdrop.
STAGED="$(mktemp /opt/docdrop/.docdrop.XXXXXXXX)"
trap 'rm -f "$STAGED"' EXIT
install -o root -g root -m 0755 "$SRC_DIR/docdrop" "$STAGED"
if systemctl is-active --quiet docdrop.service; then
  systemctl stop docdrop.service
fi
mv -f "$STAGED" /opt/docdrop/docdrop
install -o root -g root -m 0644 "$SRC_DIR/deploy/README.md" /opt/docdrop/deploy/README.md
install -o root -g root -m 0644 "$SRC_DIR/deploy/docdrop.service" /etc/systemd/system/docdrop.service
systemctl daemon-reload
systemctl enable --now docdrop.service
systemctl is-active --quiet docdrop.service
printf '%s\n' \
  "Installed Go backend. Configure OIDC in /etc/docdrop.env; no open-upload mode." \
  "Verify: curl --fail http://127.0.0.1:3010/healthz" \
  "Existing legacy files, if any, were not deleted automatically."
