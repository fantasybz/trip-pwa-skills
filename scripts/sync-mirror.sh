#!/usr/bin/env bash
# sync-mirror.sh — publish trip-pwa-skills/ to the public standalone repo as a
# clean SNAPSHOT commit (github.com/fantasybz/trip-pwa-skills).
#
# Run from anywhere inside the MONOREPO after changes land on origin/main:
#   bash trip-pwa-skills/scripts/sync-mirror.sh
#
# Why a script and not a prose recipe: the inline recipe broke twice in zsh
# (`"$COMMIT:refs…"` eaten by the :r history modifier; `${PARENT:+-p "$PARENT"}`
# not word-split → git saw one "-p <sha>" argument). A bash shebang ends the
# shell-dialect roulette.
#
# Why snapshots and NEVER `git subtree split`: split replays the directory's
# full monorepo history — including pre-sanitization blobs (the eval gold set
# carried family names before v0.10.2). The mirror's history must only ever
# contain current-tree snapshots; each sync parents the previous mirror head
# (fast-forward by construction) and names the monorepo sha it mirrors.
set -euo pipefail

REMOTE=${1:-tps-mirror-remote}
URL=https://github.com/fantasybz/trip-pwa-skills.git
PREFIX=trip-pwa-skills

cd "$(git rev-parse --show-toplevel)"
git remote add "$REMOTE" "$URL" 2>/dev/null || true
git fetch origin --quiet

TREE=$(git rev-parse "origin/main:${PREFIX}")
PARENT=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
MSG="sync: ${PREFIX} @ monorepo $(git rev-parse --short origin/main)"

if [ -n "$PARENT" ]; then
  # On a fresh machine the mirror head exists remotely but not locally —
  # commit-tree -p needs the object in the local odb.
  if ! git cat-file -e "${PARENT}^{commit}" 2>/dev/null; then
    git fetch "$REMOTE" refs/heads/main --quiet
  fi
  if [ "$(git rev-parse "${PARENT}^{tree}")" = "$TREE" ]; then
    echo "mirror already in sync (tree ${TREE} == head of ${REMOTE}/main) — nothing to push"
    exit 0
  fi
  COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
else
  COMMIT=$(git commit-tree "$TREE" -m "$MSG")
fi

git push "$REMOTE" "${COMMIT}:refs/heads/main"
echo "mirror synced → ${COMMIT}"
