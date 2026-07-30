"""Hermes directory-plugin shim for the hybrid repository."""

if __package__:
    from .hermes_feishu_card_footer import register
else:
    from hermes_feishu_card_footer import register

__all__ = ["register"]
