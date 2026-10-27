import * as THREE from 'three/webgpu';
import { TUNING } from './tuning';

/** Fixed-angle follow camera looking down at the player. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private readonly focus = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
  }

  snapTo(target: THREE.Vector3): void {
    this.focus.copy(target);
    this.apply();
  }

  update(dt: number, target: THREE.Vector3): void {
    const rate = TUNING.camera.followRate;
    this.focus.x = THREE.MathUtils.damp(this.focus.x, target.x, rate, dt);
    this.focus.z = THREE.MathUtils.damp(this.focus.z, target.z, rate, dt);
    this.apply();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private apply(): void {
    this.camera.position.copy(this.focus).add(TUNING.camera.offset);
    this.camera.lookAt(this.focus);
  }
}
