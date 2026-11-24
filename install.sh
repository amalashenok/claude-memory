#!/bin/sh
# Linux / macOS / Git Bash: installs claude-memory with Node.js >= 22.18.
# Set NODE=/path/to/node when the default `node` is older. All options go to install.mjs (see --help).
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
NODE_BIN=${NODE:-node}
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "Node.js >= 22.18 is required: https://nodejs.org (or set NODE=/path/to/node)" >&2
    exit 1
fi
exec "$NODE_BIN" "$DIR/install.mjs" "$@"
