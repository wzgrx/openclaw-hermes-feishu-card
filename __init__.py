"""Hermes directory-plugin shim for the hybrid repository."""

if __package__:
    from .openclaw_hermes_feishu_card import register
else:
    from openclaw_hermes_feishu_card import register

__all__ = ["register"]
