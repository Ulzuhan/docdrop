#!/usr/bin/env bash
#
# Instala DocDrop como servicio de sistema aislado.
#
#   sudo ./deploy/install.sh
#
# Idempotente: se puede volver a ejecutar para desplegar una versión nueva. Si ya
# existe /etc/docdrop.env, respeta las credenciales que haya.
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/docdrop
DATA_DIR=/var/lib/docdrop
ENV_FILE=/etc/docdrop.env
SERVICE_USER=docdrop
NODE_BIN=/usr/local/bin/node

if [[ $EUID -ne 0 ]]; then
  echo "Ejecuta con sudo: sudo $0" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "No existe $NODE_BIN. Instala Node en el sistema (el de nvm no sirve: vive en /home, que el servicio no puede leer)." >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR/.next/standalone" ]]; then
  echo "Falta .next/standalone. Ejecuta 'npm run build' antes." >&2
  exit 1
fi

echo "==> Usuario del sistema '$SERVICE_USER'"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # Sin shell, sin home y sin grupos extra. En particular, NUNCA en el grupo docker.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "    creado"
else
  echo "    ya existía"
fi

# Comprobación de seguridad: si alguien añadiera este usuario al grupo docker, el
# aislamiento no serviría de nada.
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "ABORTADO: el usuario $SERVICE_USER pertenece al grupo docker, lo que permite escalar a root." >&2
  exit 1
fi

echo "==> Credenciales ($ENV_FILE)"
if [[ -f "$ENV_FILE" ]]; then
  echo "    ya existe, se conserva"
else
  CREDS="$("$NODE_BIN" "$SRC_DIR/scripts/set-password.mjs")"
  printf '%s\n' "$CREDS" | grep '^DOCDROP_' > "$ENV_FILE"
  echo ""
  printf '%s\n' "$CREDS" | grep -A1 'Contraseña'
  echo ""
  echo "    ^^^ GUARDA ESA CONTRASEÑA AHORA: no se vuelve a mostrar."
  echo ""
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"   # el servicio la lee; el resto de usuarios no

echo "==> Código en $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/.next/standalone/." "$APP_DIR/"
mkdir -p "$APP_DIR/.next"
cp -r "$SRC_DIR/.next/static" "$APP_DIR/.next/static"
[[ -d "$SRC_DIR/public" ]] && cp -r "$SRC_DIR/public" "$APP_DIR/public"
mkdir -p "$APP_DIR/deploy"
cp "$SRC_DIR/deploy/README.md" "$APP_DIR/deploy/" 2>/dev/null || true
# Propiedad de root y solo lectura para el servicio: si comprometen la aplicación,
# no puede reescribir su propio código para persistir.
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

echo "==> Datos en $DATA_DIR"
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo "==> Servicio systemd"
cp "$SRC_DIR/deploy/docdrop.service" /etc/systemd/system/docdrop.service
chmod 644 /etc/systemd/system/docdrop.service
systemctl daemon-reload
systemctl enable docdrop.service >/dev/null
systemctl restart docdrop.service

sleep 3
if systemctl is-active --quiet docdrop.service; then
  echo ""
  echo "OK: docdrop activo en 127.0.0.1:3010"
  echo ""
  systemd-analyze security docdrop.service 2>/dev/null | tail -3 || true
  echo ""
  echo "Siguiente paso — publicarlo en internet:"
  echo "  tailscale funnel --bg --https=8443 http://127.0.0.1:3010"
else
  echo "FALLÓ el arranque. Revisa:  journalctl -u docdrop -n 40 --no-pager" >&2
  exit 1
fi
