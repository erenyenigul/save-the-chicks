import * as THREE from 'three/webgpu';

/** Frame-rate independent damping of an angle along the shortest arc. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * dt));
}

/** Yaw that makes a +Z-facing model look along (dx, dz). */
export function yawFromDirection(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Moves `from` towards `to` on the XZ plane by at most `maxStep`. Returns the remaining distance. */
export function stepTowards(from: THREE.Vector3, to: THREE.Vector3, maxStep: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxStep || distance === 0) {
    from.x = to.x;
    from.z = to.z;
    return 0;
  }
  from.x += (dx / distance) * maxStep;
  from.z += (dz / distance) * maxStep;
  return distance - maxStep;
}

export function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
