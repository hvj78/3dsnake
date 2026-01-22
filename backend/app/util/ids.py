from __future__ import annotations

import secrets
import uuid


def new_player_id() -> str:
    return str(uuid.uuid4())


def new_room_id() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


def new_fruit_id() -> str:
    return secrets.token_hex(8)

