#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export HOSTNAME=127.0.0.1 PORT="${PORT:-13010}"
export DOCDROP_DATA_DIR="${DOCDROP_DATA_DIR:-$PWD/.local/data}"
export DOCDROP_INSECURE_COOKIES=1
exec ./docdrop
