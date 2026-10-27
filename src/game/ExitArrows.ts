import * as THREE from 'three/webgpu';
import type { Cell, Grid } from '../world/Grid';
import { outwardDirection } from '../world/LevelLayout';

const ACTIVE_COLOR = new THREE.Color(0x4fe07a);
const FADE_RATE = 6;
/** Hops per second; each arrow hops a beat after the one before it, so the row ripples. */
const HOP_RATE = 1.6;
const HOP_STAGGER = 0.12;
/** How far an arrow leaps out of the door and up, in tiles. */
const HOP_REACH = 0.3;
const HOP_HEIGHT = 0.18;

interface Arrow {
  object: THREE.Object3D;
  rest: THREE.Vector3;
  outward: THREE.Vector3;
}

/**
 * The exit floor arrows come alive while the player has chicks to bring out:
 * they turn green and hop out of the door one after another, pointing the way.
 */
export class ExitArrows {
  private readonly arrows: Arrow[];
  /** The markers' materials, cloned so tinting them leaves the shared model untouched. */
  private readonly tints: { material: THREE.MeshStandardMaterial; base: THREE.Color }[] = [];
  private strength = 0;
  private time = 0;

  constructor(markers: readonly THREE.Object3D[], exits: readonly Cell[], grid: Grid) {
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    this.arrows = markers.map((object, i) => {
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const original = mesh.material as THREE.MeshStandardMaterial;
        let clone = clones.get(original);
        if (!clone) {
          clone = original.clone();
          clones.set(original, clone);
          this.tints.push({ material: clone, base: clone.color.clone() });
        }
        mesh.material = clone;
      });
      const out = outwardDirection(exits[i], grid);
      return { object, rest: object.position.clone(), outward: new THREE.Vector3(out.col, 0, out.row) };
    });
  }

  update(dt: number, active: boolean): void {
    this.time += dt;
    this.strength = THREE.MathUtils.damp(this.strength, active ? 1 : 0, FADE_RATE, dt);
    for (const tint of this.tints) tint.material.color.lerpColors(tint.base, ACTIVE_COLOR, this.strength);

    this.arrows.forEach((arrow, i) => {
      // Each beat: a hop out and back over the first half, then a rest.
      const beat = THREE.MathUtils.euclideanModulo(this.time * HOP_RATE - i * HOP_STAGGER, 1);
      const hop = (beat < 0.5 ? Math.sin(beat * 2 * Math.PI) : 0) * this.strength;
      arrow.object.position
        .copy(arrow.rest)
        .addScaledVector(arrow.outward, hop * HOP_REACH)
        .setY(arrow.rest.y + hop * HOP_HEIGHT);
    });
  }

  dispose(): void {
    for (const { material } of this.tints) material.dispose();
  }
}
