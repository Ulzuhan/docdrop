#!/usr/bin/env bash
#
# Las suites, cada una contra un servidor levantado aquí mismo.
#
# El servidor se arranca con un secreto de sesión propio, y no con el de
# producción: las suites acuñan sus cookies con ese mismo secreto porque esta
# aplicación no tiene login local —la identidad la lleva Authentik entera—, y sin
# eso no habría forma de ejercitar una sola ruta.
#
#   ./scripts/run-suites.sh          # todas
#   ./scripts/run-suites.sh auth     # una
#
# Necesita un build antes (`npm run build`). Sale con código distinto de cero si
# algo falla, que es lo que lee CI.
set -uo pipefail
set -m

cd "$(dirname "$0")/.."

PUERTO="${PORT:-3995}"
export BASE="http://127.0.0.1:$PUERTO"
export DOCDROP_SESSION_SECRET="${DOCDROP_SESSION_SECRET:-secreto-de-pruebas-docdrop-32-bytes-minimo}"
LOG="$(mktemp)"
RAIZ_PRUEBAS="$(mktemp -d)"
# Se EXPORTA, no sólo se le pasa al servidor.
#
# Las suites escriben la ficha del usuario en disco antes de firmar su cookie
# —`requireSession` la busca, no se cree la cookie—, así que necesitan saber dónde
# está el almacén. Sin exportarla, el servidor miraba en el temporal y las suites
# sembraban en `.docdrop-uploads`, o sea en el almacén DE VERDAD: dos fichas de
# prueba acabaron mezcladas con las de la gente, y encima las suites fallaban
# porque cada lado miraba en un sitio distinto.
export ALMACEN="$RAIZ_PRUEBAS/almacen"
export DOCDROP_DATA_DIR="$ALMACEN"

TODAS=(acceso ficheros upload)
SUITES=("${@:-${TODAS[@]}}")
[ $# -gt 0 ] && SUITES=("$@")

servidor=""

parar() {
  [ -n "$servidor" ] || return 0
  # El grupo entero, no el proceso: `next start` levanta un trabajador aparte, y
  # matar sólo al padre deja el puerto ocupado. La siguiente suite encontraría un
  # servidor en pie, decidiría que ya ha arrancado, y mediría el de antes.
  kill -- -"$servidor" 2>/dev/null || kill "$servidor" 2>/dev/null
  wait "$servidor" 2>/dev/null
  servidor=""
  for _ in $(seq 1 40); do
    ss -tln 2>/dev/null | grep -qE ":$PUERTO " || return 0
    sleep 0.25
  done
  echo "aviso: el puerto $PUERTO sigue ocupado"
}
trap 'parar; exit 130' INT TERM

arrancar() {
  local max_total=21474836480
  [ "$suite" = "ficheros" ] && max_total=1048576
  ss -tln 2>/dev/null | grep -qE ":$PUERTO " && { echo "el puerto $PUERTO ya está ocupado"; return 1; }

  # Los valores de OIDC son de mentira a propósito: ninguna suite completa un
  # inicio de sesión contra el proveedor, sólo comprueban que el desvío se
  # construye y que no saca de casa.
  # Almacén aparte, y no el de verdad. Sin esto cada tirada de pruebas dejaba sus
  # secretos mezclados con los de la gente, en el mismo directorio y con la misma
  # limpieza automática pasándoles por encima.
  # Se arranca con el MISMO lanzador que usa producción, no con `next start`.
  #
  # Con `output: "standalone"` se construyen dos artefactos: `.next`, que es lo que
  # serviría `next start`, y `.next/standalone`, que es lo que arranca el servicio
  # de verdad a través de `scripts/start.js`. Probar el primero es probar algo que
  # nadie ejecuta, y el paso de preparación poda ficheros del segundo.
  #
  # OJO con este bloque: las asignaciones van encadenadas con `\`, y meter un
  # comentario entre medias rompe la continuación **en silencio** — el proceso
  # arranca igual, pero sin ninguna de las variables. Pasó: la cuota de pruebas no
  # llegaba, la suite fallaba, y parecía un fallo del producto.
  DOCDROP_DATA_DIR="$ALMACEN" \
    DOCDROP_MAX_TOTAL_BYTES="$max_total" \
    DOCDROP_SESSION_SECRET="$DOCDROP_SESSION_SECRET" \
    DOCDROP_OIDC_CLIENT_ID=pruebas \
    DOCDROP_OIDC_CLIENT_SECRET=pruebas \
    DOCDROP_OIDC_REDIRECT_URI="$BASE/api/auth/callback" \
    DOCDROP_OIDC_PUBLIC_BASE="http://127.0.0.1:9999" \
    DOCDROP_OIDC_INTERNAL_BASE="http://127.0.0.1:9999" \
    DOCDROP_OIDC_APP_SLUG=docdrop \
    PORT="$PUERTO" node scripts/start.js >"$LOG" 2>&1 &
  servidor=$!

  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$BASE/" && break
    sleep 0.5
  done

  # La precondición, afirmada: quien escucha tiene que ser este proceso y no un
  # servidor de una tirada anterior que se quedó vivo. Sin esto se mide un build
  # viejo y nada lo dice.
  local escucha
  escucha=$(ss -tlnp 2>/dev/null | grep ":$PUERTO " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  if [ -z "$escucha" ]; then
    echo "el servidor no arrancó:"
    tail -20 "$LOG"
    return 1
  fi
  local suyo
  suyo=$(tr '\0' '\n' < "/proc/$escucha/environ" 2>/dev/null | grep '^DOCDROP_DATA_DIR=' | cut -d= -f2-)
  if [ "$suyo" != "$ALMACEN" ]; then
    echo "en $PUERTO escucha otro servidor, no el de esta tirada"
    return 1
  fi
  if [ "$(stat -c %Y "/proc/$escucha")" -lt "$(stat -c %Y .next/BUILD_ID)" ]; then
    echo "el build es más nuevo que el servidor: falta un 'npm run build'"
    return 1
  fi
  return 0
}

fallo=0
for suite in "${SUITES[@]}"; do
  rm -rf "$ALMACEN"
  mkdir -p "$ALMACEN"
  arrancar || { fallo=1; continue; }
  printf "%-10s " "$suite"
  guion="scripts/test-$suite.mjs"
  salida=$(node "$guion" 2>&1)
  estado=$?
  echo "$salida" | tail -1
  if [ $estado -ne 0 ]; then
    echo "$salida" | grep -E "✗" | head -10
    # Y si la suite se cayó en vez de terminar contando, decirlo: un script que
    # muere a mitad deja comprobaciones sin ejecutar, y en el resumen eso se
    # parece demasiado a un fallo pequeño. Pasó.
    if ! echo "$salida" | grep -qE "^[0-9]+ pasan, [0-9]+ fallan$"; then
      echo "  ⚠ la suite '$suite' se cayó antes de terminar; lo que sigue no llegó a ejecutarse:"
      echo "$salida" | tail -6 | sed 's/^/     /'
    fi
    fallo=1
  fi
  parar
done

rm -f "$LOG"
rm -rf "$RAIZ_PRUEBAS"
if [ $fallo -ne 0 ]; then
  echo
  echo "HAY FALLOS"
  exit 1
fi
echo
echo "todo verde"
