#!/usr/bin/env bash
# trip-pwa-skills installer.
#   1. Doctor pre-check: verify the runtime tools the skills need.
#   2. Symlink each real skill into ~/.claude/skills/ (or a target project's
#      .claude/skills/ via --target).
#
# The _lib/ directory is NOT a skill — it rides along inside each skill's
# relative-import path, so only the real skill dirs get symlinked.
#
# Usage:
#   bash install.sh                 # symlink into ~/.claude/skills/
#   bash install.sh --target DIR    # symlink into DIR/.claude/skills/
#   bash install.sh --check         # doctor only, no symlinks

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$ROOT/skills"

TARGET=""
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --check)  CHECK_ONLY=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ----- 1. Provision bundle deps + doctor pre-check -------------------------
# A forking dev needs these. Missing tools are the real install friction, so
# name each one and how to get it instead of failing silently mid-run.

# Provision the bundle's own JS deps (@resvg/resvg-js for icon generation) so a
# fresh `git clone → bash install.sh` makes `trip-scaffold init` work without a
# manual `bun install` (Codex P1). @playwright/test is NOT a bundle dep — it's
# declared in templates/package.json and installed in each generated trip dir.
if command -v bun >/dev/null 2>&1 && [ "$CHECK_ONLY" -ne 1 ]; then
  echo "→ Installing bundle deps (bun install)..."
  ( cd "$ROOT" && bun install >/dev/null 2>&1 ) && echo "  ✓ bun install" || echo "  ⚠ bun install failed — run it manually in $ROOT"
fi

echo "→ Checking runtime dependencies..."
MISSING=0
check_tool() {
  local bin="$1" hint="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    echo "  ✓ $bin"
  else
    echo "  ✗ $bin — $hint"
    MISSING=1
  fi
}

check_tool bun        "install: https://bun.sh  (curl -fsSL https://bun.sh/install | bash)"
check_tool yt-dlp     "install: brew install yt-dlp  (food-ingest: download Reel/IG captions+audio)"
check_tool ffmpeg     "install: brew install ffmpeg  (Whisper audio conversion)"
check_tool whisper-cli "install: brew install whisper-cpp  (local transcription; or set WHISPER_CLI)"

# @resvg/resvg-js is a bundle dependency (package.json) — provisioned above.
if [ -d "$ROOT/node_modules/@resvg/resvg-js" ]; then
  echo "  ✓ @resvg/resvg-js (bundle dep)"
else
  echo "  ✗ @resvg/resvg-js — run: cd $ROOT && bun install  (trip-scaffold: PNG icon generation)"
  MISSING=1
fi

# Note: CJK city-initial app icons need a CJK-capable system font. macOS ships
# Hiragino/PingFang (works out of the box). On Linux CI, install fonts-noto-cjk
# (apt-get install fonts-noto-cjk) or the initial renders as tofu — a Latin
# initial or a user-supplied icon PNG avoids the dependency entirely. (A reliable
# cross-platform font probe is intentionally not attempted here: fc-list reports
# wrong on macOS, which uses CoreText, while resvg still finds the font.)

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "Some dependencies are missing. Install them, then re-run." >&2
  echo "The skills will still symlink, but commands needing a missing tool will fail." >&2
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit "$MISSING"
fi

# ----- 2. Symlink skills ---------------------------------------------------
if [ -n "$TARGET" ]; then
  DEST="$TARGET/.claude/skills"
else
  DEST="$HOME/.claude/skills"
fi
mkdir -p "$DEST"

echo ""
echo "→ Linking skills into $DEST"
for skill_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill_dir")"
  # Skip the _lib shared-modules dir — not a skill.
  [ "$name" = "_lib" ] && continue
  # Only link dirs that actually contain a SKILL.md.
  [ -f "$skill_dir/SKILL.md" ] || continue

  link="$DEST/$name"
  if [ -L "$link" ]; then
    cur="$(readlink "$link")"
    if [ "$cur" = "${skill_dir%/}" ]; then
      echo "  ✓ $name (already linked)"
      continue
    fi
    echo "  ↻ $name (relinking from $cur)"
    rm "$link"
  elif [ -e "$link" ]; then
    echo "  ⚠ $name exists and is not a symlink — skipping (remove it to link)" >&2
    continue
  fi
  ln -s "${skill_dir%/}" "$link"
  echo "  ✓ $name → ${skill_dir%/}"
done

echo ""
echo "Done. Try:  Use trip-scaffold to create a Kyoto family trip PWA: 5 days, Traditional Chinese, kid age 6."
