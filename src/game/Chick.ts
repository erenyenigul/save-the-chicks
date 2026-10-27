import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import { Animator } from '../core/Animator';
import { dampAngle, yawFromDirection } from '../core/math';
import type { BeltLine, BeltPath, BeltSpot, Sex } from './Belt';
import { TUNING } from './tuning';

type ChickClip = 'idle' | 'walk' | 'run' | 'dance' | 'gesture-negative';

type ChickState =
  | { kind: 'dropping'; line: BeltLine; elapsed: number }
  | { kind: 'riding'; path: BeltPath; distance: number }
  | { kind: 'consumed'; elapsed: number }
  | { kind: 'hopping'; from: THREE.Vector3; to: THREE.Vector3; elapsed: number; landOn: BeltSpot | null }
  | { kind: 'following' }
  | { kind: 'fleeing'; path: THREE.Vector3[]; outward: THREE.Vector3 }
  | { kind: 'escaping'; direction: THREE.Vector3; elapsed: number }
  | { kind: 'gone' };

/**
 * scanned  passed a sorter and went down its sex's branch
 * ground   went into a grinder
 * caged    went into a farm
 * removed  finished its exit animation; safe to dispose
 */
export type ChickEvent = 'scanned' | 'ground' | 'caged' | 'removed';

export interface ChickContext {
  beltsRunning: boolean;
  beltSpeed: number;
  /** Where this chick should stand in the line it follows, if it is following. */
  followTarget: THREE.Vector3 | null;
}

/** Floating gem above a scanned chick, coloured by sex. Shared by all chicks. */
const markerGeometry = new THREE.OctahedronGeometry(0.7);
const markerMaterials: Record<Sex, THREE.MeshBasicMaterial> = {
  male: new THREE.MeshBasicMaterial({ color: 0x4aa8ff }),
  female: new THREE.MeshBasicMaterial({ color: 0xff7ac0 }),
};
const MARKER_HEIGHT = 2.6;

type Gait = 'idle' | 'walk' | 'run';

/**
 * Speed thresholds (tiles/s) for changing gait. Each has a gap between going up and coming
 * back down so a chick near a boundary doesn't flip clips every frame, which reads as jitter.
 */
const GAIT_UP = { walk: 0.6, run: 3.8 };
const GAIT_DOWN = { idle: 0.3, walk: 3.0 };
/** Closer than this to its spot in line, a chick stops instead of creeping. */
const ARRIVE_DISTANCE = 0.06;
/** Playback speed of the walk cycle per tile/s of movement. */
const WALK_CYCLE_PER_SPEED = 0.45;

const scratch = new THREE.Vector3();

export class Chick {
  readonly object: THREE.Object3D;
  private readonly animator: Animator<ChickClip>;
  private readonly marker: THREE.Mesh;
  private state: ChickState;
  private time = Math.random() * 10;
  private speed = 0;
  private gait: Gait = 'idle';

