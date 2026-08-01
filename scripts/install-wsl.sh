#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NEW_PLUGIN_ID="openclaw-hermes-feishu-card"
OLD_PLUGIN_ID="openclaw-feishu-card-footer"
INSTALL_OPENCLAW=0
INSTALL_HERMES=0
INSTALL_LARK_CLI=0
RESTART=0

# Prefer native WSL runtimes over Windows PATH interop shims. This also
# selects the OpenClaw binary used by the user's systemd service when it lives
# under nvm.
export PATH="$HOME/.local/bin:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  NVM_BIN="$(
    find "$HOME/.nvm/versions/node" -mindepth 3 -maxdepth 3 -path '*/bin/openclaw' \
      -printf '%h\n' 2>/dev/null | sort -V | tail -n 1
  )"
  if [[ -n "$NVM_BIN" ]]; then
    export PATH="$NVM_BIN:$HOME/.local/bin:$PATH"
  fi
fi

# Package scripts call pnpm recursively (for example `pnpm check`). Ensure a
# native WSL Corepack shim exists instead of depending on a Windows PATH interop
# command that disappears in systemd and clean non-interactive shells.
if command -v corepack >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  if [[ ! -x "$HOME/.local/bin/pnpm" ]]; then
    corepack enable --install-directory "$HOME/.local/bin" pnpm
  fi
fi

run_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    npx --yes pnpm@11.18.0 "$@"
  fi
}

