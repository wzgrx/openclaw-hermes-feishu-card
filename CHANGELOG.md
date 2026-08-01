# Changelog

## Unreleased

- Redesign CardKit replies around the answer-first hierarchy: a compact live
  activity strip while running, the answer as primary content, contextual
  execution logs and one consolidated run-details panel.
- Replace fabricated progress percentages with truthful task stages, hide
  completed progress chrome, suppress zero-value totals and render failure/tool
  details only when they are relevant.
- Add status tags, responsive weighted columns, fill-width layout, improved
  spacing, rounded accordion styling and structured usage/resource metrics.
- Add an official `larksuite/cli` CardKit adapter with structured dry-run and
  create/send/update/finalize smoke-test flows; credentials stay in the child
  process environment rather than argv.
- Expand `doctor` with JSON output, live OpenClaw configuration checks, native
  CardKit/Footer repair, credential redaction and lark-cli raw-API probing.
- Install or repair lark-cli from the WSL installer and synchronize the footer
  subset supported by the `openclaw-lark` direct dispatcher.
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
  real direct-dispatch metrics from `llm_output`, and enrich the channel-owned
  terminal card with a branded header plus accurate model, provider, reasoning,
  token, cache, context and cost lines without relying on a legacy session file.
- Adapt OpenClaw beta's `runtime.config.current()` surface to the stable official
  channel's `loadConfig()` contract so real WebSocket inbound messages work on
  both runtime lines.

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
