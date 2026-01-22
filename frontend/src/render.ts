import * as THREE from "three";
import type { FruitState, SnakeState } from "./protocol";
import { cellNormal, cellToLocalPos, dirToForwardOnFace, faceOfCell } from "./geometry";

function hashColor(id: string): any {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.85, 0.42);
}

type FruitKind = FruitState["kind"];

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
      color: 0xdbe6ff,
      roughness: 0.2,
      metalness: 0.0,
      transparent: true,
      opacity: 0.12,
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
        sprite = new THREE.Sprite(this.fruitMaterials[f.kind]);
        sprite.renderOrder = 2;
        this.fruitGroup.add(sprite);
        this.fruitById.set(f.id, sprite);
      } else if (sprite.material !== this.fruitMaterials[f.kind]) {
        sprite.material = this.fruitMaterials[f.kind];
      }

      this.tmpPos.copy(cellToLocalPos(f.cell, n, this.halfSize));
      const normal = cellNormal(f.cell, n);
      this.tmpPos.add(normal.multiplyScalar(lift * 1.35));
      sprite.position.copy(this.tmpPos);

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
      if (me) this.setFollow(me.cells[0], me.dir);
    }
  }

  setFollow(headCell: number, dir: 0 | 1 | 2 | 3) {
    const n = this.cubeN;
    const face = faceOfCell(headCell, n);
    const localNormal = cellNormal(headCell, n).normalize();
    const localForward = dirToForwardOnFace(face, dir).normalize();

    const worldZ = new THREE.Vector3(0, 0, 1);
    const worldY = new THREE.Vector3(0, 1, 0);

    const q1 = new THREE.Quaternion().setFromUnitVectors(localNormal, worldZ);
    const f1 = localForward.clone().applyQuaternion(q1);
    const fproj = f1.sub(worldZ.clone().multiplyScalar(f1.dot(worldZ))).normalize();
    const dot = THREE.MathUtils.clamp(fproj.dot(worldY), -1, 1);
    const cross = new THREE.Vector3().crossVectors(fproj, worldY);
    const sign = Math.sign(worldZ.dot(cross)) || 1;
    const angle = Math.acos(dot) * sign;
    const q2 = new THREE.Quaternion().setFromAxisAngle(worldZ, angle);

    this.targetQuat.copy(q2.multiply(q1));
  }
}
