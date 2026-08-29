#!/usr/bin/env bash
#
# Levanta DocDrop apuntando a un proveedor de mentira y corre
# `test-backchannel.mjs` contra él.
#
# Necesita su propio arrancador por lo mismo que `test-identity.sh`: las demás
# suites corren con el proveedor APAGADO —run-suites.sh vacía esas variables a
# propósito, para que las cuentas locales que crean puedan existir—, y aquí el
# proveedor es justamente lo que se prueba.
#
# A diferencia de test-identity.sh, este proveedor sí existe: lo levanta el
# propio `.mjs` en el puerto 9998, con su JWKS, y firma de verdad. Por eso el
# emisor apunta ahí y no a un dominio inventado.
#
#   npm run test:backchannel     # hace falta un build antes (npm run build)
set -uo pipefail
set -m

cd "$(dirname "$0")/.."

PORT="${PORT:-3996}"
export BASE="http://127.0.0.1:$PORT"
export PUERTO_IDP="${PUERTO_IDP:-9996}"
export CLIENT_ID="docdrop-pruebas"
WORK="$(mktemp -d)"
LOG="$WORK/server.log"

EMISOR="http://127.0.0.1:$PUERTO_IDP/application/o/docdrop"

server_pid=""

stop() {
  [ -n "$server_pid" ] || return 0
  # El grupo entero: el standalone deja un trabajador que se queda el puerto.
  kill -- -"$server_pid" 2>/dev/null || kill "$server_pid" 2>/dev/null
  wait "$server_pid" 2>/dev/null
  server_pid=""
}

cleanup() {
  stop
  rm -rf "$WORK"
}
trap 'cleanup; exit 130' INT TERM

DOCDROP_DATA_DIR="$WORK/datos" \
  DOCDROP_SESSION_SECRET="secreto-de-pruebas-con-treinta-y-dos-bytes" \
  DOCDROP_OIDC_CLIENT_ID="$CLIENT_ID" \
  DOCDROP_OIDC_CLIENT_SECRET=secreto-de-pruebas \
  DOCDROP_OIDC_ISSUER="$EMISOR/" \
  DOCDROP_OIDC_REDIRECT_URI="$BASE/api/auth/callback" \
  HOSTNAME=127.0.0.1 PORT="$PORT" \
  node scripts/start.js >"$LOG" 2>&1 &
server_pid=$!

for _ in $(seq 1 90); do
  curl -sf -o /dev/null "$BASE/" && break
  sleep 0.5
done

if ! curl -sf -o /dev/null "$BASE/"; then
  echo "el servidor no arrancó:"
  tail -20 "$LOG"
  cleanup
  exit 1
fi

node scripts/test-backchannel.mjs
estado=$?

# El log solo si algo falló: en verde no aporta nada y esconde el resultado.
[ "$estado" -eq 0 ] || tail -30 "$LOG"

cleanup
exit "$estado"
