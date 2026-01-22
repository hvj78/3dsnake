import * as THREE from "three";
import type { CellId, Dir } from "./protocol";

type Face = 0 | 1 | 2 | 3 | 4 | 5;

type FaceBasis = {
  n: any; // THREE.Vector3
  r: any; // THREE.Vector3
  u: any; // THREE.Vector3
};

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const FACE_BASIS: Record<Face, FaceBasis> = {
  0: { n: X.clone(), r: Z.clone().negate(), u: Y.clone() }, // +X
  1: { n: X.clone().negate(), r: Z.clone(), u: Y.clone() }, // -X
  2: { n: Y.clone(), r: X.clone(), u: Z.clone().negate() }, // +Y
  3: { n: Y.clone().negate(), r: X.clone(), u: Z.clone() }, // -Y
  4: { n: Z.clone(), r: X.clone(), u: Y.clone() }, // +Z
  5: { n: Z.clone().negate(), r: X.clone().negate(), u: Y.clone() } // -Z
};

export function decodeCell(cell: CellId, n: number): { face: Face; u: number; v: number } {
  const face = Math.floor(cell / (n * n)) as Face;
  const rem = cell % (n * n);
  const v = Math.floor(rem / n);
  const u = rem % n;
  return { face, u, v };
}

export function cellToLocalPos(cell: CellId, n: number, halfSize = 1): any {
  const { face, u, v } = decodeCell(cell, n);
  const b = FACE_BASIS[face];

  const x = ((u + 0.5) / n) * 2 - 1; // [-1..1]
  const y = 1 - ((v + 0.5) / n) * 2; // +1 at top row

  return b.n
    .clone()
    .multiplyScalar(halfSize)
    .add(b.r.clone().multiplyScalar(x * halfSize))
    .add(b.u.clone().multiplyScalar(y * halfSize));
}

export function cellNormal(cell: CellId, n: number): any {
  const { face } = decodeCell(cell, n);
  return FACE_BASIS[face].n.clone();
}

export function dirToForwardOnFace(face: Face, dir: Dir): any {
  const b = FACE_BASIS[face];
  switch (dir) {
    case 0:
      return b.u.clone();
    case 1:
      return b.r.clone();
    case 2:
      return b.u.clone().negate();
    case 3:
      return b.r.clone().negate();
  }
}

export function faceOfCell(cell: CellId, n: number): Face {
  return decodeCell(cell, n).face;
}
