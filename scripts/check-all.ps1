$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $root
try {
  pnpm check
  & .\.venv\Scripts\python -m ruff check .
  & .\.venv\Scripts\python -m ruff format --check .
  & .\.venv\Scripts\python -m mypy hermes_feishu_card_footer
  & .\.venv\Scripts\python -m pytest
  & .\.venv\Scripts\python -m build --outdir build/python
  pnpm run doctor
} finally {
  Pop-Location
}
