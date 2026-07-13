# trip-pwa-skills

A bundle of cooperating Claude Code skills that compile a curated, offline-first
family-travel PWA. Output is a vanilla static artifact (HTML + CSS + JS + JSON)
the user owns — not a chat answer, not a hosted SaaS. Distilled from the
2026-tokyo-family-travel PWA.

## Skills

- **trip-scaffold** — `init` / `draft-days` / `launch-check`. Generates the PWA
  shell, seeds the day plan, runs pre-publish audits (all three implemented).
- **food-ingest** — caption/URL → `food.json` or `feed_candidates.json` via the
  shared router. Single + `--batch` modes.
- **refs-ingest** — YouTube/blog/Reel URL → `refs.json` `schedule_refs` (行前預習).
  oEmbed title fetch, single + `--batch` modes.
- **placement-promote** — move a parked `feed_candidates` entry into its corpus
  file (`--to food|desserts|attractions|fandom|nearby`) or `--discard`. Per-corpus
  write shape; dedups against the target file. The 待分類 → 歸位 step.

`skills/_lib/` holds shared modules: `corpora.ts` (the venue-corpus registry —
single source of truth for food/desserts/attractions/fandom/nearby; imported by
scaffold + placement-promote, mirrored in render.js, parity-tested), `router.ts`
(caption → corpus, pure sync), `regenerate-sw.ts` (SW manifest, called after every
write batch), `scaffold.ts` (init engine — builds into a staging dir, renames
atomically), `draft-days.ts`, `launch-check.ts` (dup-ref + Playwright a11y),
`icon-gen.ts` (192/512/maskable PNG via resvg-js), `url-key.ts` (normalized dedup).
The underscore prefix excludes `_lib` from skill discovery; modules are imported by
relative path from each skill.

`@resvg/resvg-js` is a bundle dependency (provisioned by `bash install.sh`,
which runs `bun install`). CJK city-initial icons need a CJK system font — macOS
ships Hiragino; Linux CI needs `fonts-noto-cjk`, else the glyph renders as tofu
(Latin initials and user-supplied icons are unaffected).

**v0.5**: the happy path (init → draft-days → food-ingest → refs-ingest →
launch-check → publish) runs end-to-end. v0.5 finished the render loop — the
generated PWA surfaces all five venue corpora (food/desserts/attractions/fandom/
nearby) in one 口袋名單 view + the map, and `placement-promote --to <corpus>` sorts
candidates into them. Dog-fooded on a Hong Kong trip + 6 AI personas (10/10
installability, a11y suite green).

**v0.6 (②-A)**: in-PWA edit mode — the generated app is self-authoring (paste →
route → land → IndexedDB overlay → export). **v0.9.x (②-B)**: BYOK AI drafts
`why_picked` from a family lens, gated by the `tests/evals/family_lens_eval`
hallucination eval. See the AI enrich conventions below before touching any
`templates/js/ai*.js`.

## Standalone mirror (publishing)

This directory is published as the public repo
`github.com/fantasybz/trip-pwa-skills` (MIT). **The monorepo directory is the
single source of truth** — never commit directly to the mirror; fold external
PRs/issues back here, then re-publish. Sync after changes land on `main`:

```bash
git remote add tps-mirror-remote https://github.com/fantasybz/trip-pwa-skills.git 2>/dev/null || true
TREE=$(git rev-parse "origin/main:trip-pwa-skills")
PARENT=$(git ls-remote tps-mirror-remote refs/heads/main | cut -f1)
COMMIT=$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "sync: trip-pwa-skills @ monorepo $(git rev-parse --short origin/main)")
git push tps-mirror-remote "$COMMIT:refs/heads/main"
```

**Snapshot syncs, NEVER `git subtree split/push`.** A subtree split replays
this directory's FULL monorepo history into the mirror — including
pre-sanitization blobs (the eval gold set carried family names before
v0.10.2). The mirror's history must only ever contain current-tree snapshots;
each sync is one commit that parents the previous mirror head (fast-forward by
construction) and names the monorepo sha it mirrors.

Because the mirror is public: no family names in any committed data (venues
gold set uses role aliases like 媽媽/爸爸 — enforced expectation, not just
habit), no keys, no local paths. `.gitignore` here must stay
standalone-complete (the monorepo root .gitignore does not travel with the
snapshot). `package.json` keeps `private: true` on purpose — it blocks an
accidental `npm publish`; repo-public ≠ npm-published.

## Install

```bash
bash install.sh                 # symlink skills into ~/.claude/skills/
bash install.sh --target DIR    # into a project's .claude/skills/
bash install.sh --check         # doctor pre-check only
```

## SKILL.md authoring conventions

When adding or editing a skill:

- **`description` is load-bearing.** Claude picks the skill from this line out of
  100+. Make it specific about *when* to use the skill, not just what it does.
