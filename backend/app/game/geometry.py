from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Tuple

Face = Literal[0, 1, 2, 3, 4, 5]
Dir = Literal[0, 1, 2, 3]  # North, East, South, West


@dataclass(frozen=True, slots=True)
class Vec3:
    x: int
    y: int
    z: int

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def scale(self, k: int) -> "Vec3":
        return Vec3(self.x * k, self.y * k, self.z * k)


X = Vec3(1, 0, 0)
Y = Vec3(0, 1, 0)
Z = Vec3(0, 0, 1)


def dot(a: Vec3, b: Vec3) -> int:
    return a.x * b.x + a.y * b.y + a.z * b.z


def neg(v: Vec3) -> Vec3:
    return Vec3(-v.x, -v.y, -v.z)


@dataclass(frozen=True, slots=True)
class FaceBasis:
    n: Vec3
    r: Vec3
    u: Vec3


FACE_BASIS: dict[Face, FaceBasis] = {
    0: FaceBasis(n=X, r=neg(Z), u=Y),  # +X
    1: FaceBasis(n=neg(X), r=Z, u=Y),  # -X
    2: FaceBasis(n=Y, r=X, u=neg(Z)),  # +Y
    3: FaceBasis(n=neg(Y), r=X, u=Z),  # -Y
    4: FaceBasis(n=Z, r=X, u=Y),  # +Z
    5: FaceBasis(n=neg(Z), r=neg(X), u=Y),  # -Z
}


def encode_cell(face: Face, u: int, v: int, n: int) -> int:
    return face * (n * n) + v * n + u


def decode_cell(cell: int, n: int) -> Tuple[Face, int, int]:
    face: Face = (cell // (n * n))  # type: ignore[assignment]
    rem = cell % (n * n)
    v = rem // n
    u = rem % n
    return face, u, v


def _dir_vec(basis: FaceBasis, direction: Dir) -> Vec3:
    if direction == 0:
        return basis.u
    if direction == 1:
        return basis.r
    if direction == 2:
        return neg(basis.u)
    return neg(basis.r)


def _dir_from_vec(basis: FaceBasis, v: Vec3) -> Dir:
    if v == basis.u:
        return 0
    if v == basis.r:
        return 1
    if v == neg(basis.u):
        return 2
    if v == neg(basis.r):
        return 3
    raise ValueError("vector is not a valid face direction")


def turn(direction: Dir, turn_value: int) -> Dir:
    if turn_value not in (-1, 0, 1):
        raise ValueError("turn must be -1, 0, or 1")
    return ((direction + turn_value) % 4)  # type: ignore[return-value]


def step_cell(cell: int, direction: Dir, n: int) -> tuple[int, Dir]:
    face, u, v = decode_cell(cell, n)
    basis = FACE_BASIS[face]

    x_num = 2 * u + 1 - n
    y_num = n - (2 * v + 1)
    pos = basis.n.scale(n) + basis.r.scale(x_num) + basis.u.scale(y_num)

    move = _dir_vec(basis, direction).scale(2)
    pos2 = pos + move

    ax, ay, az = abs(pos2.x), abs(pos2.y), abs(pos2.z)
    if ax >= ay and ax >= az:
        max_abs = ax
        new_n = X if pos2.x >= 0 else neg(X)
    elif ay >= ax and ay >= az:
        max_abs = ay
        new_n = Y if pos2.y >= 0 else neg(Y)
    else:
        max_abs = az
        new_n = Z if pos2.z >= 0 else neg(Z)

    if new_n == X:
        new_face: Face = 0
    elif new_n == neg(X):
        new_face = 1
    elif new_n == Y:
        new_face = 2
    elif new_n == neg(Y):
        new_face = 3
    elif new_n == Z:
        new_face = 4
    else:
        new_face = 5

    new_basis = FACE_BASIS[new_face]
    dot_r = dot(pos2, new_basis.r)
    dot_u = dot(pos2, new_basis.u)

    new_u = ((dot_r + max_abs) * n) // (2 * max_abs)
    new_v = ((max_abs - dot_u) * n) // (2 * max_abs)

    if new_u < 0:
        new_u = 0
    elif new_u >= n:
        new_u = n - 1
    if new_v < 0:
        new_v = 0
    elif new_v >= n:
        new_v = n - 1

    new_cell = encode_cell(new_face, new_u, new_v, n)

    if new_face == face:
        return new_cell, direction

    transported = neg(basis.n)
    new_dir = _dir_from_vec(new_basis, transported)
    return new_cell, new_dir

