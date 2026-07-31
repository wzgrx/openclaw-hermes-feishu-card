from __future__ import annotations

import base64
import json
import re
from typing import Any

_MARKER_PREFIX = "\u2063HFC_TOOL:"
_MARKER_RE = re.compile(re.escape(_MARKER_PREFIX) + r"([A-Za-z0-9_-]+)")
_THINK_RE = re.compile(
    r"<\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>"
    r"(.*?)"
    r"<\s*/\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_THINK_TAG_RE = re.compile(
    r"<\s*/?\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>",
    re.IGNORECASE,
)


def encode_marker(payload: dict[str, object]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    token = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return _MARKER_PREFIX + token


def decode_markers(content: str) -> list[dict[str, Any]]:
    decoded: list[dict[str, Any]] = []
    for match in _MARKER_RE.finditer(content):
        token = match.group(1)
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
            value = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and value.get("name"):
            decoded.append(value)
    return decoded


def split_reasoning(content: str) -> tuple[str, str]:
    reasoning = "\n\n".join(part.strip() for part in _THINK_RE.findall(content) if part.strip())
    answer = _THINK_TAG_RE.sub("", _THINK_RE.sub("", content)).strip()
    return answer, reasoning
