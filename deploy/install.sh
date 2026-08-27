#!/usr/bin/env bash
#
# Installs DocDrop as an isolated system service.
#
#   sudo ./deploy/install.sh
#
# Idempotent: re-run it to deploy a new version. If /etc/docdrop.env already exists,
# whatever configuration is in it is left alone.
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/docdrop
DATA_DIR=/var/lib/docdrop
ENV_FILE=/etc/docdrop.env
SERVICE_USER=docdrop
NODE_BIN=/usr/local/bin/node

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "$NODE_BIN not found. Install Node system-wide (a version manager under /home will not do: the sandbox blocks /home)." >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR/.next/standalone" ]]; then
  echo "Missing .next/standalone. Run 'npm run build' first." >&2
  exit 1
fi

if [[ ! -f "$SRC_DIR/.next/standalone/start.js" ]]; then
  echo "Missing start.js in the standalone output. Run 'npm run build' again." >&2
  exit 1
fi

echo "==> System user '$SERVICE_USER'"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # No shell, no home and no extra groups. In particular, NEVER in the docker group.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "    created"
else
  echo "    already existed"
fi

# Safety check: if this user were added to the docker group, the isolation would be
# worthless — docker group membership is equivalent to root.
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "ABORTED: user $SERVICE_USER belongs to the docker group, which allows escalating to root." >&2
  exit 1
fi

echo "==> Configuration ($ENV_FILE)"
if [[ -f "$ENV_FILE" ]]; then
  echo "    already exists, left untouched"
else
  # La plantilla se crea SIN credenciales, y con ellas vacías la aplicación no
  # deja entrar a nadie. No existe un modo abierto al que caer: el de contraseña
  # local se retiró junto con `set-password`.
  cat > "$ENV_FILE" <<'ENVEOF'
# Storage limits (bytes)
DOCDROP_MAX_FILE_BYTES=10737418240
DOCDROP_MAX_TOTAL_BYTES=21474836480

# Identidad — OBLIGATORIA. Sin esto la aplicación no deja entrar a nadie.
# DOCDROP_SESSION_SECRET=      # openssl rand -hex 32
# DOCDROP_OIDC_CLIENT_ID=
# DOCDROP_OIDC_CLIENT_SECRET=
# DOCDROP_OIDC_REDIRECT_URI=
# DOCDROP_OIDC_PUBLIC_BASE=
# DOCDROP_OIDC_INTERNAL_BASE=http://127.0.0.1:9100
ENVEOF
  echo "    creado sin credenciales: hay que rellenarlas antes de que entre nadie"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"   # readable by the service, not by other users

echo "==> Code in $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
# The standalone output already contains the static assets and the launcher (postbuild).
cp -r "$SRC_DIR/.next/standalone/." "$APP_DIR/"
mkdir -p "$APP_DIR/deploy"
cp "$SRC_DIR/deploy/README.md" "$APP_DIR/deploy/" 2>/dev/null || true
# Owned by root and read-only for the service: if the app is compromised, it cannot
# rewrite its own code to persist.
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

echo "==> Data in $DATA_DIR"
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo "==> systemd service"
cp "$SRC_DIR/deploy/docdrop.service" /etc/systemd/system/docdrop.service
chmod 644 /etc/systemd/system/docdrop.service
systemctl daemon-reload
systemctl enable docdrop.service >/dev/null
systemctl restart docdrop.service

sleep 3
if systemctl is-active --quiet docdrop.service; then
  echo ""
  echo "OK: docdrop is running on 127.0.0.1:3010"
  echo ""
  systemd-analyze security docdrop.service 2>/dev/null | tail -3 || true
  echo ""
  echo "Temporary public access (Ctrl-C to close):"
  echo "  cloudflared tunnel --url http://127.0.0.1:3010"
else
  echo "FAILED to start. Check:  journalctl -u docdrop -n 40 --no-pager" >&2
  exit 1
fi
