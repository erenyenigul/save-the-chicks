import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import { Animator } from '../core/Animator';
import { dampAngle, yawFromDirection } from '../core/math';
import type { BeltLine, BeltPath, BeltSpot, Sex } from './Belt';
import { SIDEWALK_HEIGHT } from '../world/Street';
import { TUNING } from './tuning';

type ChickClip = 'idle' | 'walk' | 'run' | 'gesture-negative';

type ChickState =
  | { kind: 'dropping'; line: BeltLine; elapsed: number }
  | { kind: 'riding'; path: BeltPath; distance: number; pushTo: number | null }
  | { kind: 'consumed'; elapsed: number }
  | { kind: 'hopping'; from: THREE.Vector3; to: THREE.Vector3; elapsed: number; landOn: BeltSpot | null }
  | { kind: 'following' }
  | { kind: 'fleeing'; path: THREE.Vector3[]; route: EscapeRoute }
  | { kind: 'escaping'; route: EscapeRoute; start: THREE.Vector3; elapsed: number; turned: boolean }
  | { kind: 'gone' };

/**
 * scanned  passed a sorter and went down its sex's branch
 * ground   went into a grinder
 * caged    went into a farm
 * removed  finished its exit animation; safe to dispose
 */
export type ChickEvent = 'scanned' | 'ground' | 'caged' | 'removed';

/** Out through the exit onto the sidewalk, then along it to one side. */
export interface EscapeRoute {
  outward: THREE.Vector3;
  along: THREE.Vector3;
}

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

  /** Outside the factory, running off down the sidewalk. */
  get isEscaping(): boolean {
    return this.state.kind === 'escaping';
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

  /** Still falling out of `line`'s hopper. */
  isDroppingOnto(line: BeltLine): boolean {
    return this.state.kind === 'dropping' && this.state.line === line;
  }

  /** Where on a belt this chick is (or is being shoved to), if it is riding one. */
  get beltPosition(): { path: BeltPath; distance: number } | null {
    const state = this.state;
    if (state.kind !== 'riding') return null;
    return { path: state.path, distance: Math.max(state.distance, state.pushTo ?? 0) };
  }

  /** Slides this chick forward along its belt to `distance` (used when a newcomer needs room). */
  shoveTo(distance: number): void {
    if (this.state.kind === 'riding') this.state.pushTo = Math.max(this.state.pushTo ?? 0, distance);
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

  /** Run out through the exit, turn down the sidewalk and vanish. */
  escape(route: EscapeRoute): void {
    if (this.state.kind !== 'following' && this.state.kind !== 'fleeing') return;
    this.state = { kind: 'escaping', route, start: this.position.clone(), elapsed: 0, turned: false };
    this.marker.visible = false;
    this.animator.play('run', { fade: 0.1 });
  }

  /** Leave the line and run along `path` to an exit, then out through it. */
  fleeTo(path: THREE.Vector3[], route: EscapeRoute): void {
    const { state } = this;
    const joiningLine = state.kind === 'hopping' && state.landOn === null;
    if (state.kind !== 'following' && !joiningLine) return;
    this.state = { kind: 'fleeing', path, route };
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
        // Spat out: pops up out of the hopper and arcs down onto the belt.
        this.position.y = THREE.MathUtils.lerp(state.line.hopperMouth.y, landing.y, t) + Math.sin(t * Math.PI) * chick.spitHeight;
        if (t === 1) this.state = { kind: 'riding', path: state.line.root, distance: 0, pushTo: null };
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
            ? { kind: 'riding', path: state.landOn.path, distance: state.landOn.distance, pushTo: null }
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
          this.escape(state.route);
          return null;
        }
        if (this.walkTowards(next, dt, false)) state.path.shift();
        return null;
      }

      case 'escaping':
        return this.runAway(state, dt);

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
    if (state.pushTo !== null) {
      // Being shoved along by chicks landing behind — this works even on a stopped belt.
      state.distance = Math.max(state.distance, Math.min(state.pushTo, state.distance + TUNING.chick.shoveSpeed * dt));
      if (state.distance >= state.pushTo) state.pushTo = null;
    }

    let event: ChickEvent | null = null;
    if (state.distance >= state.path.length) {
      const { end } = state.path;
      end.machine.kick();
      if (end.kind === 'sorter') {
        state.distance -= state.path.length;
        state.pushTo = state.pushTo === null ? null : state.pushTo - state.path.length;
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

  private runAway(state: Extract<ChickState, { kind: 'escaping' }>, dt: number): ChickEvent | null {
    const { chick } = TUNING;
    state.elapsed += dt;

    scratch.subVectors(this.position, state.start).setY(0);
    const outwardTravel = scratch.dot(state.route.outward);
    if (!state.turned && outwardTravel >= chick.sidewalkStep) state.turned = true;

    const heading = state.turned ? state.route.along : state.route.outward;
    this.position.addScaledVector(heading, chick.escapeSpeed * dt);
    this.face(heading.x, heading.z, dt);
    // Step up onto the sidewalk once clear of the doorway.
    this.position.y = outwardTravel > 0.6 ? SIDEWALK_HEIGHT : 0;

    return state.elapsed >= chick.escapeDuration ? this.remove() : null;
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
