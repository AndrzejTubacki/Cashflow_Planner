#!/bin/sh
set -eu
# Runs as root so it can fix ownership on a fresh bind mount (Docker creates
# an absent host directory as root:root before the container starts, which a
# non-root process could never chown), then drops privileges to the node user
# before exec-ing the real command. `exec setpriv ...` replaces this shell
# in place, so the final process keeps PID 1 and its signal handling.
NODE_UID="$(id -u node)"

fix_ownership() {
  dir="$1"
  mkdir -p "$dir"
  owner_uid="$(stat -c '%u' "$dir")"
  if [ "$owner_uid" != "$NODE_UID" ]; then
    chown -R node:node "$dir"
  fi
}

fix_ownership /app/data
fix_ownership /app/logs
fix_ownership /app/backups
# Native SQLite may spill temporary files; keep them on the data mount. A
# fresh /app/data chown above already covers this as a subdirectory, but
# TMPDIR can be overridden to point elsewhere, so check it independently -
# and only through fix_ownership, never unconditionally: a hardened
# deployment that drops CAP_CHOWN (e.g. --cap-drop=ALL) would fail an
# unconditional chown even when ownership already happens to be correct.
fix_ownership "${TMPDIR:-/app/data/tmp}"

exec setpriv --reuid=node --regid=node --init-groups "$@"
