import * as THREE from 'three/webgpu';
import type { Cell } from '../world/Grid';

const COLOR = 0x4fe07a;
const PULSE_SPEED = 4;
const FADE_RATE = 6;
/** Peak opacity of the floor fill; the outline pipeline draws the border on top. */
const MAX_OPACITY = 0.45;

/**
 * Pulsing green fill on the exit tiles while the player has chicks to bring out,
 * so the way home stands out. Fades in and out rather than snapping.
 */
export class ExitGlow {
  readonly root = new THREE.Group();
  private readonly geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly material = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  private strength = 0;
  private time = 0;

  constructor(exits: readonly Cell[]) {
    for (const cell of exits) {
      const tile = new THREE.Mesh(this.geometry, this.material);
      // Just under the arrow markings, so the arrows stay on top.
      tile.position.set(cell.col, 0.005, cell.row);
      this.root.add(tile);
    }
    this.root.visible = false;
  }

  update(dt: number, active: boolean): void {
    this.time += dt;
    this.strength = THREE.MathUtils.damp(this.strength, active ? 1 : 0, FADE_RATE, dt);
    const pulse = 0.6 + 0.4 * Math.sin(this.time * PULSE_SPEED);
    this.material.opacity = MAX_OPACITY * this.strength * pulse;
    this.root.visible = this.strength > 0.01;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.root.removeFromParent();
  }
}
