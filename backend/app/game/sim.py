from __future__ import annotations

import random
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import DefaultDict, Literal, Optional

from app.game.geometry import Dir, decode_cell, encode_cell, step_cell, turn
from app.util.ids import new_fruit_id

FruitKind = Literal["berry", "apple", "banana", "watermelon"]
FruitValue = Literal[2, 3, 5, 10]


@dataclass(slots=True)
class Fruit:
    id: str
    cell: int
    kind: FruitKind
    value: FruitValue


@dataclass(slots=True)
class Snake:
    player_id: str
    alive: bool
    dir: Dir
    cells: deque[int]
    pending_growth: int
    score: int
    respawn_at_ms: Optional[int] = None


@dataclass(slots=True)
class GameSettings:
    cube_n: int
    round_seconds: int
    tick_rate: int
    fruit_target: int


@dataclass(slots=True)
class GameState:
    seed: int
    rng: random.Random
    settings: GameSettings
    tick: int
    start_server_time_ms: int
    ends_at_ms: int
    snakes: dict[str, Snake]
    fruits: dict[str, Fruit]


FRUITS: list[tuple[FruitKind, FruitValue, int]] = [
    ("berry", 2, 5),
    ("apple", 3, 4),
    ("banana", 5, 2),
    ("watermelon", 10, 1),
]


def _occupied_cells(snakes: dict[str, Snake]) -> dict[int, list[tuple[str, int]]]:
    occ: dict[int, list[tuple[str, int]]] = defaultdict(list)
    for pid, s in snakes.items():
        if not s.alive:
            continue
        for idx, c in enumerate(s.cells):
            occ[c].append((pid, idx))
    return occ


def _is_forward_clear(head: int, direction: Dir, n: int, steps: int, occupied: set[int]) -> bool:
    cell = head
    dir_now = direction
    for _ in range(steps):
        cell, dir_now = step_cell(cell, dir_now, n)
        if cell in occupied:
            return False
    return True


def _try_place_snake(
    *,
    player_id: str,
    n: int,
    rng: random.Random,
    occupied: set[int],
    attempts: int = 2000,
) -> Optional[Snake]:
    for _ in range(attempts):
        face = rng.randrange(6)
        u = rng.randrange(n)
        v = rng.randrange(n)
        direction: Dir = rng.randrange(4)  # type: ignore[assignment]
        head = encode_cell(face, u, v, n)

        if head in occupied:
            continue
        if not _is_forward_clear(head, direction, n, 3, occupied):
            continue

        body = deque([head])
        dir_back: Dir = ((direction + 2) % 4)  # type: ignore[assignment]
        cell = head
        back_dir = dir_back
        ok = True
        for _i in range(3):
            cell, back_dir = step_cell(cell, back_dir, n)
            if cell in occupied:
                ok = False
                break
            body.append(cell)
        if not ok:
            continue

        for c in body:
            occupied.add(c)

        return Snake(
            player_id=player_id,
            alive=True,
            dir=direction,
            cells=body,
            pending_growth=0,
            score=0,
            respawn_at_ms=None,
        )
    return None


def _pick_fruit_kind(rng: random.Random, fruits_on_board: dict[str, Fruit]) -> tuple[FruitKind, FruitValue]:
    counts: DefaultDict[FruitKind, int] = defaultdict(int)
    for f in fruits_on_board.values():
        counts[f.kind] += 1

    weights: list[float] = []
    items: list[tuple[FruitKind, FruitValue]] = []
    for kind, value, base_w in FRUITS:
        w = base_w / (1 + counts[kind])
        weights.append(w)
        items.append((kind, value))

    choice = rng.choices(items, weights=weights, k=1)[0]
    return choice


def _spawn_fruit(
    *,
    n: int,
    rng: random.Random,
    occupied: set[int],
    fruits: dict[str, Fruit],
    attempts: int = 2000,
) -> Optional[Fruit]:
    for _ in range(attempts):
        face = rng.randrange(6)
        u = rng.randrange(n)
        v = rng.randrange(n)
        cell = encode_cell(face, u, v, n)
        if cell in occupied:
            continue

        kind, value = _pick_fruit_kind(rng, fruits)
        fid = new_fruit_id()
        fruit = Fruit(id=fid, cell=cell, kind=kind, value=value)
        fruits[fid] = fruit
        return fruit
    return None


def ensure_fruit_target(state: GameState) -> None:
    n = state.settings.cube_n
    occupied = set(_occupied_cells(state.snakes).keys())
    for f in state.fruits.values():
        occupied.add(f.cell)

    while len(state.fruits) < state.settings.fruit_target:
        fruit = _spawn_fruit(n=n, rng=state.rng, occupied=occupied, fruits=state.fruits)
        if fruit is None:
            break
        occupied.add(fruit.cell)


