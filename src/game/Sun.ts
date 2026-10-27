import * as THREE from 'three/webgpu';

/** Half-size of the area around the player that receives shadows, in tiles. */
const SHADOW_EXTENT = 18;
const SHADOW_MAP_SIZE = 2048;
const OFFSET = new THREE.Vector3(-8, 18, 10);

/**
 * Directional light whose shadow camera follows the player. Covering only the
 * visible area keeps shadow texels small (crisp edges); snapping the centre to
 * whole texels stops the edges from shimmering as the player moves.
 */
export class Sun {
  readonly light = new THREE.DirectionalLight(0xfff1dd, 2.1);
  private readonly texel = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
  private readonly center = new THREE.Vector3();

  constructor(focus: THREE.Vector3) {
    const { shadow } = this.light;
    this.light.castShadow = true;
    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    shadow.bias = -0.0004;
    shadow.normalBias = 0.02;
    Object.assign(shadow.camera, {
      left: -SHADOW_EXTENT,
      right: SHADOW_EXTENT,
      top: SHADOW_EXTENT,
      bottom: -SHADOW_EXTENT,
      near: 1,
      far: 60,
    });
    shadow.camera.updateProjectionMatrix();
    this.follow(focus);
  }

  /** Objects to add to the scene. */
  get objects(): THREE.Object3D[] {
    return [this.light, this.light.target];
  }

  follow(focus: THREE.Vector3): void {
    this.center.set(
      Math.round(focus.x / this.texel) * this.texel,
      0,
      Math.round(focus.z / this.texel) * this.texel,
    );
    this.light.target.position.copy(this.center);
    this.light.position.copy(this.center).add(OFFSET);
  }

  dispose(): void {
    this.light.dispose();
  }
}
