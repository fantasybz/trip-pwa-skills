#!/usr/bin/env bash
# fresh-machine-test.sh — prove the zero-to-PWA path on a clean Linux box.
#
# Runs the bundle in a fresh `oven/bun` container (no node_modules, no system
# fonts beyond the base image), exercising the install + scaffold + CJK-icon +
# atomic-failure behaviour that the CI workflow also runs. Use this locally
# before changing scaffold/icon-gen/install.sh.
#
# Requires: docker.  Usage:  bash scripts/fresh-machine-test.sh
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "→ Fresh Linux container test of: $BUNDLE_DIR"

docker run --rm -v "$BUNDLE_DIR":/src:ro oven/bun:latest bash -euo pipefail -c '
  echo "--- copy bundle (fresh, no node_modules) ---"
  mkdir -p /bundle
  cp -r /src/skills /src/templates /src/install.sh /src/package.json /src/CLAUDE.md /bundle/
  cd /bundle

  echo "--- bun install (provision @resvg/resvg-js) ---"
  bun install >/dev/null 2>&1 && echo "  ✓ bun install"

  echo "--- router unit tests ---"
  bun test skills/_lib/router.test.ts 2>&1 | grep -E "[0-9]+ pass|[0-9]+ fail" | sed "s/^/  /"

  echo "--- Latin city, no CJK font yet → should scaffold ---"
  bun skills/_lib/scaffold.ts --city Bangkok --days 2 --start 2026-08-01 --out /tmp/bkk \
    | grep -E "icons" | sed "s/^/  /"

  echo "--- CJK city WITHOUT fonts-noto-cjk → preflight should THROW, no partial ---"
  if bun skills/_lib/scaffold.ts --city Kyoto --city-jp 京都 --days 2 --start 2026-08-01 --out /tmp/kyo 2>/tmp/err; then
    echo "  ✗ expected a failure but scaffold succeeded"; exit 1
  fi
  grep -qi "no CJK font" /tmp/err || { echo "  ✗ missing clean CJK-font error"; cat /tmp/err; exit 1; }
  echo "  ✓ clean CJK-font error"
  [ -e /tmp/kyo ] && { echo "  ✗ partial target left"; exit 1; } || echo "  ✓ no partial target (atomic staging)"

  echo "--- install fonts-noto-cjk, retry CJK → should render ---"
  apt-get update >/dev/null 2>&1 && apt-get install -y fonts-noto-cjk >/dev/null 2>&1 && echo "  ✓ fonts-noto-cjk"
  bun skills/_lib/scaffold.ts --city Kyoto --city-jp 京都 --days 2 --start 2026-08-01 --out /tmp/kyo2 \
    | grep -E "icons" | sed "s/^/  /"
  # PNG dimensions live in the IHDR (bytes 16-23, big-endian w/h) — read without
  # the `file` tool, which the base image lacks.
  DIMS=$(bun -e "const b=require(\"fs\").readFileSync(\"/tmp/kyo2/assets/icons/icon-512.png\");console.log(b.readUInt32BE(16)+\"x\"+b.readUInt32BE(20))")
  [ "$DIMS" = "512x512" ] && echo "  ✓ 512 CJK icon rendered on Linux ($DIMS)" \
    || { echo "  ✗ wrong icon dims: $DIMS"; exit 1; }

  echo "✓ fresh-machine test passed"
'
