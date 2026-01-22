from __future__ import annotations

from typing import Any, Literal, TypedDict

PROTOCOL_VERSION: Literal[1] = 1


class Envelope(TypedDict):
    v: int
    type: str
    payload: dict[str, Any]


def msg(msg_type: str, payload: dict[str, Any]) -> Envelope:
    return {"v": PROTOCOL_VERSION, "type": msg_type, "payload": payload}

