#!/usr/bin/env bash
#
# Node publicado → Go → el MISMO Node, por turnos, sobre un solo almacén.
#
# POR QUÉ ASÍ:
#
# - Por turnos y nunca a la vez: no se prueba que aguanten una carrera, sino
#   que cada uno lee y respeta lo que dejó el otro. Dos escritores sobre el
#   mismo directorio no es un escenario que vaya a ocurrir en el despliegue.
# - Con el DIGEST EXACTO de vuelta atrás, no con «una versión de Node»: si el
#   rollback no funciona contra esa imagen concreta, no funciona.
# - Sin restaurar copias: el turno de vuelta encuentra los datos tal como los
#   dejó Go, incluidos los contadores gastados y las lápidas. Una restauración
#   resucitaría ficheros retirados, que en este servicio es peor que el fallo.
#
#   scripts/test-compatibilidad.sh
#
# La imagen se ejecuta con el uid de quien lanza esto y no con el suyo (1001),
# para que el binario de Go pueda leer y escribir el mismo directorio. Lo que se
# comprueba es el formato de los datos; el uid de producción se comprueba aparte,
# al probar la imagen final.
set -uo pipefail
set -m

cd "$(dirname "$0")/.."

IMAGEN_NODE="${DOCDROP_IMAGEN_NODE:-ghcr.io/ulzuhan/docdrop@sha256:525ef454305d7455c774d4463d11feb029ba8091ef4b83508a7b4002c19f0f67}"
BINARIO_GO="${DOCDROP_TEST_LAUNCH:-./docdrop}"
PUERTO="${PUERTO:-3981}"
export BASE="http://127.0.0.1:$PUERTO"
export DOCDROP_SESSION_SECRET="secreto-de-compatibilidad-treinta-y-dos"
export DOCDROP_CHUNK_BYTES=1048576

WORK="$(mktemp -d)"
export DOCDROP_DATA_DIR="$WORK/datos"
export ESTADO="$WORK/estado.json"
mkdir -p "$DOCDROP_DATA_DIR"
LOG="$WORK/servidor.log"

contenedor=""
proceso=""

parar() {
  if [ -n "$contenedor" ]; then
    docker rm -f "$contenedor" >/dev/null 2>&1
    contenedor=""
  fi
  if [ -n "$proceso" ]; then
    kill -- -"$proceso" 2>/dev/null || kill "$proceso" 2>/dev/null
    wait "$proceso" 2>/dev/null
    proceso=""
  fi
  for _ in $(seq 1 40); do
    ss -tln 2>/dev/null | grep -qE ":$PUERTO " || return 0
    sleep 0.25
  done
  echo "aviso: el puerto $PUERTO sigue ocupado"
}
limpiar() { parar; rm -rf "$WORK"; }
trap 'limpiar; exit 130' INT TERM

esperar() {
  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$BASE/" && return 0
    sleep 0.5
  done
  echo "no arrancó:"; tail -20 "$LOG"; return 1
}

arrancar_node() {
  contenedor="docdrop-compat-$$"
  docker run -d --name "$contenedor" \
    --user "$(id -u):$(id -g)" \
    -p "127.0.0.1:$PUERTO:3010" \
    -v "$DOCDROP_DATA_DIR:/data" \
    -e DOCDROP_DATA_DIR=/data \
    -e DOCDROP_SESSION_SECRET="$DOCDROP_SESSION_SECRET" \
    -e DOCDROP_CHUNK_BYTES="$DOCDROP_CHUNK_BYTES" \
    -e DOCDROP_OIDC_CLIENT_ID=pruebas \
    -e DOCDROP_OIDC_CLIENT_SECRET=pruebas \
    -e DOCDROP_OIDC_REDIRECT_URI="$BASE/api/auth/callback" \
    -e DOCDROP_OIDC_ISSUER="http://127.0.0.1:9999/application/o/docdrop/" \
    -e DOCDROP_OIDC_INTERNAL_BASE="http://127.0.0.1:9999" \
    "$IMAGEN_NODE" >/dev/null || return 1
  esperar || { docker logs "$contenedor" 2>&1 | tail -20; return 1; }
}

arrancar_go() {
  [ -n "$BINARIO_GO" ] || { echo "falta DOCDROP_TEST_LAUNCH con el binario de Go"; return 1; }
  DOCDROP_DATA_DIR="$DOCDROP_DATA_DIR" \
    DOCDROP_SESSION_SECRET="$DOCDROP_SESSION_SECRET" \
    DOCDROP_CHUNK_BYTES="$DOCDROP_CHUNK_BYTES" \
    DOCDROP_OIDC_CLIENT_ID=pruebas \
    DOCDROP_OIDC_CLIENT_SECRET=pruebas \
    DOCDROP_OIDC_REDIRECT_URI="$BASE/api/auth/callback" \
    DOCDROP_OIDC_ISSUER="http://127.0.0.1:9999/application/o/docdrop/" \
    DOCDROP_OIDC_INTERNAL_BASE="http://127.0.0.1:9999" \
    DOCDROP_INSECURE_COOKIES=1 \
    HOSTNAME=127.0.0.1 PORT="$PUERTO" $BINARIO_GO >"$LOG" 2>&1 &
  proceso=$!
  esperar
}

echo "imagen de Node:  $IMAGEN_NODE"
echo "binario de Go:   ${BINARIO_GO:-(sin definir)}"
echo "almacén:         $DOCDROP_DATA_DIR"

fallo=0
turno() {
  local que="$1" fase="$2"
  echo
  echo "── turno: $que ($fase)"
  if [ "$que" = node ]; then arrancar_node || { fallo=1; return 1; }
  else arrancar_go || { fallo=1; return 1; }; fi
  node scripts/test-compatibilidad.mjs "$fase" || fallo=1
  parar
}

turno node sembrar-node   || { limpiar; exit 1; }
turno go   comprobar-go   || { limpiar; exit 1; }
turno node comprobar-node || { limpiar; exit 1; }

limpiar
echo
if [ $fallo -ne 0 ]; then echo "HAY FALLOS"; exit 1; fi
echo "compatibilidad verde en los dos sentidos"