  constructor(
    assets: Assets,
    line: BeltLine,
    readonly sex: Sex,
  ) {
    const { root, animations } = assets.instantiate('chick');
    this.object = root;
    this.object.scale.setScalar(TUNING.chick.scale);
    this.object.position.copy(line.hopperMouth);
    this.animator = new Animator(root, animations);
    this.animator.play('gesture-negative');

    this.marker = new THREE.Mesh(markerGeometry, markerMaterials[sex]);
    this.marker.position.y = MARKER_HEIGHT;
    this.marker.visible = false;
    this.object.add(this.marker);

    this.state = { kind: 'dropping', line, elapsed: 0 };
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get isRiding(): boolean {
    return this.state.kind === 'riding';
  }

  /** Still on the production line: dropping from a hopper or riding a belt. */
  get isOnLine(): boolean {
    return this.state.kind === 'dropping' || this.state.kind === 'riding';
  }

  get isFollowing(): boolean {
    return this.state.kind === 'following';
  }

  /** True if riding (or about to land on) `path` within `gap` of `distance`. */
  isNearOnBelt(path: BeltPath, distance: number, gap: number): boolean {
    const state = this.state;
    if (state.kind === 'riding') return state.path === path && Math.abs(state.distance - distance) < gap;
    return state.kind === 'hopping' && state.landOn?.path === path && Math.abs(state.landOn.distance - distance) < gap;
  }

  /** True while this chick is too close to `line`'s hopper for another to drop. */
  blocksHopper(line: BeltLine): boolean {
    const state = this.state;
    if (state.kind === 'dropping') return state.line === line;
    return state.kind === 'riding' && state.path === line.root && state.distance < 1;
  }

  /** Jump off the belt to `landing` and start following. */
  rescue(landing: THREE.Vector3): void {
    if (this.state.kind !== 'riding') return;
    this.state = { kind: 'hopping', from: this.position.clone(), to: landing.clone(), elapsed: 0, landOn: null };
    this.animator.play('run');
  }

  /** Hop from a guard's line back onto a belt. */
  putBack(spot: BeltSpot): void {
    if (this.state.kind !== 'following') return;
    this.state = { kind: 'hopping', from: this.position.clone(), to: spot.point.clone(), elapsed: 0, landOn: spot };
    this.animator.play('gesture-negative');
  }

  /** Run out through the exit and vanish. */
  escape(direction: THREE.Vector3): void {
    if (this.state.kind !== 'following' && this.state.kind !== 'fleeing') return;
    this.state = { kind: 'escaping', direction: direction.clone().normalize(), elapsed: 0 };
    this.marker.visible = false;
    this.animator.play('dance', { fade: 0.1 });
  }

  /** Leave the line and run along `path` to an exit, then out through it. */
  fleeTo(path: THREE.Vector3[], outward: THREE.Vector3): void {
    const { state } = this;
    const joiningLine = state.kind === 'hopping' && state.landOn === null;
    if (state.kind !== 'following' && !joiningLine) return;
    this.state = { kind: 'fleeing', path, outward: outward.clone() };
  }

  update(dt: number, context: ChickContext): ChickEvent | null {
    this.time += dt;
    this.animator.update(dt);
    if (this.marker.visible) {
      this.marker.rotation.y = this.time * 2.5;
      this.marker.position.y = MARKER_HEIGHT + Math.sin(this.time * 4) * 0.15;
    }

    const state = this.state;
    const { chick } = TUNING;

    switch (state.kind) {
      case 'dropping': {
        state.elapsed += dt;
        const t = Math.min(state.elapsed / chick.dropDuration, 1);
        const landing = state.line.root.start;
        this.position.lerpVectors(state.line.hopperMouth, landing, t);
        this.position.y = THREE.MathUtils.lerp(state.line.hopperMouth.y, landing.y, t * t);
        if (t === 1) this.state = { kind: 'riding', path: state.line.root, distance: 0 };
        return null;
      }

      case 'riding':
        return this.ride(state, dt, context);

      case 'consumed': {
        state.elapsed += dt;
        const t = Math.min(state.elapsed / chick.grindDuration, 1);
        this.object.scale.setScalar(chick.scale * (1 - t));
        return t === 1 ? this.remove() : null;
      }

      case 'hopping': {
        state.elapsed += dt;
        const t = Math.min(state.elapsed / chick.hopDuration, 1);
        this.position.lerpVectors(state.from, state.to, t);
        this.position.y += Math.sin(t * Math.PI) * chick.hopHeight;
        this.face(state.to.x - state.from.x, state.to.z - state.from.z, dt);
        if (t === 1) {
          this.state = state.landOn
            ? { kind: 'riding', path: state.landOn.path, distance: state.landOn.distance }
            : { kind: 'following' };
        }
        return null;
      }

      case 'following':
        if (context.followTarget) this.walkTowards(context.followTarget, dt, true);
        return null;

      case 'fleeing': {
        const next = state.path[0];
        if (!next) {
          this.escape(state.outward);
          return null;
        }
        if (this.walkTowards(next, dt, false)) state.path.shift();
        return null;
      }

      case 'escaping': {
        state.elapsed += dt;
        this.position.addScaledVector(state.direction, chick.escapeSpeed * dt);
        this.face(state.direction.x, state.direction.z, dt);
        if (state.elapsed > 0.6) this.animator.play('run');
        return state.elapsed >= chick.escapeDuration ? this.remove() : null;
      }

      case 'gone':
        return null;
    }
  }

  dispose(): void {
    this.animator.dispose();
    this.object.removeFromParent();
  }

  private ride(
    state: Extract<ChickState, { kind: 'riding' }>,
    dt: number,
    context: ChickContext,
  ): ChickEvent | null {
    if (context.beltsRunning) state.distance += context.beltSpeed * dt;

    let event: ChickEvent | null = null;
    if (state.distance >= state.path.length) {
      const { end } = state.path;
      end.machine.kick();
      if (end.kind === 'sorter') {
        state.distance -= state.path.length;
        state.path = end.branches[this.sex];
        this.marker.visible = true;
        event = 'scanned';
      } else {
        this.state = { kind: 'consumed', elapsed: 0 };
        return end.kind === 'grinder' ? 'ground' : 'caged';
      }
    }

    state.path.pointAt(state.distance, this.position);
    state.path.directionAt(state.distance, scratch);
    this.face(scratch.x, scratch.z, dt);
    return event;
  }

  /**
   * Moves towards `target` with eased speed and settles the gait. With `arrive`, slows down
   * near the target (for keeping a place in line); otherwise keeps full speed through it.
   * Returns true once the target is reached.
   */
  private walkTowards(target: THREE.Vector3, dt: number, arrive: boolean): boolean {
    const { chick } = TUNING;
    scratch.subVectors(target, this.position).setY(0);
    const distance = scratch.length();

    let desired: number = chick.followSpeed;
    if (arrive) desired = distance < ARRIVE_DISTANCE ? 0 : Math.min(chick.followSpeed, distance * chick.followGain);
    this.speed = THREE.MathUtils.damp(this.speed, desired, chick.acceleration, dt);

    const step = Math.min(distance, this.speed * dt);
    if (distance > 1e-4) this.position.addScaledVector(scratch, step / distance);
    this.position.y = 0;
    if (this.speed > GAIT_DOWN.idle) this.face(scratch.x, scratch.z, dt);
    this.updateGait();
    return distance - step < 1e-3;
  }

  private updateGait(): void {
    const speed = this.speed;
    if (this.gait === 'idle' && speed > GAIT_UP.walk) this.gait = 'walk';
    else if (this.gait === 'walk' && speed > GAIT_UP.run) this.gait = 'run';
    else if (this.gait === 'run' && speed < GAIT_DOWN.walk) this.gait = 'walk';
    else if (this.gait === 'walk' && speed < GAIT_DOWN.idle) this.gait = 'idle';

    const timeScale = this.gait === 'walk' ? THREE.MathUtils.clamp(speed * WALK_CYCLE_PER_SPEED, 0.6, 1.5) : 1;
    this.animator.play(this.gait, { timeScale });
  }

  private remove(): ChickEvent {
    this.state = { kind: 'gone' };
    this.object.visible = false;
    return 'removed';
  }

  private face(dx: number, dz: number, dt: number): void {
    if (dx * dx + dz * dz < 1e-6) return;
    this.object.rotation.y = dampAngle(this.object.rotation.y, yawFromDirection(dx, dz), TUNING.chick.turnRate, dt);
  }
}
