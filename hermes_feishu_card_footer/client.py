from __future__ import annotations

import json
from typing import Any

from lark_oapi.api.cardkit.v1 import (
    Card,
    CreateCardRequest,
    CreateCardRequestBody,
    SettingsCardRequest,
    SettingsCardRequestBody,
    UpdateCardRequest,
    UpdateCardRequestBody,
)


class CardKitError(RuntimeError):
    pass


def _dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _check(response: Any, operation: str) -> Any:
    success = getattr(response, "success", None)
    if callable(success) and not success():
        code = getattr(response, "code", None)
        message = str(getattr(response, "msg", "") or "")
        raise CardKitError(f"{operation} failed (code={code}, message={message[:240]})")
    return response


class CardKitClient:
    def __init__(self, sdk_client: Any) -> None:
        self._client = sdk_client

    async def create(self, card: dict[str, Any]) -> str:
        request = (
            CreateCardRequest.builder()
            .request_body(CreateCardRequestBody.builder().type("card_json").data(_dumps(card)).build())
            .build()
        )
        response = _check(await self._client.cardkit.v1.card.acreate(request), "cardkit.create")
        card_id = getattr(getattr(response, "data", None), "card_id", None)
        if not card_id:
            raise CardKitError("cardkit.create response missing card_id")
        return str(card_id)

    async def update(self, card_id: str, card: dict[str, Any], sequence: int) -> None:
        card_value = Card.builder().type("card_json").data(_dumps(card)).build()
        body = UpdateCardRequestBody.builder().card(card_value).sequence(sequence).build()
        request = UpdateCardRequest.builder().card_id(card_id).request_body(body).build()
        _check(await self._client.cardkit.v1.card.aupdate(request), "cardkit.update")

    async def close_stream(self, card_id: str, sequence: int) -> None:
        body = SettingsCardRequestBody.builder().settings(_dumps({"streaming_mode": False})).sequence(sequence).build()
        request = SettingsCardRequest.builder().card_id(card_id).request_body(body).build()
        _check(await self._client.cardkit.v1.card.asettings(request), "cardkit.settings")
