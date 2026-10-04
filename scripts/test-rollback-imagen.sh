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

docker pull "$BASELINE"
export DOCDROP_IMAGEN_NODE="$BASELINE"
export DOCDROP_TEST_LAUNCH=scripts/lanzar-imagen.sh
export DOCDROP_RED_HOST=1
bash scripts/test-compatibilidad.sh
