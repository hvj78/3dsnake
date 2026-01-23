from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import WebSocket

from app.game.sim import GameSettings, GameState, Snake, ensure_fruit_target, tick
from app.util.ids import new_player_id, new_room_id
from app.util.time import now_ms


@dataclass(slots=True)
class PlayerConn:
    player_id: str
    name: str
    ws: WebSocket
    ready: bool = False
    color: int = 0
    input_by_tick: dict[int, dict[str, int]] = field(default_factory=dict)
    last_ack_tick: int = -1


@dataclass(slots=True)
class RoomSettings:
    cube_n: int = 24
    round_seconds: int = 180
    tick_rate: int = 12


class Room:
    def __init__(self, room_id: str) -> None:
        self.room_id = room_id
        self.host_id: Optional[str] = None
        self.settings = RoomSettings()
        self.players: dict[str, PlayerConn] = {}
        self.phase: str = "lobby"
        self.game: Optional[GameState] = None
        self.lock = asyncio.Lock()
        self.task: Optional[asyncio.Task[None]] = None

    def lobby_state(self) -> dict:
        return {
            "roomId": self.room_id,
            "hostId": self.host_id,
            "players": [
                {"playerId": p.player_id, "name": p.name, "ready": p.ready, "color": p.color}
                for p in sorted(self.players.values(), key=lambda x: x.player_id)
            ],
            "settings": {
                "cubeN": self.settings.cube_n,
                "roundSeconds": self.settings.round_seconds,
                "tickRate": self.settings.tick_rate,
            },
        }

    async def broadcast(self, msg: dict) -> None:
        async with self.lock:
            conns = [(pid, p.ws) for pid, p in self.players.items()]

        stale: list[str] = []
        for pid, ws in conns:
            try:
                await ws.send_json(msg)
            except Exception:
                stale.append(pid)

        if not stale:
            return
        async with self.lock:
            for pid in stale:
                self.players.pop(pid, None)
                if self.host_id == pid:
                    self.host_id = next(iter(self.players.keys()), None)

    async def maybe_start(self, *, force: bool = False) -> None:
        start_msg = None
        async with self.lock:
            if self.phase != "lobby":
                return
            if self.task is not None:
                return
            if not self.players:
                return
            if force:
                starting_players = [pid for pid, p in self.players.items() if p.ready]
                if not starting_players:
                    return
            else:
                if not all(p.ready for p in self.players.values()):
                    return
                starting_players = list(self.players.keys())

            fruit_target = len(starting_players)
            seed = random.randrange(1 << 31)
            rng = random.Random(seed)

            # Give clients time for a 3-2-1-START countdown.
            start_time = now_ms() + 3500
            ends_at = start_time + self.settings.round_seconds * 1000
            settings = GameSettings(
                cube_n=self.settings.cube_n,
                round_seconds=self.settings.round_seconds,
                tick_rate=self.settings.tick_rate,
                fruit_target=fruit_target,
            )

            occupied: set[int] = set()
            snakes: dict[str, Snake] = {}
            from app.game.sim import _try_place_snake  # local import

            for pid in starting_players:
                placed = _try_place_snake(player_id=pid, n=settings.cube_n, rng=rng, occupied=occupied)
                if placed is None:
                    raise RuntimeError("failed to place all snakes; increase cube size")
                snakes[pid] = placed

            game = GameState(
                seed=seed,
                rng=rng,
                settings=settings,
                tick=0,
                start_server_time_ms=start_time,
                ends_at_ms=ends_at,
                snakes=snakes,
                fruits={},
            )
            ensure_fruit_target(game)
            self.game = game
            self.phase = "running"

            start_msg = {
                "v": 1,
                "type": "start",
                "payload": {
                    "settings": {
                        "cubeN": settings.cube_n,
                        "roundSeconds": settings.round_seconds,
                        "tickRate": settings.tick_rate,
                        "fruitTarget": settings.fruit_target,
                    },
                    "seed": seed,
                    "startTick": 0,
                    "startServerTimeMs": start_time,
                    "players": [
                        {"playerId": p.player_id, "name": p.name, "color": p.color}
                        for p in sorted(
                            (self.players[pid] for pid in starting_players),
                            key=lambda x: x.player_id,
                        )
                    ],
                },
            }

            self.task = asyncio.create_task(self._run_loop())

        if start_msg is not None:
            await self.broadcast(start_msg)

    async def _run_loop(self) -> None:
        assert self.game is not None
        g = self.game
        tick_interval = 1.0 / max(1, g.settings.tick_rate)

        while now_ms() < g.start_server_time_ms:
            await asyncio.sleep(0.005)

        next_tick_time = time.monotonic()
        while True:
            t0 = time.monotonic()
            if t0 < next_tick_time:
                await asyncio.sleep(next_tick_time - t0)
            next_tick_time += tick_interval

            msg_to_send = None
            async with self.lock:
                if self.phase != "running" or self.game is None:
                    return
                g = self.game

                now = now_ms()
                timer_left = g.ends_at_ms - now
                if timer_left <= 0:
                    self.phase = "ended"
                    final_scores = {pid: s.score for pid, s in g.snakes.items()}
                    msg_to_send = {"v": 1, "type": "end", "payload": {"finalScores": final_scores}}
                else:
                    inputs_for_tick: dict[str, dict[str, int]] = {}
                    for pid, p in self.players.items():
                        cmd = p.input_by_tick.pop(g.tick, {})
                        inputs_for_tick[pid] = cmd
                        p.last_ack_tick = g.tick

                    tick(state=g, inputs=inputs_for_tick, now_ms=now)

                    snakes_payload = []
                    for pid, s in g.snakes.items():
                        if s.alive:
                            snakes_payload.append(
                                {"playerId": pid, "alive": True, "dir": s.dir, "cells": list(s.cells)}
                            )
                        else:
                            respawn_in = None
                            if s.respawn_at_ms is not None:
                                respawn_in = max(0, s.respawn_at_ms - now)
                            snakes_payload.append(
                                {
                                    "playerId": pid,
                                    "alive": False,
                                    "dir": s.dir,
                                    "cells": [],
                                    "respawnInMs": respawn_in,
                                }
                            )

                    fruits_payload = [
                        {"id": f.id, "cell": f.cell, "kind": f.kind, "value": f.value}
                        for f in sorted(g.fruits.values(), key=lambda x: x.id)
                    ]

                    scores = {pid: s.score for pid, s in g.snakes.items()}
                    input_ack = {pid: p.last_ack_tick for pid, p in self.players.items()}

                    msg_to_send = {
                        "v": 1,
                        "type": "state",
                        "payload": {
                            "tick": g.tick,
                            "serverTimeMs": now,
                            "timerMsLeft": timer_left,
                            "snakes": snakes_payload,
                            "fruits": fruits_payload,
                            "scores": scores,
                            "inputAck": input_ack,
                        },
                    }

            if msg_to_send is not None:
                await self.broadcast(msg_to_send)
            if msg_to_send is not None and msg_to_send.get("type") == "end":
                # Return to lobby for a new round and allow joins again.
                async with self.lock:
                    self.phase = "lobby"
                    self.game = None
                    self.task = None
                    for p in self.players.values():
                        p.ready = False
                        p.input_by_tick.clear()
                        p.last_ack_tick = -1
                try:
                    await self.broadcast({"v": 1, "type": "lobby_state", "payload": {"lobby": self.lobby_state()}})
                except Exception:
                    pass
                return


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.lock = asyncio.Lock()

    @staticmethod
    def _palette() -> list[int]:
        # 8 distinct snake colors (0xRRGGBB), matching the frontend swatches.
        return [
            0xDB2777,  # magenta
            0xEF4444,  # red
            0xF97316,  # orange
            0xFACC15,  # yellow
            0x22C55E,  # green
            0x06B6D4,  # cyan
            0x3B82F6,  # blue
            0x8B5CF6,  # violet
        ]

    @classmethod
    def _first_free_color(cls, room: Room) -> int:
        taken = {p.color for p in room.players.values()}
        for c in cls._palette():
            if c not in taken:
                return c
        # If somehow all are taken (more than 8 players), fall back to first.
        return cls._palette()[0]

    async def join(self, *, room_id: Optional[str], name: str, ws: WebSocket) -> tuple[Room, PlayerConn, bool]:
        async with self.lock:
            rid = room_id or new_room_id()
            room = self.rooms.get(rid)
            if room is None:
                room = Room(rid)
                self.rooms[rid] = room

        async with room.lock:
            if room.phase != "lobby":
                raise RuntimeError("room_in_progress")
            if len(room.players) >= 8:
                raise RuntimeError("room_full")
            pid = new_player_id()
            color = self._first_free_color(room)
            player = PlayerConn(player_id=pid, name=name, ws=ws, color=color)
            room.players[pid] = player
            if room.host_id is None:
                room.host_id = pid
            is_host = room.host_id == pid
            return room, player, is_host

    async def leave(self, room: Room, player_id: str) -> None:
        async with room.lock:
            room.players.pop(player_id, None)
            if room.host_id == player_id:
                room.host_id = next(iter(room.players.keys()), None)
            if not room.players:
                if room.task:
                    room.task.cancel()
                async with self.lock:
                    self.rooms.pop(room.room_id, None)
