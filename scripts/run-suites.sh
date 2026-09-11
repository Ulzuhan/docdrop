#!/usr/bin/env bash
#
# Las suites, cada una contra un servidor levantado aquí mismo.
#
# El servidor se arranca con un secreto de sesión propio, y no con el de
# producción: las suites acuñan sus cookies con ese mismo secreto porque esta
# aplicación no tiene login local —la identidad la lleva entera el proveedor OIDC—, y sin
# eso no habría forma de ejercitar una sola ruta.
#
#   ./scripts/run-suites.sh          # todas
#   ./scripts/run-suites.sh acceso     # una
#
# Necesita un build antes (`npm run build`). Sale con código distinto de cero si
# algo falla, que es lo que lee CI.
#
# DOCDROP_TEST_LAUNCH permite probar la imagen o un binario alternativo.
# DOCDROP_TEST_BUILD_STAMP identifica el artefacto construido.
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
export DOCDROP_TEST_RUN_ID="${RAIZ_PRUEBAS##*/}"

# Qué se arranca, y contra qué se compara su frescura.
LANZADOR="${DOCDROP_TEST_LAUNCH:-./docdrop}"
SELLO="${DOCDROP_TEST_BUILD_STAMP:-./docdrop}"
if [ ! -e "$SELLO" ]; then
  echo "no existe $SELLO: falta construir antes de probar"
  rm -f "$LOG"; rmdir "$RAIZ_PRUEBAS"
  exit 1
fi

TODAS=(acceso ficheros upload e2ee)
SUITES=("${@:-${TODAS[@]}}")
[ $# -gt 0 ] && SUITES=("$@")

servidor=""

parar() {
  # Si la tirada va contra la imagen, el proceso que se mata es el cliente de
  # docker y el contenedor puede sobrevivirle: entonces el puerto sigue ocupado
  # y la suite siguiente ni arranca. Se retira por etiqueta, que es lo que los
  # distingue de un contenedor de verdad.
  if command -v docker >/dev/null 2>&1; then
    docker ps -aq --filter "label=io.kaicorp.docdrop.prueba=1" --filter "label=io.kaicorp.docdrop.run=$DOCDROP_TEST_RUN_ID" 2>/dev/null \
      | xargs -r docker rm -f >/dev/null 2>&1
  fi
  [ -n "$servidor" ] || return 0
  # Detiene también el lanzador de imagen, si lo hay.
  kill -- -"$servidor" 2>/dev/null || kill "$servidor" 2>/dev/null
  wait "$servidor" 2>/dev/null
  servidor=""
  for _ in $(seq 1 40); do
    ss -tln 2>/dev/null | grep -qE ":$PUERTO " || return 0
    sleep 0.25
  done
  echo "aviso: el puerto $PUERTO sigue ocupado"
}
limpiar() { parar; rm -f "$LOG"; rm -rf "$RAIZ_PRUEBAS"; }
trap limpiar EXIT
trap 'exit 130' INT TERM

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
  # Se prueba el binario o la imagen final, con un almacén por suite.
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
    DOCDROP_OIDC_ISSUER="http://127.0.0.1:9999/application/o/docdrop/" \
    DOCDROP_OIDC_INTERNAL_BASE="http://127.0.0.1:9999" \
    DOCDROP_INSECURE_COOKIES=1 \
    HOSTNAME=127.0.0.1 PORT="$PUERTO" $LANZADOR >"$LOG" 2>&1 &
  servidor=$!

  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$BASE/" && break
    sleep 0.5
  done
  if ! curl -sf -o /dev/null "$BASE/"; then
    echo "el servidor no arrancó:"
    tail -20 "$LOG"
    return 1
  fi

  # La precondición, afirmada: quien escucha tiene que ser esta tirada y no un
  # servidor anterior que se quedó vivo. Sin esto se mide un build viejo y nada
  # lo dice.
  #
  # Contra la imagen no se puede llegar tan lejos: quien escucha es el proxy de
  # Docker, que es de root, así que ni `ss` enseña su pid ni se puede leer su
  # entorno. Ahí la precondición se sostiene por el otro lado —el puerto se
  # comprobó libre justo antes de arrancar— y se dice en voz alta, para que no
  # parezca que se comprobó algo que no se comprobó.
  local escucha
  escucha=$(ss -tlnp 2>/dev/null | grep ":$PUERTO " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  if [ -z "$escucha" ]; then
    echo -n "(quien escucha no es de este usuario; puerto verificado libre antes) "
    return 0
  fi
  local suyo
  suyo=$(tr '\0' '\n' < "/proc/$escucha/environ" 2>/dev/null | grep '^DOCDROP_DATA_DIR=' | cut -d= -f2-)
  if [ -n "$suyo" ] && [ "$suyo" != "$ALMACEN" ]; then
    echo "en $PUERTO escucha otro servidor, no el de esta tirada"
    return 1
  fi
  if [ "$(stat -c %Y "/proc/$escucha")" -lt "$(stat -c %Y "$SELLO")" ]; then
    echo "el build es más nuevo que el servidor: falta un 'npm run build'"
    return 1
  fi
  return 0
}

fallo=0
for suite in "${SUITES[@]}"; do
  rm -rf "$ALMACEN"
  mkdir -p "$ALMACEN"
  arrancar || { fallo=1; parar; continue; }
  printf "%-10s " "$suite"
  guion="scripts/test-$suite.mjs"
  # La suite de cifrado importa el módulo TypeScript de verdad (src/lib/e2ee.ts),
  # no un doble: --experimental-strip-types lo carga en Node ≥22 pelando los
  # tipos. El resto de suites no lo necesitan y corren igual que siempre.
  flags=""
  [ "$suite" = e2ee ] && flags="--experimental-strip-types"
  salida=$(node $flags "$guion" 2>&1)
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
