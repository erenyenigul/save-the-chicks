import * as THREE from 'three/webgpu';
import type { Grid } from '../world/Grid';

const RAY_COUNT = 40;
const FLOOR_OFFSET = 0.03;

const CALM = new THREE.Color(0xfff3a0);
const ALARMED = new THREE.Color(0xff3b4e);

/**
 * Floor decal showing what a guard can see. The fan is ray-marched against
 * the tile grid every frame so it is clipped by walls and tall props.
 */
export class VisionCone {
  readonly mesh: THREE.Mesh;
  private readonly positions: THREE.BufferAttribute;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(
    private readonly range: number,
    private readonly fieldOfView: number,
  ) {
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array((RAY_COUNT + 2) * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);

    const indices: number[] = [];
    for (let i = 1; i <= RAY_COUNT; i++) indices.push(0, i + 1, i);
    geometry.setIndex(indices);

    this.material = new THREE.MeshBasicMaterial({
      color: CALM,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** `alertness` in [0, 1] blends the colour from calm to alarmed. */
  update(origin: THREE.Vector3, yaw: number, grid: Grid, alertness: number): void {
    const array = this.positions.array as Float32Array;
    array[0] = origin.x;
    array[1] = FLOOR_OFFSET;
    array[2] = origin.z;

    for (let i = 0; i <= RAY_COUNT; i++) {
      const angle = yaw - this.fieldOfView / 2 + (this.fieldOfView * i) / RAY_COUNT;
      const dirX = Math.sin(angle);
      const dirZ = Math.cos(angle);
      const distance = grid.raycast(origin, dirX, dirZ, this.range);
      const offset = (i + 1) * 3;
      array[offset] = origin.x + dirX * distance;
      array[offset + 1] = FLOOR_OFFSET;
      array[offset + 2] = origin.z + dirZ * distance;
    }
    this.positions.needsUpdate = true;

    this.material.color.lerpColors(CALM, ALARMED, alertness);
    this.material.opacity = 0.22 + alertness * 0.2;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
