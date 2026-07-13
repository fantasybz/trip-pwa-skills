# trip-scaffold launch-check

> **Status: implemented** — `skills/_lib/launch-check.ts`.

Pre-publish audit. Exit 0 = pass, exit 1 = a failure.

## Run

```bash
bun skills/_lib/launch-check.ts --out <trip-dir> [--no-a11y]
```

## Two audits (eng-review D10)

1. **dup-ref (static, always runs)** — every `schedule_refs` URL must be unique
   across the trip. Inline contingency `prep_refs` are EXEMPT (they may reuse a
   `schedule_refs` URL — mirrors Tokyo's R11′ rule). Fails listing the duplicate
   URLs.
2. **a11y-behavior (Playwright)** — runs `tests/a11y.spec.ts` against the served
   PWA:
   - `:focus-visible` draws a visible outline/ring on keyboard focus
   - tablist arrow keys switch day chips (waits for async render; skipped on an
     empty trip)
   - Enter/Space activates `[role="button"][tabindex="0"]` synthetic-click
     targets (skipped if none on the page)

   Skipped with an install hint if `@playwright/test` isn't resolvable in the
   trip dir, or with `--no-a11y`. This is the behavioral check eng-review D10
   demanded — not a CSS grep.

## Install impact

`install.sh` adds `bun add -d @playwright/test playwright && bunx playwright
install chromium`. One extra step for a forking dev, but a11y is locked at Tokyo
grade instead of a CSS-grep approximation.

Deferred to a later pass: offline simulation, missing-coords audit,
prep-collapse persisted-state test (native `<details>` toggles but does not yet
persist across reload).