resolve_hermes_python() {
  if [[ -n "${HERMES_PYTHON:-}" ]]; then
    printf '%s\n' "$HERMES_PYTHON"
    return
  fi
  local hermes_executable hermes_real sibling candidate
  hermes_executable="$(command -v hermes 2>/dev/null || true)"
  if [[ -n "$hermes_executable" ]]; then
    hermes_real="$(readlink -f "$hermes_executable" 2>/dev/null || printf '%s' "$hermes_executable")"
    sibling="$(dirname "$hermes_real")/python"
    if [[ -x "$sibling" ]]; then
      printf '%s\n' "$sibling"
      return
    fi
  fi
  for candidate in \
    "$HOME/.hermes/hermes-agent/venv/bin/python" \
    "/usr/local/lib/hermes-agent/venv/bin/python"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

usage() {
  cat <<'EOF'
Usage: bash scripts/install-wsl.sh [--all|--openclaw|--hermes|--lark-cli] [--restart]
EOF
}

if (($# == 0)); then
  INSTALL_OPENCLAW=1
  INSTALL_HERMES=1
  INSTALL_LARK_CLI=1
fi
while (($#)); do
  case "$1" in
    --all) INSTALL_OPENCLAW=1; INSTALL_HERMES=1; INSTALL_LARK_CLI=1 ;;
    --openclaw) INSTALL_OPENCLAW=1; INSTALL_LARK_CLI=1 ;;
    --hermes) INSTALL_HERMES=1 ;;
    --lark-cli) INSTALL_LARK_CLI=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ((INSTALL_LARK_CLI)); then
  command -v npm >/dev/null
  if ! command -v lark-cli >/dev/null 2>&1 || ! lark-cli --version >/dev/null 2>&1; then
    echo "Installing the official @larksuite/cli CardKit diagnostic transport."
    (
      cd /tmp
      npm install -g @larksuite/cli@latest
    )
  fi
  # npm under nvm installs the executable into a version-specific bin folder.
  # Keep one stable user-local entry so later non-interactive service/doctor
  # shells can still discover lark-cli after the installer process exits.
  LARK_CLI_BIN="$(command -v lark-cli)"
  mkdir -p "$HOME/.local/bin"
  if [[ "$LARK_CLI_BIN" != "$HOME/.local/bin/lark-cli" ]]; then
    ln -sfn "$(readlink -f "$LARK_CLI_BIN")" "$HOME/.local/bin/lark-cli"
  fi
  lark-cli --version
fi

if ((INSTALL_OPENCLAW)); then
  command -v node >/dev/null
  command -v openclaw >/dev/null
  OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
  if [[ -f "$OPENCLAW_CONFIG" ]]; then
    cp -a "$OPENCLAW_CONFIG" "$OPENCLAW_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
    node - "$OPENCLAW_CONFIG" "$OLD_PLUGIN_ID" "$NEW_PLUGIN_ID" "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [configPath, oldId, newId, root] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.channels ??= {};
if (config.channels.feishu && typeof config.channels.feishu === "object") {
  // The Feishu direct dispatcher skips cross-plugin reply_payload_sending.
  // Keep streaming enabled; this project registers the versioned official
  // controller itself and enriches its terminal card in memory.
  config.channels.feishu.streaming = true;
  config.channels.feishu.replyMode = "streaming";
  config.channels.feishu.blockStreaming = false;
}
config.plugins ??= {};
config.plugins.entries ??= {};
const oldEntry = config.plugins.entries[oldId];
if (oldEntry && !config.plugins.entries[newId]) {
  config.plugins.entries[newId] = {
    ...oldEntry,
    enabled: true,
  };
}
delete config.plugins.entries[oldId];
const newEntry = config.plugins.entries[newId] ?? { enabled: true };
const pluginConfig = newEntry.config ?? {};
const legacyStorageDirs = new Set([
  "~/.local/share/feishu-card-footer",
  "~/.local/share/openclaw-feishu-card-footer",
]);
newEntry.enabled = true;
newEntry.hooks ??= {};
newEntry.hooks.allowConversationAccess = true;
newEntry.config = {
  ...pluginConfig,
  embeddedLark: true,
  captureChannels: [
    ...new Set([
      ...(Array.isArray(pluginConfig.captureChannels)
        ? pluginConfig.captureChannels
        : []),
      "feishu",
      "openclaw-lark",
    ]),
  ],
  title: pluginConfig.title ?? "OpenClaw",
  accountTitles: pluginConfig.accountTitles ?? {},
  storageDir:
    !pluginConfig.storageDir || legacyStorageDirs.has(pluginConfig.storageDir)
      ? "~/.local/share/openclaw-hermes-feishu-card"
      : pluginConfig.storageDir,
  legacyTaskDir: pluginConfig.legacyTaskDir ?? "/tmp/openclaw-tasks",
  balanceCachePath:
    pluginConfig.balanceCachePath ?? "~/.openclaw/data/balance-cache.json",
  panels: {
    ...(pluginConfig.panels ?? {}),
    resources: pluginConfig.panels?.resources ?? false,
  },
  footer: {
    ...(pluginConfig.footer ?? {}),
    totals: pluginConfig.footer?.totals ?? false,
    todayTokens: pluginConfig.footer?.todayTokens ?? false,
    monthTokens: pluginConfig.footer?.monthTokens ?? false,
    backgroundTasks: pluginConfig.footer?.backgroundTasks ?? false,
    balance: pluginConfig.footer?.balance ?? false,
  },
};
config.plugins.entries[newId] = newEntry;
config.plugins.entries["openclaw-lark"] = {
  ...(config.plugins.entries["openclaw-lark"] ?? {}),
  enabled: false,
};
if (config.channels.feishu && typeof config.channels.feishu === "object") {
  const nativeFooterKeys = [
    "status",
    "elapsed",
    "tokens",
    "cache",
    "context",
    "model",
  ];
  config.channels.feishu.footer ??= {};
  for (const key of nativeFooterKeys) {
    config.channels.feishu.footer[key] = newEntry.config.footer[key] ?? true;
  }
}
if (Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [
    ...new Set(
      config.plugins.allow
        .filter((id) => id !== oldId && id !== "openclaw-lark")
        .concat(newId),
    ),
  ];
}
if (Array.isArray(config.plugins.load?.paths)) {
  config.plugins.load.paths = config.plugins.load.paths.filter((candidate) => {
    const normalized = String(candidate).replaceAll("\\", "/");
    return (
      normalized !== oldId &&
      path.basename(normalized) !== oldId &&
      !normalized.endsWith(`/${oldId}`)
    );
  });
  if (!config.plugins.load.paths.includes(root)) {
    config.plugins.load.paths.push(root);
  }
}
if (config.session?.store === "~/.openclaw/sessions/store.json") {
  delete config.session.store;
  if (Object.keys(config.session).length === 0) delete config.session;
}
const temporary = `${configPath}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, configPath);
NODE
  fi
  NEW_STORAGE="${OPENCLAW_HERMES_FEISHU_CARD_HOME:-$HOME/.local/share/openclaw-hermes-feishu-card}"
  for OLD_STORAGE in \
    "$HOME/.local/share/feishu-card-footer" \
    "$HOME/.local/share/openclaw-feishu-card-footer"; do
    if [[ -d "$OLD_STORAGE" ]]; then
      if [[ ! -e "$NEW_STORAGE" ]]; then
        mkdir -p "$(dirname "$NEW_STORAGE")"
        mv "$OLD_STORAGE" "$NEW_STORAGE"
      else
        if [[ -f "$OLD_STORAGE/usage.ndjson" ]]; then
          cat "$OLD_STORAGE/usage.ndjson" >>"$NEW_STORAGE/usage.ndjson"
          rm -f "$OLD_STORAGE/usage.ndjson"
        fi
        cp -a --update=none "$OLD_STORAGE/." "$NEW_STORAGE/"
        rm -rf "$OLD_STORAGE"
      fi
    fi
  done
  openclaw plugins disable "$OLD_PLUGIN_ID" >/dev/null 2>&1 || true
  openclaw plugins disable openclaw-lark >/dev/null 2>&1 || true
  (
    cd "$ROOT"
    run_pnpm install --frozen-lockfile
    run_pnpm check
    openclaw plugins install --link --force .
    openclaw plugins enable "$NEW_PLUGIN_ID"
    openclaw plugins doctor
    run_pnpm run doctor -- --runtime
  )
fi

if ((INSTALL_HERMES)); then
  command -v hermes >/dev/null
  HERMES_PYTHON="$(resolve_hermes_python || true)"
  if [[ -z "$HERMES_PYTHON" || ! -x "$HERMES_PYTHON" ]]; then
    echo "Hermes Python was not found beside the active Hermes executable." >&2
    exit 1
  fi
  if "$HERMES_PYTHON" -c \
    'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("hermes_lark_streaming") else 1)'; then
    echo "Removing the legacy hermes-lark-streaming source patch."
    "$HERMES_PYTHON" -m hermes_lark_streaming uninstall
    hermes plugins disable hermes-lark-streaming >/dev/null 2>&1 || true
  fi
  hermes plugins disable hermes-feishu-streaming-card >/dev/null 2>&1 || true
  HERMES_ROOT="$(
    "$HERMES_PYTHON" -c \
      'from pathlib import Path; import gateway; print(Path(gateway.__file__).resolve().parent.parent)'
  )"
  if grep -Rqs '# HERMES_LARK_.*_BEGIN' \
    "$HERMES_ROOT/gateway/run.py" "$HERMES_ROOT/cron/scheduler.py" 2>/dev/null; then
    echo "Legacy Hermes-Lark patch markers remain in $HERMES_ROOT; restore that checkout first." >&2
    exit 1
  fi
  "$HERMES_PYTHON" -m pip install -e "$ROOT"
  PLUGIN_DIR="${HERMES_HOME:-$HOME/.hermes}/plugins/feishu-platform"
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  if [[ -e "$PLUGIN_DIR" && ! -L "$PLUGIN_DIR" ]]; then
    mv "$PLUGIN_DIR" "${PLUGIN_DIR}.bak.$(date +%Y%m%d%H%M%S)"
  fi
  ln -sfn "$ROOT" "$PLUGIN_DIR"
  hermes plugins enable feishu-platform
  "$HERMES_PYTHON" -m openclaw_hermes_feishu_card.cli doctor
fi

if ((RESTART)); then
  if ((INSTALL_OPENCLAW)); then openclaw gateway restart; fi
  if ((INSTALL_HERMES)); then hermes gateway restart; fi
fi

echo "Install checks completed."
