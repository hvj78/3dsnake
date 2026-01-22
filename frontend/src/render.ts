import * as THREE from "three";
import type { FruitState, SnakeState } from "./protocol";
import { cellNormal, cellToLocalPos, faceOfCell } from "./geometry";

function hashColor(id: string): any {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.85, 0.42);
}

type FruitKind = FruitState["kind"];

type Face = 0 | 1 | 2 | 3 | 4 | 5;
type FaceBasis = { n: any; r: any; u: any };

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

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function makeFruitTexture(kind: FruitKind): any {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas not available");

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;

  const circle = (x: number, y: number, rad: number, fill: string, stroke?: string, lw = 3) => {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  };

  const shadow = () => {
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.92, r * 0.88, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    ctx.fill();
  };

  shadow();

  if (kind === "berry") {
    circle(cx, cy, r * 0.98, "#6366f1", "#4338ca", 4);
    circle(cx - r * 0.28, cy - r * 0.30, r * 0.22, "rgba(255,255,255,0.55)");
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.10, cy - r * 1.05, r * 0.30, r * 0.16, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "#22c55e";
    ctx.fill();
  } else if (kind === "apple") {
    circle(cx, cy + r * 0.05, r * 1.02, "#ef4444", "#b91c1c", 4);
    ctx.beginPath();
    ctx.ellipse(cx, cy - r * 0.72, r * 0.40, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.40)";
    ctx.fill();
    ctx.beginPath();
    ctx.rect(cx - r * 0.07, cy - r * 1.25, r * 0.14, r * 0.48);
    ctx.fillStyle = "#6b4f2a";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.35, cy - r * 1.05, r * 0.34, r * 0.18, -0.3, 0, Math.PI * 2);
    ctx.fillStyle = "#16a34a";
    ctx.fill();
  } else if (kind === "banana") {
    ctx.lineCap = "round";
    ctx.lineWidth = r * 0.36;
    ctx.strokeStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.1, r * 0.9, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.lineWidth = r * 0.20;
    ctx.strokeStyle = "#fde68a";
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.12, r * 0.9, Math.PI * 1.18, Math.PI * 1.82);
    ctx.stroke();
    circle(cx - r * 0.95, cy + r * 0.05, r * 0.10, "#7c5a2a");
    circle(cx + r * 0.92, cy - r * 0.02, r * 0.10, "#7c5a2a");
  } else {
    circle(cx, cy, r * 1.04, "#10b981", "#047857", 4);
    ctx.lineWidth = r * 0.18;
    ctx.strokeStyle = "rgba(0,0,0,0.14)";
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * r * 0.22, cy, r * 0.98, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
    }
    circle(cx - r * 0.28, cy - r * 0.30, r * 0.20, "rgba(255,255,255,0.45)");
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeFruitMaterial(kind: FruitKind): any {
  const map = makeFruitTexture(kind);
  return new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: true });
}

export class Renderer {
  private renderer: any;
  private scene: any;
  private camera: any;
  private cubeGroup: any;

  private cubeN = 24;
  private halfSize = 1;

  private snakeMesh: any;
  private snakeCapacity = 50000;

  private fruitGroup: any;
  private fruitMaterials: Record<FruitKind, any>;
  private fruitById = new Map<string, any>();

  private gridLines: any | null = null;
  private cubeTint = new THREE.Color(0xdbe6ff);
  private cubeOpacity = 0.12;
  private tmpColor = new THREE.Color();
  private followFace: Face | null = null;

  private tmpMat = new THREE.Matrix4();
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpScale = new THREE.Vector3();