- **Body target 1,500-2,000 words.** A loaded skill stays in context every turn —
  every line is a recurring token cost. Push detail into `references/*.md` and
  load them only when the matching subcommand runs (progressive disclosure).
- **Imperative voice.** "To do X, run Y" — not "you should" / "you can".
- **Reference files are loaded on demand.** List them in a table with a "when to
  load" column; never load all references at once.

## Output PWA conventions (what the skills generate)

- **Vanilla static, no build chain.** Runs from `python -m http.server`, deploys
  to gh-pages. No framework, no bundler.
- **Visual identity is fixed (approved variant A).** Tokens in
  `templates/css/tokens.css`: cream `#FFFCF7`, terracotta `#E76F51`, Hiragino
  Sans + Noto Sans TC, 17px / line-height 1.55. Do not invent a palette per trip.
- **每個備案都有資料.** Every schedule anchor carries an always-visible
  contingency chip. The curatorial depth is the differentiator; never hide it
  behind a tap.
- **Empty states do the emotional work.** A fresh PWA has empty corpus on first
  open. Every empty surface = warm prompt + next command, never "No data".
- **a11y baseline is behavioral, not cosmetic.** focus-visible, tablist arrow
  nav, synthetic-click activation — `launch-check` verifies these with
  Playwright, not a CSS grep. Full catalogue + extension rules:
  `CLAUDE.advanced.md`.
- **Service worker stays in sync.** `regenerate-sw.ts` runs after every write
  batch; never hand-edit the sw.js manifest arrays.

## AI enrich conventions (②-B — `templates/js/ai*.js`)

The generated PWA can BYOK-draft `why_picked`. The files: `ai.js` (key lifecycle +
provider routing + `callModelTool` + `callEnrich`), `ai-verify.js` (the verify-
pass), `ai-validate.js`/`sanitize.js` (shape + XSS gate), `ai-metrics.js`,
`ai-enrich.js` (the UI orchestration). Hard rules:

- **Key safety is non-negotiable.** The BYOK key lives in-memory + `sessionStorage`
  ONLY — never `localStorage`, IndexedDB, the exported corpus, the SW cache, or a
  `console.log`. Don't add a code path that persists or logs it.
- **Provider routing is by key prefix.** `sk-ant-` → Anthropic (browser-direct via
  the `anthropic-dangerous-direct-browser-access` header). Any other `sk-` →
  OpenAI, which is **CORS-blocked browser-direct** → usable only through a scaffold-
  baked CORS proxy (`--openai-proxy`, validated by `resolveOpenAiChatUrl`, baked
  into CSP `connect-src` + the `trip-openai-base` meta). Default (no proxy) =
  fail-fast `openai-needs-proxy`. See `docs/openai-proxy.md`.
- **The grounding guard is cold-only and shipped-on.** `buildSystem`/
  `buildUserContent` add the anti-fabrication clause ONLY for thin venues
  (`isThinVenue` — no category/area/existing_why). Don't guard rich venues (the
  A/B showed it costs accept for no win). The eval toggles it off for the baseline.
- **The verify-pass is ADVISORY, never a gate.** `callVerify` is a 2nd BYOK call
  (~doubles per-enrich cost) fired in the background; its unsupported-claims list
  renders as a ⚠️ 查無依據 warning. Accept is NEVER blocked on it, and any verify
  error is swallowed silently. Keep it that way.
- **Don't drift the prompt from the eval.** `tests/evals/family_lens_eval`
  imports the REAL `buildSystem`/`buildUserContent`/`buildVerify*` — so a prompt
  edit changes the measured numbers. The gate is **major-hallucination ≤ 10% AND
  accept ≥ 75%**. Any change to a prompt builder must be re-measured (the eval
  needs an Anthropic key + `codex`; it's NOT a CI unit test). BOTH precision
  levers (`ai-verify` `strict` clause and `confidence` scored-claims mode) are
  opt-in and default-off precisely so the live behavior can't change without
  that A/B — the default prompt/schema/return shape are locked byte-identical by
  unit tests. Run the whole 3-arm experiment with ONE command:
  `bun tests/evals/family_lens_eval/precision-ab.ts` — see
  `docs/verify-precision-experiment.md` for the decision rule.

## Testing

`bun run test` (from the bundle root) = the Bun unit suites: `skills/` +
`templates/js-tests/` + the pure-fn eval helpers in `tests/evals/`. The
browser-level checks live in `launch-check` (Playwright a11y suite run against
a *generated* trip app), not in the bundle's npm script. The `tests/evals/`
hallucination eval itself is on-demand (LLM calls, needs keys) and lives
OUTSIDE CI — the unit run only picks up `*.test.ts`, never the model-calling
scripts.

See `CLAUDE.advanced.md` for the full a11y convention catalogue ported from the
Tokyo PWA (focus-ring token system, forced-colors, reduced-motion, CJK wrap
scoping) and how launch-check verifies it.
