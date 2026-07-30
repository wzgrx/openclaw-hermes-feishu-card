#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
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
  (
    cd "$ROOT"
    run_pnpm install --frozen-lockfile
    run_pnpm check
    openclaw plugins install --link --force .
    openclaw plugins enable openclaw-feishu-card-footer
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
  "$HERMES_PYTHON" -m hermes_feishu_card_footer.cli doctor
fi

if ((RESTART)); then
  if ((INSTALL_OPENCLAW)); then openclaw gateway restart; fi
  if ((INSTALL_HERMES)); then hermes gateway restart; fi
fi

echo "Install checks completed."