  private targetQuat = new THREE.Quaternion();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
    this.camera.position.set(0, 0, 3.2);
    this.camera.lookAt(0, 0, 0);

    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.55);
    dir.position.set(2, 3, 4);
    this.scene.add(dir);

    const cubeGeo = new THREE.BoxGeometry(this.halfSize * 2, this.halfSize * 2, this.halfSize * 2);
    const cubeMat = new THREE.MeshStandardMaterial({
      color: this.cubeTint,
      roughness: 0.2,
      metalness: 0.0,
      transparent: true,
      opacity: this.cubeOpacity,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const cube = new THREE.Mesh(cubeGeo, cubeMat);
    cube.renderOrder = 0;
    this.cubeGroup.add(cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cubeGeo),
      new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.55 })
    );
    this.cubeGroup.add(edges);

    this.rebuildGrid();

    const segGeo = new THREE.BoxGeometry(1, 1, 1);
    const segMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1.0 });
    this.snakeMesh = new THREE.InstancedMesh(segGeo, segMat, this.snakeCapacity);
    this.snakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.snakeMesh.count = 0;
    this.snakeMesh.renderOrder = 1;
    this.cubeGroup.add(this.snakeMesh);

    this.fruitMaterials = {
      berry: makeFruitMaterial("berry"),
      apple: makeFruitMaterial("apple"),
      banana: makeFruitMaterial("banana"),
      watermelon: makeFruitMaterial("watermelon")
    };
    this.fruitGroup = new THREE.Group();
    this.fruitGroup.renderOrder = 2;
    this.cubeGroup.add(this.fruitGroup);

    window.addEventListener("resize", () => this.resize(container));
    this.resize(container);

    const loop = () => {
      requestAnimationFrame(loop);
      this.cubeGroup.quaternion.slerp(this.targetQuat, 0.12);
      this.updateFruitVisuals();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = Math.max(1e-6, w / Math.max(1, h));
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setCubeN(n: number) {
    this.cubeN = n;
    this.snakeMesh.count = 0;
    this.snakeMesh.instanceMatrix.needsUpdate = true;
    for (const sprite of this.fruitById.values()) this.fruitGroup.remove(sprite);
    this.fruitById.clear();
    this.rebuildGrid();
  }

  private rebuildGrid() {
    if (this.gridLines) {
      this.cubeGroup.remove(this.gridLines);
      try {
        this.gridLines.geometry?.dispose?.();
        this.gridLines.material?.dispose?.();
      } catch {
        // ignore
      }
      this.gridLines = null;
    }

    const n = this.cubeN;
    if (n <= 1) return;

    const half = this.halfSize;
    const eps = half * 0.002;

    const positions: number[] = [];
    const push = (v: any) => {
      positions.push(v.x, v.y, v.z);
    };

    const min = -half;
    const max = half;

    for (let face = 0 as Face; face < 6; face = (face + 1) as Face) {
      const b = FACE_BASIS[face];
      const origin = b.n.clone().multiplyScalar(half + eps);

      for (let i = 1; i < n; i++) {
        const t = min + (2 * half * i) / n;

        // vertical line: x = t, y in [min..max]
        push(origin.clone().add(b.r.clone().multiplyScalar(t)).add(b.u.clone().multiplyScalar(min)));
        push(origin.clone().add(b.r.clone().multiplyScalar(t)).add(b.u.clone().multiplyScalar(max)));

        // horizontal line: y = t, x in [min..max]
        push(origin.clone().add(b.r.clone().multiplyScalar(min)).add(b.u.clone().multiplyScalar(t)));
        push(origin.clone().add(b.r.clone().multiplyScalar(max)).add(b.u.clone().multiplyScalar(t)));
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const camDist = this.camera.position.length ? this.camera.position.length() : 3.2;
    const uNear = Math.max(0.1, camDist - half * 1.2);
    const uFar = camDist + half * 2.4;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uNear: { value: uNear },
        uFar: { value: uFar },
        uColorNear: { value: new THREE.Color(0x475569) },
        uColorFar: { value: new THREE.Color(0xcbd5e1) },
        uAlphaNear: { value: 0.55 },
        uAlphaFar: { value: 0.18 }
      },
      vertexShader: `
        varying float vDist;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uNear;
        uniform float uFar;
        uniform vec3 uColorNear;
        uniform vec3 uColorFar;
        uniform float uAlphaNear;
        uniform float uAlphaFar;
        varying float vDist;
        void main() {
          float t = clamp((vDist - uNear) / max(0.0001, (uFar - uNear)), 0.0, 1.0);
          t = t * t * (3.0 - 2.0 * t); // smoothstep
          vec3 col = mix(uColorNear, uColorFar, t);
          float a = mix(uAlphaNear, uAlphaFar, t);
          gl_FragColor = vec4(col, a);
        }
      `
    });

    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 0.9;
    this.gridLines = lines;
    this.cubeGroup.add(lines);
  }

  private updateFruitVisuals() {
    if (!this.fruitById.size) return;

    const cam = this.camera;
    const camPos = cam.position;

    const camDist = camPos.length ? camPos.length() : 3.2;
    const uNear = Math.max(0.1, camDist - this.halfSize * 1.2);
    const uFar = camDist + this.halfSize * 2.8;

    const q = this.cubeGroup.quaternion;
    const tmpWorld = new THREE.Vector3();
    const tmpNormal = new THREE.Vector3();
    const tmpToCam = new THREE.Vector3();

    for (const sprite of this.fruitById.values()) {
      const mat = sprite.material;
      if (!mat) continue;

      sprite.getWorldPosition(tmpWorld);
      const dist = camPos.distanceTo(tmpWorld);
      const tDist = smoothstep(uNear, uFar, dist);

      const nLocal = sprite.userData?.normalLocal;
      if (nLocal) {
        tmpNormal.copy(nLocal).applyQuaternion(q).normalize();
        tmpToCam.copy(camPos).sub(tmpWorld).normalize();
        const facing = tmpNormal.dot(tmpToCam); // >0 means face is towards camera
        const through = smoothstep(0.25, -0.25, facing); // 0 front, 1 back

        const alphaDist = 0.95 * (1 - 0.25 * tDist); // 0.95..~0.71
        const alphaThrough = 1 - through * (0.55 + this.cubeOpacity * 0.5);
        mat.opacity = clamp01(alphaDist * alphaThrough);

        const tintMix = clamp01(through * 0.8 + tDist * 0.25);
        if (mat.color) mat.color.copy(this.tmpColor.set(0xffffff)).lerp(this.cubeTint, tintMix);
      } else {
        mat.opacity = 0.9;
        if (mat.color) mat.color.set(0xffffff);
      }
    }
  }

  update(snakes: SnakeState[], fruits: FruitState[], myPlayerId: string | null) {
    const n = this.cubeN;
    const cellW = (this.halfSize * 2) / this.cubeN;
    const segScale = cellW * 0.88;
    const lift = cellW * 0.18;

    let i = 0;
    for (const s of snakes) {
      if (!s.alive) continue;
      const color = hashColor(s.playerId);
      for (let idx = 0; idx < s.cells.length; idx++) {
        if (i >= this.snakeCapacity) break;
        const cell = s.cells[idx];
        this.tmpPos.copy(cellToLocalPos(cell, n, this.halfSize));
        const normal = cellNormal(cell, n);
        this.tmpPos.add(normal.multiplyScalar(lift));
        this.tmpQuat.identity();
        this.tmpScale.set(segScale, segScale, segScale);
        this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.snakeMesh.setMatrixAt(i, this.tmpMat);
        this.snakeMesh.setColorAt(i, idx === 0 ? color.clone().offsetHSL(0, 0, -0.12) : color);
        i++;
      }
    }
    this.snakeMesh.count = i;
    this.snakeMesh.instanceMatrix.needsUpdate = true;
    if (this.snakeMesh.instanceColor) this.snakeMesh.instanceColor.needsUpdate = true;

    const keep = new Set<string>();
    for (const f of fruits) {
      keep.add(f.id);
      let sprite = this.fruitById.get(f.id);
      if (!sprite) {
        sprite = new THREE.Sprite(this.fruitMaterials[f.kind].clone());
        sprite.renderOrder = 2;
        this.fruitGroup.add(sprite);
        this.fruitById.set(f.id, sprite);
        sprite.userData.kind = f.kind;
      } else if (sprite.userData.kind !== f.kind) {
        sprite.material.map = this.fruitMaterials[f.kind].map;
        sprite.userData.kind = f.kind;
      }

      this.tmpPos.copy(cellToLocalPos(f.cell, n, this.halfSize));
      const normal = cellNormal(f.cell, n);
      this.tmpPos.add(normal.multiplyScalar(lift * 1.35));
      sprite.position.copy(this.tmpPos);
      sprite.userData.normalLocal = normal.clone().normalize();

      const base = cellW * 0.92; // ~1 grid cell
      const s = base + cellW * (f.value / 40); // small size variance by value
      sprite.scale.set(s, s, 1);
    }
    for (const [id, sprite] of this.fruitById.entries()) {
      if (keep.has(id)) continue;
      this.fruitGroup.remove(sprite);
      this.fruitById.delete(id);
    }

    if (myPlayerId) {
      const me = snakes.find((s) => s.playerId === myPlayerId && s.alive && s.cells.length > 0);
      if (me) {
        const face = faceOfCell(me.cells[0], n) as Face;
        if (this.followFace !== face) {
          this.followFace = face;
          this.setFollowFace(face);
        }
      }
    }
  }

  private setFollowFace(face: Face) {
    // Canonical face orientation:
    // - face normal -> viewer (world +Z)
    // - face "east"  -> screen right (world +X)
    // This avoids a free "roll" degree of freedom that can cause annoying 180° flips
    // when transitioning between faces.
    const b = FACE_BASIS[face];
    const localNormal = b.n.clone().normalize();
    const localRight = b.r.clone().normalize();

    const worldZ = new THREE.Vector3(0, 0, 1);
    const worldX = new THREE.Vector3(1, 0, 0);

    const q1 = new THREE.Quaternion().setFromUnitVectors(localNormal, worldZ);

    const r1 = localRight.clone().applyQuaternion(q1);
    // Project to XY plane (should already be close, but keep it robust).
    r1.z = 0;
    if (r1.lengthSq() < 1e-8) {
      // Fallback: use local "up" if right is numerically unstable.
      r1.copy(b.u).applyQuaternion(q1);
      r1.z = 0;
    }
    r1.normalize();

    const dot = THREE.MathUtils.clamp(r1.dot(worldX), -1, 1);
    const crossZ = new THREE.Vector3().crossVectors(r1, worldX).dot(worldZ);
    const angle = Math.atan2(crossZ, dot);
    const q2 = new THREE.Quaternion().setFromAxisAngle(worldZ, angle);

    this.targetQuat.copy(q2.multiply(q1));
  }
}
