from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .config import HermesCardConfig
from .ledger import UsageLedger


def _doctor() -> int:
    checks = {
        "python": sys.version.split()[0],
        "hermes": bool(importlib.util.find_spec("gateway")),
        "lark_oapi": bool(importlib.util.find_spec("lark_oapi")),
        "feishu_app_id": bool(os.getenv("FEISHU_APP_ID")),
        "feishu_app_secret": bool(os.getenv("FEISHU_APP_SECRET")),
    }
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    return 0 if checks["hermes"] and checks["lark_oapi"] else 1


def _totals(path: str, timezone: str) -> int:
    ledger = UsageLedger(Path(path).expanduser().resolve(), timezone)
    print(json.dumps(asdict(ledger.totals()), ensure_ascii=False, indent=2))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes Feishu Card Footer utilities")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor", help="Check the Hermes and Feishu runtime")
    totals = subparsers.add_parser("totals", help="Show shared usage totals")
    default = HermesCardConfig()
    totals.add_argument("--storage-dir", default=str(default.storage_dir))
    totals.add_argument("--timezone", default=default.timezone)
    args = parser.parse_args()
    code = _doctor() if args.command == "doctor" else _totals(args.storage_dir, args.timezone)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
