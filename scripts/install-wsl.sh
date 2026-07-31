#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NEW_PLUGIN_ID="openclaw-hermes-feishu-card"
OLD_PLUGIN_ID="openclaw-feishu-card-footer"
INSTALL_OPENCLAW=0
INSTALL_HERMES=0
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
Usage: bash scripts/install-wsl.sh [--all|--openclaw|--hermes] [--restart]
EOF
}

if (($# == 0)); then
  INSTALL_OPENCLAW=1
  INSTALL_HERMES=1
fi
while (($#)); do
  case "$1" in
    --all) INSTALL_OPENCLAW=1; INSTALL_HERMES=1 ;;
    --openclaw) INSTALL_OPENCLAW=1 ;;
    --hermes) INSTALL_HERMES=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

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
newEntry.config = {
  ...pluginConfig,
  title: pluginConfig.title ?? "OpenClaw",
  accountTitles: pluginConfig.accountTitles ?? {},
  storageDir:
    !pluginConfig.storageDir || legacyStorageDirs.has(pluginConfig.storageDir)
      ? "~/.local/share/openclaw-hermes-feishu-card"
      : pluginConfig.storageDir,
  legacyTaskDir: pluginConfig.legacyTaskDir ?? "/tmp/openclaw-tasks",
  balanceCachePath:
    pluginConfig.balanceCachePath ?? "~/.openclaw/data/balance-cache.json",
  footer: {
    ...(pluginConfig.footer ?? {}),
    todayTokens: pluginConfig.footer?.todayTokens ?? true,
    monthTokens: pluginConfig.footer?.monthTokens ?? true,
    backgroundTasks: pluginConfig.footer?.backgroundTasks ?? true,
    balance: pluginConfig.footer?.balance ?? true,
  },
};
config.plugins.entries[newId] = newEntry;
if (Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [
    ...new Set(config.plugins.allow.filter((id) => id !== oldId).concat(newId)),
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
  (
    cd "$ROOT"
    run_pnpm install --frozen-lockfile
    run_pnpm check
    openclaw plugins install --link --force .
    openclaw plugins enable "$NEW_PLUGIN_ID"
    openclaw plugins doctor
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
