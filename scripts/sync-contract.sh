#!/usr/bin/env bash
# Recopies Archon's forge contract into src/contract/ from an Archon checkout.
#   scripts/sync-contract.sh <archon-checkout>
set -euo pipefail
SRC=${1:?usage: sync-contract.sh <archon-checkout>}/packages/forge/src
cd "$(dirname "$0")/.."
for f in identity lifecycle checks events operations response-match plugin-config remote-url; do
  cp "$SRC/$f.ts" src/contract/
done
echo "synced from $(git -C "$SRC" rev-parse HEAD)"
