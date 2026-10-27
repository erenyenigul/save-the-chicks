import * as THREE from 'three/webgpu';

/**
 * Breadcrumb path left by the player. Followers sample it by distance
 * behind the head, so the line of chicks retraces the player's steps
 * around obstacles instead of cutting corners.
 */
export class Trail {
  /** Newest point first. */
  private readonly points: THREE.Vector3[] = [];

  constructor(
    private readonly maxLength: number,
    private readonly resolution = 0.1,
  ) {}

  reset(head: THREE.Vector3): void {
    this.points.length = 0;
    this.points.push(head.clone());
  }

  record(head: THREE.Vector3): void {
    const newest = this.points[0];
    if (newest && Math.hypot(head.x - newest.x, head.z - newest.z) < this.resolution) return;
    this.points.unshift(new THREE.Vector3(head.x, 0, head.z));
    this.trim();
  }

  /** Point `distance` behind `head` along the recorded path. */
  sample(head: THREE.Vector3, distance: number, out: THREE.Vector3): THREE.Vector3 {
    let previous = head;
    let remaining = distance;
    for (const point of this.points) {
      const segment = Math.hypot(point.x - previous.x, point.z - previous.z);
      if (segment >= remaining && segment > 0) {
        const t = remaining / segment;
        return out.set(
          previous.x + (point.x - previous.x) * t,
          0,
          previous.z + (point.z - previous.z) * t,
        );
      }
      remaining -= segment;
      previous = point;
    }
    return out.set(previous.x, 0, previous.z);
  }

  private trim(): void {
    let length = 0;
    for (let i = 1; i < this.points.length; i++) {
      length += this.points[i].distanceTo(this.points[i - 1]);
      if (length > this.maxLength) {
        this.points.length = i + 1;
        return;
      }
    }
  }
}
