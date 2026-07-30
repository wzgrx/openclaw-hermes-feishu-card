from __future__ import annotations

from typing import Any

__all__ = ["register"]
__version__ = "1.0.0"


def register(ctx: Any) -> None:
    """Load the Hermes host integration only when Hermes calls the entry point."""
    from .plugin import register as register_plugin

    register_plugin(ctx)
