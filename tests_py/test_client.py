from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from openclaw_hermes_feishu_card.client import CardKitClient, CardKitError


class FakeCardApi:
    def __init__(self) -> None:
        self.created: list[Any] = []
        self.updated: list[Any] = []
        self.settings: list[Any] = []

    async def acreate(self, request: object) -> object:
        self.created.append(request)
        return SimpleNamespace(success=lambda: True, data=SimpleNamespace(card_id="card-1"))

    async def aupdate(self, request: object) -> object:
        self.updated.append(request)
        return SimpleNamespace(success=lambda: True)

    async def asettings(self, request: object) -> object:
        self.settings.append(request)
        return SimpleNamespace(success=lambda: True)


@pytest.mark.asyncio
async def test_cardkit_client_uses_async_sdk_endpoints() -> None:
    api = FakeCardApi()
    sdk = SimpleNamespace(cardkit=SimpleNamespace(v1=SimpleNamespace(card=api)))
    client = CardKitClient(sdk)

    assert await client.create({"schema": "2.0"}) == "card-1"
    await client.update("card-1", {"schema": "2.0"}, 1)
    await client.close_stream("card-1", 2)

    assert len(api.created) == 1
    assert len(api.updated) == 1
    assert len(api.settings) == 1


@pytest.mark.asyncio
async def test_cardkit_client_surfaces_sdk_errors() -> None:
    class FailingApi(FakeCardApi):
        async def acreate(self, request: object) -> object:
            self.created.append(request)
            return SimpleNamespace(
                success=lambda: False,
                code=999,
                msg="fixture error",
            )

    api = FailingApi()
    sdk = SimpleNamespace(cardkit=SimpleNamespace(v1=SimpleNamespace(card=api)))
    with pytest.raises(CardKitError, match="999"):
        await CardKitClient(sdk).create({"schema": "2.0"})
