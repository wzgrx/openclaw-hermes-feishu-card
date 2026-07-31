# Contributing

1. Create a focused branch.
2. Run `pnpm check`.
3. Run `ruff check .`, `mypy openclaw_hermes_feishu_card`, and `pytest`.
4. Keep transport logic in the upstream OpenClaw/Hermes adapters and presentation logic in this repository.
5. Add a test for each behavior change.
