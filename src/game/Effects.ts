import * as THREE from 'three/webgpu';

const PUFF_COUNT = 6;
const PUFF_LIFE = 0.45;
/** Spread of the puff fan behind the player, in radians. */
const PUFF_SPREAD = Math.PI * 0.8;

interface Puff {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  size: number;
  age: number;
}

/**
 * Cartoon effects in the game's low-poly style: chunky flat-shaded puffs that
 * pop out and shrink away, rather than soft, realistic particles.
 */
export class Effects {
  readonly root = new THREE.Group();
  private readonly geometry = new THREE.IcosahedronGeometry(0.5, 0);
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xfbf5e8, roughness: 1, flatShading: true });
  private readonly puffs: Puff[] = [];

  /** A fan of puffs kicked out behind a dash. */
  dash(position: THREE.Vector3, direction: THREE.Vector3): void {
    const back = Math.atan2(-direction.x, -direction.z);
    for (let i = 0; i < PUFF_COUNT; i++) {
      const angle = back + (i / (PUFF_COUNT - 1) - 0.5) * PUFF_SPREAD;
      const outward = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.position.copy(position).addScaledVector(outward, 0.25).setY(0.2);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.puffs.push({
        mesh,
        velocity: outward.multiplyScalar(1.6 + Math.random()).setY(0.6),
        size: 0.35 + Math.random() * 0.2,
        age: 0,
      });
    }
  }

  update(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i];
      puff.age += dt;
      const t = puff.age / PUFF_LIFE;
      if (t >= 1) {
        puff.mesh.removeFromParent();
        this.puffs.splice(i, 1);
        continue;
      }
      // Pop up fast with a little overshoot, then shrink away.
      const scale = t < 0.25 ? Math.sin((t / 0.25) * Math.PI * 0.6) * 1.15 : 1 - (t - 0.25) / 0.75;
      puff.mesh.scale.setScalar(puff.size * Math.max(scale, 0));
      puff.mesh.position.addScaledVector(puff.velocity, dt * (1 - t));
      puff.mesh.rotation.y += dt * 4;
    }
  }

  dispose(): void {
    for (const puff of this.puffs) puff.mesh.removeFromParent();
    this.puffs.length = 0;
    this.geometry.dispose();
    this.material.dispose();
    this.root.removeFromParent();
  }
}
