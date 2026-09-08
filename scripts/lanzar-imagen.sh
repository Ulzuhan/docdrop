#!/usr/bin/env bash
#
# Arranca la imagen final con las restricciones de producción, y se comporta
# como el binario: escucha en $PORT del host y muere con la señal que reciba.
#
# Sirve para pasarle a la imagen las MISMAS suites que al binario:
#
#   DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh ./scripts/run-suites.sh
#   DOCDROP_RED_HOST=1 DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh npm run test:navegador
#
# Las restricciones son las del compose de producción, no unas cómodas: raíz de
# sólo lectura, /tmp en tmpfs con el uid del servicio, sin capacidades, sin
# elevación, 256 procesos, 1 GiB y 1,5 CPU. Una imagen que sólo arranca sin
# ellas no está probada.
#
# DOCDROP_RED_HOST=1 la pone en la red del host: hace falta cuando la prueba
# levanta un proveedor de identidad en el loopback del host, porque desde una
# red de contenedores eso no se alcanza.
set -uo pipefail

IMAGEN="${DOCDROP_IMAGEN:-docdrop-go:ci}"
PUERTO="${PORT:-3010}"
DATOS="${DOCDROP_DATA_DIR:-}"
NOMBRE="${DOCDROP_CONTENEDOR:-docdrop-prueba-$$}"

if [ -z "$DATOS" ]; then
  echo "hace falta DOCDROP_DATA_DIR con el directorio del almacén" >&2
  exit 2
fi
mkdir -p "$DATOS"

# El uid de la imagen es 1001 y quien lanza esto normalmente no lo es, así que
# el almacén se monta con el uid de quien llama. Lo que se prueba aquí es el
# comportamiento bajo las restricciones; que el uid de la imagen sea el 1001 se
# comprueba aparte, sin `--user`.
USUARIO="${DOCDROP_UID:-$(id -u):$(id -g)}"
UID_SOLO="${USUARIO%%:*}"
GID_SOLO="${USUARIO##*:}"

# No se retiran contenedores de otras tiradas: la limpieza tiene dueño.
argumentos=(
  run --rm --name "$NOMBRE"
  --label io.kaicorp.docdrop.prueba=1
  --label "io.kaicorp.docdrop.run=${DOCDROP_TEST_RUN_ID:-$NOMBRE}"
  --user "$USUARIO"
  -v "$DATOS:/data"
  --read-only
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=$UID_SOLO,gid=$GID_SOLO"
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --pids-limit 256
  --memory 1g
  --cpus 1.5
  -e DOCDROP_DATA_DIR=/data
)

if [ "${DOCDROP_RED_HOST:-}" = "1" ]; then
  # En la red del host el servicio escucha directamente en el puerto pedido.
  argumentos+=(--network host -e "PORT=$PUERTO" -e HOSTNAME=127.0.0.1)
else
  argumentos+=(-p "127.0.0.1:$PUERTO:3010" -e PORT=3010 -e HOSTNAME=0.0.0.0)
fi

# Todo lo demás se pasa tal cual: las suites y el recorrido eligen secreto,
# proveedor, cuotas y origen público.
for variable in DOCDROP_SESSION_SECRET DOCDROP_SESSION_TTL_HOURS \
  DOCDROP_MAX_FILE_BYTES DOCDROP_MAX_TOTAL_BYTES DOCDROP_CHUNK_BYTES \
  DOCDROP_OIDC_CLIENT_ID DOCDROP_OIDC_CLIENT_SECRET DOCDROP_OIDC_REDIRECT_URI \
  DOCDROP_OIDC_ISSUER DOCDROP_OIDC_INTERNAL_BASE DOCDROP_OIDC_TIMEOUT_MS \
  DOCDROP_PUBLIC_HOST DOCDROP_ENROLL_URL DOCDROP_ACCOUNT_URL \
  DOCDROP_REQUEST_TIMEOUT_MS DOCDROP_HEADERS_TIMEOUT_MS DOCDROP_SHUTDOWN_MS \
  DOCDROP_INSECURE_COOKIES KAICORP_FOOTER_LINKS; do
  if [ -n "${!variable:-}" ]; then
    argumentos+=(-e "$variable=${!variable}")
  fi
done

# Sin `exec`: hace falta que la trampa siga viva para retirar el contenedor. Un
# `--rm` con nombre fijo que quede colgado bloquea la siguiente tirada, y eso ya
# pasó una vez en SecretDrop.
parar() { docker rm -f "$NOMBRE" >/dev/null 2>&1 || true; }
trap 'parar; exit 130' INT TERM
trap parar EXIT

docker "${argumentos[@]}" "$IMAGEN"
