from __future__ import annotations

from hermes_feishu_card_footer.markers import decode_markers, encode_marker, split_reasoning


def test_marker_round_trip() -> None:
    marker = encode_marker({"name": "web_search", "index": 2, "preview": "hello"})
    assert "web_search" not in marker
    values = decode_markers(marker)
    assert values == [{"name": "web_search", "index": 2, "preview": "hello"}]


def test_reasoning_is_split_from_visible_answer() -> None:
    answer, reasoning = split_reasoning("<REASONING_SCRATCHPAD>hidden plan</REASONING_SCRATCHPAD>\nVisible answer")
    assert answer == "Visible answer"
    assert reasoning == "hidden plan"
