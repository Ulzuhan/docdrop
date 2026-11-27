#!/usr/bin/env bash
# Digest Go revisado → artefacto OCI candidato cargado → mismo Go revisado.
# Reutiliza TODAS las aserciones de persistencia sin sustituir el ensayo Node.
# Los nombres de fase históricos de test-compatibilidad no cambian su contrato.
# Un almacén sintético, un escritor por turno, cero restauraciones.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE=$(python3 scripts/rollback-baseline.py image)
: "${DOCDROP_IMAGEN:?falta el image ID del runtime verificado en el layout OCI}"
[[ "$DOCDROP_IMAGEN" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  echo "se exige el image ID exacto, no un tag mutable" >&2; exit 1;
}

expected_arch=${DOCDROP_EXPECTED_ARCH:?falta la arquitectura del runner nativo}
case "$(uname -m):$expected_arch" in
  aarch64:arm64|x86_64:amd64) ;;
  *) echo "el ensayo exige la arquitectura Linux nativa de la candidata" >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Linux ]] || exit 1
docker pull --platform "linux/$expected_arch" "$BASELINE"
forma='{{.Os}}/{{.Architecture}}'
for image in "$BASELINE" "$DOCDROP_IMAGEN"; do
  [[ "$(docker image inspect --format "$forma" "$image")" == "linux/$expected_arch" ]] || {
    echo "arquitectura de imagen incorrecta" >&2; exit 1;
  }
done
[[ "$(docker image inspect --format '{{.Id}}' "$DOCDROP_IMAGEN")" == "$DOCDROP_IMAGEN" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "io.kaicorp.docdrop.store-contract"}}' "$DOCDROP_IMAGEN")" == go-json-v1 ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "io.kaicorp.docdrop.rollback-image"}}' "$DOCDROP_IMAGEN")" == "$BASELINE" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "io.kaicorp.docdrop.store-contract"}}' "$BASELINE")" == go-json-v1 ]]
export DOCDROP_ROLLBACK_ESTRICTO=1
export DOCDROP_IMAGEN_NODE="$BASELINE"
export DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh
export DOCDROP_RED_HOST=1
bash scripts/test-compatibilidad.sh