def tick(
    *,
    state: GameState,
    inputs: dict[str, dict[str, int]],
    now_ms: int,
) -> None:
    n = state.settings.cube_n

    for pid, s in state.snakes.items():
        if s.alive:
            continue
        if s.respawn_at_ms is None or now_ms < s.respawn_at_ms:
            continue

        occupied = set(_occupied_cells(state.snakes).keys())
        for f in state.fruits.values():
            occupied.add(f.cell)

        placed = _try_place_snake(player_id=pid, n=n, rng=state.rng, occupied=occupied, attempts=4000)
        if placed is not None:
            placed.score = s.score
            state.snakes[pid] = placed
        else:
            s.respawn_at_ms = now_ms + 250

    fruit_by_cell: dict[int, Fruit] = {f.cell: f for f in state.fruits.values()}

    planned: dict[str, tuple[int, Dir, int]] = {}
    for pid, s in state.snakes.items():
        if not s.alive:
            continue
        cmd = inputs.get(pid) or {}
        if "dir" in cmd:
            d = cmd.get("dir")
            if d in (0, 1, 2, 3):
                # Prevent instant 180° reversal (common snake rule) to avoid
                # "disappearing" due to immediate self-bite into the neck.
                if ((d + 2) % 4) != s.dir:
                    s.dir = d  # type: ignore[assignment]
        elif "turn" in cmd:
            t = cmd.get("turn", 0)
            if t in (-1, 0, 1):
                s.dir = turn(s.dir, t)

        head = s.cells[0]
        next_head, new_dir = step_cell(head, s.dir, n)
        s.dir = new_dir

        eat_value = 0
        fruit = fruit_by_cell.get(next_head)
        if fruit is not None:
            eat_value = int(fruit.value)
        planned[pid] = (next_head, s.dir, eat_value)

    new_cells_by_player: dict[str, deque[int]] = {}
    for pid, s in state.snakes.items():
        if not s.alive:
            continue
        next_head, _dir, eat_value = planned[pid]

        new_body = deque(s.cells)
        new_body.appendleft(next_head)

        if s.pending_growth > 0:
            s.pending_growth -= 1
        else:
            new_body.pop()

        if eat_value > 0:
            fruit = state.fruits.pop(fruit_by_cell[next_head].id, None)
            if fruit is not None:
                s.pending_growth += eat_value
                s.score += eat_value

        new_cells_by_player[pid] = new_body

    for pid, body in new_cells_by_player.items():
        state.snakes[pid].cells = body

    occ = _occupied_cells(state.snakes)
    head_cells: DefaultDict[int, list[str]] = defaultdict(list)
    for pid, s in state.snakes.items():
        if s.alive:
            head_cells[s.cells[0]].append(pid)

    dead: set[str] = set()
    for cell, heads in head_cells.items():
        if len(heads) >= 2:
            dead.update(heads)

    bites_by_victim: DefaultDict[str, DefaultDict[int, list[str]]] = defaultdict(lambda: defaultdict(list))
    for attacker_id, s in state.snakes.items():
        if not s.alive or attacker_id in dead:
            continue
        head = s.cells[0]
        for victim_id, seg_idx in occ.get(head, []):
            if seg_idx <= 0:
                continue
            bites_by_victim[victim_id][seg_idx].append(attacker_id)

    for victim_id, bites_at in bites_by_victim.items():
        victim = state.snakes.get(victim_id)
        if victim is None or not victim.alive or victim_id in dead:
            continue

        bite_points = sorted(bites_at.keys())
        cut_at = bite_points[0]
        old_len = len(victim.cells)
        victim.cells = deque(list(victim.cells)[:cut_at])

        for i, k in enumerate(bite_points):
            next_k = bite_points[i + 1] if i + 1 < len(bite_points) else old_len
            portion_len = max(0, next_k - k)
            attackers = sorted(bites_at[k])
            if not attackers or portion_len <= 0:
                continue

            share = portion_len // len(attackers)
            rem = portion_len % len(attackers)
            for a in attackers:
                state.snakes[a].score += share
            if rem:
                state.snakes[attackers[0]].score += rem

        if len(victim.cells) < 4:
            dead.add(victim_id)

    for pid in dead:
        s = state.snakes.get(pid)
        if s is None or not s.alive:
            continue
        s.alive = False
        s.cells = deque()
        s.pending_growth = 0
        s.respawn_at_ms = now_ms + 3000

    ensure_fruit_target(state)
    state.tick += 1
