#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
gradle --no-daemon :app:assembleDebug
mkdir -p salida
cp app/build/outputs/apk/debug/app-debug.apk salida/firmas-almacen-debug.apk
