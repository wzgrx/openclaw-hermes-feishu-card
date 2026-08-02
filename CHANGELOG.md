# Changelog

## Unreleased

- Source the visible model identity from OpenClaw's resolved model-call hooks and
  show the exact `provider/model · API adapter` in the classic footer; retain
  transport metadata without guessing a vendor brand from the provider ID.

- Restore the exact CardKit renderer that was installed in WSL immediately
  before migration: no added header, a collapsed waiting-tool panel, an
  expanded active-tool panel, separate collapsed tool/reasoning panels on
  completion, answer content after those panels, and the original two-line
  status/model plus token/cache/context footer.
- Keep the pinned official channel builder visually untouched and replace only
  the controller's metric source; the checked-in contract records the original
  installed source SHA-256 and verifies all lifecycle states.
- Replace fabricated progress percentages with truthful task stages, hide
  completed progress chrome, suppress zero-value totals and render failure/tool
  details only when they are relevant.
- Keep the original grey 5px panel borders, official icons, locale text,
  expansion behavior and natural CardKit body layout; preserve richer runtime
  metrics internally without expanding the completed card into a dashboard.
- Apply the same pre-migration hierarchy to the routed TypeScript renderer and
  Hermes renderer, while the normal Feishu path continues to use the original
  official builder directly.
- Add an official `larksuite/cli` CardKit adapter with structured dry-run and
  create/send/update/finalize smoke-test flows; credentials stay in the child
  process environment rather than argv.
- Make the official CLI smoke fixture exercise the classic no-header running
  card shape instead of validating a one-element placeholder card.
- Add an `--entity` CardKit smoke mode that performs real create/update/finalize
  API calls without posting a message into a chat, enabling autonomous runtime
  verification before the explicit end-to-end resend step.
- Finalize the smoke fixture's two-line footer before closing streaming mode, so
  both entity-only and live diagnostics end in a completed visual state.
- Expand `doctor` with JSON output, live OpenClaw configuration checks, native
  CardKit/Footer repair, credential redaction and lark-cli raw-API probing.
- Make `doctor` enforce the pinned pre-migration Builder SHA-256, classic panel
  toggles and exact two-line footer fields, so a future dependency or runtime
  configuration drift is detected before it changes the visible card again.
- Install or repair lark-cli from the WSL installer and synchronize the footer
  subset supported by the `openclaw-lark` direct dispatcher.
- Persist the nvm-installed `lark-cli` entry under `~/.local/bin` so doctor and
  non-interactive smoke-test shells discover the official CLI consistently.
- Provision a native WSL Corepack `pnpm` shim in the same stable user bin path,
  removing the hidden dependency on Windows PATH interop during recursive
  checks, installs and service-oriented maintenance.
- Document doctor invocations as `pnpm run doctor` so pnpm executes the project
  diagnostic script rather than its unrelated built-in package-manager doctor.
- Keep plain-text replies eligible for CardKit rendering when OpenClaw attaches
  delivery routing metadata; rich/media payloads still remain native.
- Recover native Feishu chat targets from canonical OpenClaw session keys when
  outbound hook contexts omit `conversationId`, so the rich card renderer can
  reliably replace the built-in minimal card.
- Treat generic core `channelData` as metadata rather than an automatic native
  delivery opt-out while preserving explicit Feishu cards and rich payloads.
- Capture channel-agnostic text/context `presentation` blocks while preserving
  presentations with buttons, selects, pin requests and explicit native cards.
- Normalize runtime metadata from the resolved model winner, split provider and
  model into separate fields, retain requested-versus-actual fallback routing,
  and show reasoning/override configuration only when reported by OpenClaw.
- Use final-call prompt occupancy for context instead of multi-call aggregate
  input, label aggregate-only fallback values as estimates, and separate turn
  totals from the final model call.
- Prefer runtime-reported duration and cost, preserve exact token/context values,
  and increase precision for sub-unit costs.

- Force Gateway startup activation so hook-only CardKit delivery is present in
  the live Feishu inbound/reply pipeline instead of loading only in inspection
  and standalone CLI processes.
- Add route-safe diagnostics for captured replies and successful card delivery.
- Keep native streaming CardKit enabled for `@larksuite/openclaw-lark` 2026.7.x,
  whose direct dispatcher bypasses cross-plugin reply payload modifiers.
- Integrate the version-pinned official Feishu channel into this plugin, capture
  real direct-dispatch metrics from `llm_output`, retain accurate model,
  provider, reasoning, token, cache, context and cost values internally, and map
  the legacy visible subset without relying on a stale session file.
- Adapt OpenClaw beta's `runtime.config.current()` surface to the stable official
  channel's `loadConfig()` contract so real WebSocket inbound messages work on
  both runtime lines.
- Share direct-dispatch metrics across repeated runtime registrations and map
  accurate runtime values into the original two-line footer without altering
  the official element order.

## 2.0.0

- Renamed the unified project and plugin to `openclaw-hermes-feishu-card`.
- Migrated the legacy multi-account title, attachment summary, GPU, background-task
  and provider-balance presentation features.
- Added compatibility for the former Python package, CLI, configuration fields,
  environment variable and usage-ledger location.
- Replaced source patches, sidecars and progress HTTP services with native OpenClaw
  hooks and a Hermes platform adapter.
- Added bounded readers for legacy task and balance cache files plus a credential-safe
  balance refresh helper.

## 1.0.0

- Rebuilt the repository as a dual OpenClaw/Hermes CardKit plugin.
- Added streamed answer, reasoning, tool, progress, resource, token and cost panels.
- Added a shared, versioned and backward-compatible NDJSON usage ledger.
- Added CardKit byte, element and markdown-table limit guards.
- Added native WSL runtime discovery, CI, release packaging and bilingual documentation.
- Added runtime contract tests for OpenClaw and Hermes plus a weekly upstream compatibility workflow.
- Moved OpenClaw types to the supported `plugin-sdk/core` surface and added a beta API canary.
