#!/usr/bin/env bash
#
# El recorrido completo en un navegador de verdad, sobre HTTPS.
#
# Necesita su propio montaje: un proveedor de mentira que COMPLETA el login y un
# proxy TLS por delante, porque las cookies `Secure` no viajan por http y una
# prueba que las desactivara no probaría lo que se despliega.
#
#   npm run build:web && go build -o /tmp/docdrop ./cmd/docdrop
#   DOCDROP_TEST_LAUNCH=/tmp/docdrop npm run test:navegador
#
# Sin `DOCDROP_TEST_LAUNCH` corre contra el artefacto de Node, que es lo que
# permite comprobar que el recorrido no distingue implementación.
set -uo pipefail
set -m

cd "$(dirname "$0")/.."

PUERTO_APP="${PUERTO_APP:-3971}"
PUERTO_TLS="${PUERTO_TLS:-3972}"
export PUERTO_IDP="${PUERTO_IDP:-9971}"
export BASE="https://127.0.0.1:$PUERTO_TLS"
WORK="$(mktemp -d)"
export LLAVE="$WORK/llave.pem" CERT="$WORK/cert.pem"
export PUERTO_APP PUERTO_TLS
LOG="$WORK/servidor.log"

LANZAR="${DOCDROP_TEST_LAUNCH:-node scripts/start.js}"

servidor=""
parar() {
  [ -n "$servidor" ] || return 0
  kill -- -"$servidor" 2>/dev/null || kill "$servidor" 2>/dev/null
  wait "$servidor" 2>/dev/null
  servidor=""
}
limpiar() { parar; rm -rf "$WORK"; }
trap 'limpiar; exit 130' INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$LLAVE" -out "$CERT" \
  -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null || {
  echo "no se pudo generar el certificado"; limpiar; exit 1; }

# El origen público es el del proxy TLS: es lo que compara el guardián de origen
# y lo que sale en canonical y OpenGraph.
NODE_ENV=production PORT="$PUERTO_APP" HOSTNAME=127.0.0.1 \
  DOCDROP_DATA_DIR="$WORK/datos" \
  DOCDROP_MAX_TOTAL_BYTES=104857600 \
  DOCDROP_SESSION_SECRET="secreto-de-navegador-con-treinta-y-dos" \
  DOCDROP_PUBLIC_HOST="127.0.0.1:$PUERTO_TLS" \
  DOCDROP_OIDC_CLIENT_ID=pruebas \
  DOCDROP_OIDC_CLIENT_SECRET=pruebas \
  DOCDROP_OIDC_REDIRECT_URI="$BASE/api/auth/callback" \
  DOCDROP_OIDC_ISSUER="http://127.0.0.1:$PUERTO_IDP/application/o/docdrop" \
  DOCDROP_OIDC_INTERNAL_BASE="http://127.0.0.1:$PUERTO_IDP" \
  DOCDROP_ACCOUNT_URL="https://idp.example.invalid/if/user/" \
  DOCDROP_ENROLL_URL="https://idp.example.invalid/if/flow/alta/" \
  KAICORP_FOOTER_LINKS=on \
  $LANZAR >"$LOG" 2>&1 &
servidor=$!

for _ in $(seq 1 90); do
  curl -sf -o /dev/null "http://127.0.0.1:$PUERTO_APP/" && break
  sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$PUERTO_APP/"; then
  echo "la aplicación no arrancó:"; tail -20 "$LOG"; limpiar; exit 1
fi

node "${DOCDROP_NAV_SCRIPT:-scripts/test-navegador.mjs}"
estado=$?
[ "$estado" -eq 0 ] || { echo "--- registro de la aplicación ---"; tail -30 "$LOG"; }
limpiar
exit "$estado"
