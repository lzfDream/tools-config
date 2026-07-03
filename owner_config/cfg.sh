#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHONPATH="$ROOT_DIR" python3 -m owner_config.cli "$@"
