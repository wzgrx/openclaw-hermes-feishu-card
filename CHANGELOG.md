# Changelog

## Unreleased

- Add an official `larksuite/cli` CardKit adapter with structured dry-run and
  create/send/update/finalize smoke-test flows; credentials stay in the child
  process environment rather than argv.
- Expand `doctor` with JSON output, live OpenClaw configuration checks, native
  CardKit/Footer repair, credential redaction and lark-cli raw-API probing.
- Install or repair lark-cli from the WSL installer and synchronize the footer
  subset supported by the `openclaw-lark` direct dispatcher.
- Keep plain-text replies eligible for CardKit rendering when OpenClaw attaches
  delivery routing metadata; rich/media payloads still remain native.

- Force Gateway startup activation so hook-only CardKit delivery is present in
  the live Feishu inbound/reply pipeline instead of loading only in inspection
  and standalone CLI processes.
- Add route-safe diagnostics for captured replies and successful card delivery.
- Keep native streaming CardKit enabled for `@larksuite/openclaw-lark` 2026.7.x,
  whose direct dispatcher bypasses cross-plugin reply payload modifiers.

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
