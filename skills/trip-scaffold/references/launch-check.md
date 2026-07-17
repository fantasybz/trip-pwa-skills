# trip-scaffold launch-check

> **Status: implemented** — `skills/_lib/launch-check.ts`.

Pre-publish audit. Exit 0 = every requested audit ran and passed; exit 1 = a
failure or an audit that could not run.

## Run

```bash
bun skills/_lib/launch-check.ts --out <trip-dir>
```

The `family` content profile runs by default. `--quality family` remains an
explicit alias for scripts. `--no-quality` is a partial-check escape hatch and
is reported as skipped, just like `--no-browser-tests`.

## Three audits (eng-review D10 + multi-city parity)

1. **dup-ref (static, always runs)** — every `schedule_refs` URL must be unique
   across the trip. Inline contingency `prep_refs` are EXEMPT (they may reuse a
   `schedule_refs` URL — mirrors Tokyo's R11′ rule). Fails listing the duplicate
   URLs.
2. **content-depth (default `family` profile)** — a machine-checkable, portable floor:
   - trip dates are valid/ordered, day count matches the inclusive date span,
     each day date matches that span in order, and `day_1..day_N` IDs are
     non-blank, unique, and ordered;
   - every day has ≥3 real anchors and the trip averages ≥4/day;
   - every real anchor has a named backup + reason;
   - every day has ≥1 actionable prep ref and the trip averages ≥2/day; each
     counted ref needs a non-blank title and an `http(s)` URL;
   - confirmed venues have unique IDs, bind only to real trip `day_keys`,
     average ≥3 assigned venues/day, and retain family rationale, navigation
     detail, and hours (hours exempt for `nearby`);
   - `days.json` and every present venue corpus use the top-level array shape
     consumed by the browser renderer;
   - every traveler has a documented `age_band`.

   This catches skeleton-grade output and silent data loss. Passing it does
   **not** certify authenticity, language quality, or full Tokyo editorial
   depth; those remain human review dimensions.
3. **browser-suite (Playwright)** — runs bundle-owned generated-app behavior
   specs from `templates/tests/**/*.spec.ts` plus trusted-only harness specs
   from `tests/playwright-trusted/**/*.spec.ts`. The audited trip is static
   input only: its runner, config, specs, and `node_modules` are never
   executed. Before Playwright starts, launch-check binds and holds an ephemeral
   `127.0.0.1` port itself, rejects symlinks anywhere in the allowlisted served
   tree, and serves only root app files plus `css/`, `js/`, `data/`, and
   `assets/`. Responses carry a locked CSP (`connect-src 'self'`, workers
   disabled) and no-store/security headers.

   Only the exact reserved origin `trip-pwa.test:<held-port>` bypasses the deny
   proxy. Every other host/IP, including `trip-pwa.test` on another loopback
   port, is sent to the same listener as a proxy request and receives 403;
   external DNS and non-proxied WebRTC are disabled, and service workers are
   blocked. A trusted-only browser spec binds a second loopback sentinel and
   proves Chromium never reaches it. The held listener is closed in `finally`,
   so the audit never reuses an unrelated process on a fixed port. This is a
   narrow test harness boundary, not a general-purpose sandbox for arbitrary
   hostile HTML; an active same-UID process racing filesystem replacements
   between served-tree validation and file reads is outside its threat model.
   The a11y checks include:
   - `:focus-visible` draws a visible outline/ring on keyboard focus
   - tablist arrow keys switch day chips (waits for async render; skipped on an
     empty trip)
   - Enter/Space activates `[role="button"][tabindex="0"]` synthetic-click
     targets (skipped if none on the page)

   A missing bundle `@playwright/test` runner **fails closed** with an install hint.
   `--no-browser-tests` is allowed only when the caller explicitly wants a partial check;
   it exits 0 when static audits pass but prints `partial check only`. This is
   the behavioral check eng-review D10 demanded — not a CSS grep. The former
   `--no-a11y` spelling remains only as a deprecated alias and also skips the
   complete browser suite.

`--no-quality` is likewise explicit and partial: duplicate-ref/Playwright can
still run, but the result never claims that family content readiness was checked.

## Install impact

The trusted runner is a bundle dependency. Before the first qualified audit,
run `cd <trip-pwa-skills> && bun install && bunx playwright install chromium`.
Generated trips retain a Playwright config for direct local development, but
launch-check never trusts it. One extra setup step locks behavior at Tokyo grade instead of
using a CSS-grep approximation.

The GitHub Actions Kyoto scaffold is intentionally sparse and calls
`launch-check --no-quality`; it is a browser-harness smoke, not a qualified
family itinerary. Content-profile logic is covered by unit tests. Release
qualification still requires the unskipped command on a real trip or fixture
that meets the family floor.

Deferred to a later pass: offline simulation, geocoding/coordinate precision,
prep-collapse persisted-state test (native `<details>` toggles but does not yet
persist across reload).
