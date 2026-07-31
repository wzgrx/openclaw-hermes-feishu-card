# Feishu CardKit for OpenClaw and Hermes

A hybrid repository with native integrations for both runtimes:

- A TypeScript OpenClaw plugin using the public reply and tool hooks.
- A Python Hermes platform plugin extending Hermes' native `FeishuAdapter`.

Both render answer text, tool progress, runtime metrics, token usage and configured cost estimates in one CardKit 2.0 message. Media, files, voice, approvals, commands and inbound transport remain owned by the upstream Feishu channel adapters.

## Quick start

```bash
corepack enable 2>/dev/null || npm install --global pnpm@11.18.0
pnpm install --frozen-lockfile
pnpm check

python -m venv .venv
source .venv/bin/activate
pip install -e '.[hermes,dev]'
ruff check .
pytest
```

OpenClaw:

```bash
pnpm build
openclaw plugins install --link .
openclaw plugins enable openclaw-feishu-card-footer
```

Hermes:

```bash
hermes plugins install wzgrx/openclaw-feishu-card-footer --enable
HERMES_BIN="$(readlink -f "$(command -v hermes)")"
HERMES_PYTHON="$(dirname "$HERMES_BIN")/python"
"$HERMES_PYTHON" -m pip install -e ~/.hermes/plugins/feishu-platform
```

For a local WSL checkout, install both integrations with:

```bash
bash scripts/install-wsl.sh --all --restart
```

See [configuration](docs/configuration.md), [architecture](docs/architecture.md),
[compatibility](docs/compatibility.md), [maintenance](docs/maintenance.md), and
[migration](docs/migration.md).

## Principles

- Public extension points only; no source-tree patching.
- Monotonic CardKit sequences and explicit finalization.
- Fail-open delivery: native text remains active when card delivery fails.
- Append-only NDJSON usage storage shared across runtimes.
- Credentials are resolved from the host configuration or environment.

## License

MIT
