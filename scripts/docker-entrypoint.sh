#!/bin/sh
set -eu
# Native SQLite may spill temporary files; keep them on the data mount.
mkdir -p "${TMPDIR:-/app/data/tmp}"
exec "$@"
