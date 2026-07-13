# trip-pwa-skills roadmap (written 2026-07-13, post-v0.10)

The core arc (① skill bundle → ②-A edit mode → ②-B BYOK enrich + verify-pass)
is shipped and gate-passing. This is the follow-through map: what's staged,
what's blocked on a key session, what's deliberately post-trip (Tokyo trip
2026-07-23 → ~08-01; the trip itself is the live priority until then), and the
release-readiness decisions only the owner can make.

## Phase 1 — staged and done (this PR, v0.10.1)

No-key, default-preserving hardening of the precision experiment:

- **Confidence-scored verifier lever** (`ai-verify.js` `{ confidence: true }`):
  per-claim 0–1 scores, thresholded in JS. One scored run = the whole
  precision/recall curve (τ-sweep in `verify-pass.ts`), instead of one
  operating point per prompt variant. Default prompt/schema/return shape stay
  byte-identical (unit-locked).
- **One-command A/B** (`precision-ab.ts`): runs default/strict/confidence over
  the same drafts, scores with shared `eval-lib` math (now unit-tested), picks
  the τ operating point, applies the decision rule, writes
  `precision-ab.results.md`. Resume (`--reuse`), smoke (`--limit 40`), and
  keyless re-score (`--score-only`) included.
- **Docs debt**: `CLAUDE.advanced.md` (the promised a11y catalogue) written;
  `_lib/README.md` un-staled; Testing section corrected; DOGFOOD.md status
  note; eval `.gitignore` now covers `vfy-out.*` / results artifacts.

## Phase 2 — the key session (~10 min of owner time, one command)

Everything below needs an `ANTHROPIC_API_KEY` (+ `codex` on PATH for ground
truth). Batched so ONE session settles the whole queue:

1. **E1 — verifier precision A/B** (the headline):

   ```bash
   cd trip-pwa-skills/tests/evals/family_lens_eval
   ANTHROPIC_API_KEY=… bun run.ts --arm baseline --generate anthropic --judge codex   # once
   ANTHROPIC_API_KEY=… bun precision-ab.ts                                            # the A/B
   ```

   Decision rule in `docs/verify-precision-experiment.md`. Outcome: flip the
   live ⚠️ 查無依據 warning to strict / confidence@τ (one-line change + the τ
   filter), or keep default with a measured justification. This closes the last
   ②-B weakness (66.4% flag-rate alarm fatigue).
2. **E2 (optional) — hook-regime nudge A/B.** RESULTS.md documents a real
   −8.4pt accept dip on hook-seeded rewrites from the anti-drift nudge. If the
   faithful-but-plainer tradeoff ever feels wrong in use, A/B a softer hook
   nudge via `verify-regime-guard.ts`. Full gate re-measure required (it
   touches the generator prompt). Skip unless it hurts in practice.
3. **E3 (optional) — generator model refresh.** `DEFAULT_MODEL` is
   `claude-sonnet-4-6`. When bumping to a newer Sonnet, re-run the full eval
   gate first (`run.ts --arm baseline` + `--arm guard`) — the numbers in
   RESULTS.md are model-bound. Same for `OPENAI_DEFAULT_MODEL` via the proxy
   path. Not urgent; BYOK users pay per call, so cost/quality is their tradeoff.

## Phase 3 — post-trip (revisit after 2026-07-31)

Per `docs/v0.10-saas-scoping.md`, unchanged:

- **Reels ingest v2** (smarter placement, batch dedup, auto-promote): needs
  real post-trip feed volume. **During the trip, save raw feed dumps** (share
  URLs + captions, any format) into `.context/feed-dumps/` — that becomes the
  v2 design corpus for free.
- **③-B hosted gallery + fork-to-deploy**: only if outside users show up and
  their friction is discovery/starting. Entry criteria in the scoping doc still
  hold (none met today). ③-A shared proxy and ③-C multi-tenant SaaS stay
  rejected — they betray the "you own it" thesis.

## Release-readiness decisions (owner-only, any time)

Small, but they gate anyone else actually using the bundle:

1. **LICENSE — DONE (v0.10.2, 2026-07-13):** MIT, per the "you own it" thesis.
2. **Standalone repo — DONE (2026-07-13):** the bundle is published to
   `github.com/fantasybz/trip-pwa-skills` as clean snapshot commits (the
   Quickstart clone URL is live; fresh clone runs 246/246 tests). The monorepo
   directory stays the source of truth — sync recipe (commit-tree snapshots,
   never subtree split: split would replay pre-sanitization history) + the
   never-commit-to-mirror rule in `CLAUDE.md` "Standalone mirror".
   Pre-publish hygiene done: family names sanitized out of the gold set
   (role aliases only — keep it that way in future venue data), no keys/emails/
   local paths in the bundle.
3. **(Optional) security pass**: ②-B shipped through Codex GATE PASS with key-
   safety checks; a standalone `/cso` sweep over `ai*.js` + the CORS worker
   before announcing the repo would be cheap insurance.

## Known infra nits (documented, not worth fixing now)

- The `bundle` GitHub Actions check phantom-fails in ~1s (`steps:0`, a billing
  artifact) → merges use `--squash --admin` per repo convention (#387 keeps the
  main Tests check red anyway, headless-WebGL). Local `bun run test` is the
  real gate for bundle changes.
- Fresh worktrees may need `bun install` in the bundle before tests
  (missing-devDep flake).
