import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import { Animator } from '../core/Animator';
import { dampAngle, distanceXZ, stepTowards, yawFromDirection } from '../core/math';
import type { Cell, Grid } from '../world/Grid';
import { Trail } from './Trail';
import { TUNING } from './tuning';
import { VisionCone } from './VisionCone';

type GuardClip = 'idle' | 'walk' | 'sprint' | 'emote-yes';

/**
 * patrol     walking the route, pausing at each waypoint
 * suspicious stopped, staring at something; suspicion decides what comes next
 * chase      running at the last place the player (or a loose chick) was seen
 * search     lost them; checks where they were heading and nearby spots, then gives up
 * deliver    carrying grabbed chicks to the nearest belt to put them back
 * handoff    standing at the belt while the chicks go back on, one by one
 * halted     the player was caught; stands still for the rest of the level
 */
type GuardMode = 'patrol' | 'suspicious' | 'chase' | 'search' | 'deliver' | 'handoff' | 'halted';

export interface GuardContext {
  grid: Grid;
  playerPosition: THREE.Vector3;
  /** The player just dashed and can be heard. */
  playerNoisy: boolean;
  /** Chicks following the player; guards notice them too. */
  looseChicks: readonly THREE.Vector3[];
  /** This guard is leading chicks they grabbed. */
  carrying: boolean;
  /** Walkable spot next to the belt nearest to `from`, where grabbed chicks can be put back. */
  findDropOff(from: THREE.Vector3): THREE.Vector3 | null;
}

/**
 * spotted    started a chase
 * caught     reached the player
 * delivered  arrived at the drop-off; the carried chicks should go back on the belt
 */
export type GuardEvent = 'spotted' | 'caught' | 'delivered';

/** What a guard's body language shows: curious (?), confused (searching), alarmed (!). */
export type GuardMood = 'calm' | 'curious' | 'confused' | 'alarmed';

/** What the guard perceived this frame, strongest first. */
type Stimulus = 'player' | 'chick' | 'noise' | null;

const SUSPICIOUS_THRESHOLD = 0.12;
/** Suspicion gain multipliers per kind of stimulus. */
const STIMULUS_WEIGHT: Record<Exclude<Stimulus, null>, number> = { player: 1, chick: 0.7, noise: 0.5 };
const scratch = new THREE.Vector3();

export class Guard {
  readonly object: THREE.Object3D;
  readonly cone: VisionCone;
  /** Path walked, so chicks the guard has grabbed can trail behind. */
  readonly trail = new Trail(30);
  private readonly animator: Animator<GuardClip>;
  private readonly route: readonly THREE.Vector3[];

  private mode: GuardMode = 'patrol';
  private suspicion = 0;
  private routeIndex = 0;
  private path: THREE.Vector3[] = [];
  private pauseTimer = 0;
  /** After a failed delivery attempt, wait this long before planning another. */
  private deliveryRetry = 0;
  /** Where the guard was when it last made real progress along a path, and for how long since. */
  private readonly progressMark = new THREE.Vector3();
  private stalledFor = 0;
  private repathTimer = 0;
  private lostTimer = 0;
  /** Spots still to check while searching. */
  private searchPoints: THREE.Vector3[] = [];
  private glanceTimer = 0;
  private glanceYaw = 0;
  private readonly lastSeen = new THREE.Vector3();
  /** Direction the target was last seen moving in (zero if unknown). */
  private readonly lastHeading = new THREE.Vector3();

  constructor(assets: Assets, route: readonly Cell[], grid: Grid) {
    const { root, animations } = assets.instantiate('guard');
    this.object = root;
    this.object.scale.setScalar(TUNING.guard.scale);
    this.route = route.map((cell) => grid.cellCenter(cell));
    this.object.position.copy(this.route[0]);
    this.trail.reset(this.object.position);
    this.animator = new Animator(root, animations);
    this.animator.play('idle');
    this.cone = new VisionCone(TUNING.guard.viewDistance, TUNING.guard.fieldOfView);
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get isChasing(): boolean {
    return this.mode === 'chase';
  }

  get mood(): GuardMood {
    switch (this.mode) {
      case 'chase':
        return 'alarmed';
      case 'search':
        return 'confused';
      case 'suspicious':
        return 'curious';
      default:
        return 'calm';
    }
  }

  get isDelivering(): boolean {
    return this.mode === 'deliver';
  }

  get isHandingOff(): boolean {
    return this.mode === 'handoff';
  }

  /** Stand still for `seconds` facing `target` while chicks are handed back to a belt. */
  hold(seconds: number, target: THREE.Vector3): void {
    this.mode = 'handoff';
    this.path = [];
    this.pauseTimer = seconds;
    this.object.rotation.y = yawFromDirection(target.x - this.position.x, target.z - this.position.z);
  }

  /** Displaces the guard (used to keep guards apart), staying clear of walls. */
  push(dx: number, dz: number, grid: Grid): void {
    this.position.x += dx;
    this.position.z += dz;
    grid.resolveCircle(this.position, TUNING.guard.radius);
  }

  /** Stop and celebrate once the player is caught. */
  gloat(target: THREE.Vector3): void {
    this.halt(target);
    this.animator.play('emote-yes');
  }

  /** Stop for good (the level is over), turning to look at `target`. */
  halt(target: THREE.Vector3): void {
    this.mode = 'halted';
    this.path = [];
    this.object.rotation.y = yawFromDirection(target.x - this.position.x, target.z - this.position.z);
    this.animator.play('idle');
  }

  update(dt: number, context: GuardContext): GuardEvent | null {
    this.animator.update(dt);
    if (this.mode === 'halted') {
      this.cone.update(this.position, this.object.rotation.y, context.grid, 0);
      return null;
    }
    const stimulus = this.perceive(context);

    let event: GuardEvent | null = null;
    switch (this.mode) {
      case 'patrol':
      case 'suspicious':
      case 'deliver':
      case 'handoff':
        event = this.updateCalm(dt, context, stimulus);
        break;
      case 'chase':
        event = this.updateChase(dt, context, stimulus);
        break;
      case 'search':
        event = this.updateSearch(dt, context, stimulus);
        break;
    }

    const alertness = this.mode === 'chase' ? 1 : this.suspicion;
    this.cone.update(this.position, this.object.rotation.y, context.grid, alertness);
    return event;
  }

  dispose(): void {
    this.animator.dispose();
    this.cone.dispose();
    this.object.removeFromParent();
  }

  /** Updates `lastSeen` / `lastHeading` and reports the strongest thing noticed. */
  private perceive(context: GuardContext): Stimulus {
    const { guard } = TUNING;
    if (this.canSee(context.playerPosition, context.grid)) {
      this.remember(context.playerPosition);
      return 'player';
    }

    let nearestChick: THREE.Vector3 | null = null;
    for (const chick of context.looseChicks) {
      if (!this.canSee(chick, context.grid)) continue;
      if (!nearestChick || distanceXZ(chick, this.position) < distanceXZ(nearestChick, this.position)) {
        nearestChick = chick;
      }
    }
    if (nearestChick) {
      this.remember(nearestChick);
      return 'chick';
    }

    if (context.playerNoisy && distanceXZ(this.position, context.playerPosition) < guard.hearingRadius) {
      this.remember(context.playerPosition);
      return 'noise';
    }
    return null;
  }

  private remember(position: THREE.Vector3): void {
    scratch.subVectors(position, this.lastSeen).setY(0);
    const moved = scratch.length();
    // Only trust small steps as motion; a jump means a different target.
    if (moved > 0.02 && moved < 1) this.lastHeading.copy(scratch).divideScalar(moved);
    else if (moved >= 1) this.lastHeading.set(0, 0, 0);
    this.lastSeen.set(position.x, 0, position.z);
  }

  private updateCalm(dt: number, context: GuardContext, stimulus: Stimulus): GuardEvent | null {
    this.updateSuspicion(dt, stimulus);
    if (this.suspicion >= 1) return this.startChase();

    if (this.suspicion > SUSPICIOUS_THRESHOLD) {
      if (this.mode !== 'suspicious') this.path = [];
      this.mode = 'suspicious';
      this.turnTowards(this.lastSeen, dt);
      this.animator.play('idle');
      return null;
    }

    if (this.mode === 'handoff') {
      this.pauseTimer -= dt;
      this.animator.play('idle');
      if (this.pauseTimer <= 0) this.resumeDuties(context);
      return null;
    }

    if (this.mode === 'suspicious') this.resumeDuties(context);
    this.deliveryRetry = Math.max(0, this.deliveryRetry - dt);
    if (this.mode === 'patrol' && context.carrying && this.deliveryRetry === 0) this.startDelivery(context);

    if (this.mode === 'deliver') return this.deliver(dt, context);
    this.patrol(dt, context.grid);
    return null;
  }

  private updateChase(dt: number, context: GuardContext, stimulus: Stimulus): GuardEvent | null {
    const { guard } = TUNING;
    if (distanceXZ(this.position, context.playerPosition) < guard.catchDistance) return 'caught';

    this.lostTimer = stimulus === 'player' || stimulus === 'chick' ? 0 : this.lostTimer + dt;
    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this.repathTimer = guard.repathInterval;
      this.path = context.grid.findPath(this.position, this.lastSeen);
    }
    this.followPath(dt, guard.chaseSpeed, context.grid);
    this.animator.play('sprint');

    // Arriving where they were last seen without seeing them now means they got away;
    // waiting there for the timer is what used to make guards stand frozen.
    const arrived = this.path.length === 0 && stimulus === null;
    if (arrived || this.lostTimer > guard.loseSightAfter) this.startSearch(context.grid);
    return null;
  }

  private updateSearch(dt: number, context: GuardContext, stimulus: Stimulus): GuardEvent | null {
    const { guard } = TUNING;
    this.updateSuspicion(dt, stimulus);
    if (this.suspicion >= 1) return this.startChase();

    if (this.path.length > 0) {
      this.followPath(dt, guard.searchSpeed, context.grid);
      this.animator.play('walk');
      if (this.path.length === 0) {
        this.glanceTimer = guard.glanceDuration;
        this.glanceYaw = this.object.rotation.y;
      }
      return null;
    }

    if (this.glanceTimer > 0) {
      this.glanceTimer -= dt;
      this.animator.play('idle');
      const sweep = Math.sin((guard.glanceDuration - this.glanceTimer) * 5) * 1.1;
      this.object.rotation.y = dampAngle(this.object.rotation.y, this.glanceYaw + sweep, guard.turnRate, dt);
      return null;
    }

    const next = this.searchPoints.shift();
    if (next) {
      this.path = context.grid.findPath(this.position, next);
      if (this.path.length === 0) this.glanceTimer = 0;
      return null;
    }

    // Gave up.
    this.suspicion = 0;
    this.resumeDuties(context);
    return null;
  }

  private startChase(): GuardEvent {
    this.mode = 'chase';
    this.suspicion = 1;
    this.lostTimer = 0;
    this.repathTimer = 0;
    return 'spotted';
  }

  /** Check where the target was heading first, then a couple of nearby spots. */
  private startSearch(grid: Grid): void {
    const { guard } = TUNING;
    this.mode = 'search';
    this.suspicion = guard.searchAlertness;
    this.path = [];
    this.glanceTimer = 0;

    const candidates: THREE.Vector3[] = [];
    if (this.lastHeading.lengthSq() > 0) {
      candidates.push(this.lastSeen.clone().addScaledVector(this.lastHeading, guard.searchLead));
    }
    for (let i = 0; i < guard.searchSpots; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = guard.searchRadius * (0.5 + Math.random() * 0.5);
      candidates.push(this.lastSeen.clone().add(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)));
    }

    this.searchPoints = [this.lastSeen.clone()];
    for (const candidate of candidates) {
      const cell = grid.nearestWalkableCell(grid.cellAt(candidate));
      if (cell) this.searchPoints.push(grid.cellCenter(cell));
    }
  }

  /** Back to normal work: deliver grabbed chicks first, otherwise patrol. */
  private resumeDuties(context: GuardContext): void {
    this.path = [];
    if (context.carrying) this.startDelivery(context);
    else this.mode = 'patrol';
  }

  private startDelivery(context: GuardContext): void {
    const dropOff = context.findDropOff(this.position);
    const path = dropOff ? context.grid.findPath(this.position, dropOff) : [];
    if (!dropOff || (path.length === 0 && distanceXZ(this.position, dropOff) > 0.5)) {
      this.mode = 'patrol';
      this.deliveryRetry = TUNING.guard.deliveryRetryDelay;
      return;
    }
    this.mode = 'deliver';
    this.path = path;
  }

  private deliver(dt: number, context: GuardContext): GuardEvent | null {
    if (this.path.length > 0) {
      this.followPath(dt, TUNING.guard.patrolSpeed, context.grid);
      this.animator.play('walk');
      if (this.path.length > 0) return null;
    }
    this.mode = 'patrol';
    this.pauseTimer = TUNING.guard.waypointPause;
    return 'delivered';
  }

  private updateSuspicion(dt: number, stimulus: Stimulus): void {
    const { guard } = TUNING;
    if (stimulus) {
      const closeness = 1 - distanceXZ(this.position, this.lastSeen) / guard.viewDistance;
      const weight = STIMULUS_WEIGHT[stimulus];
      this.suspicion += guard.suspicionGain * weight * (0.5 + Math.max(closeness, 0) * 1.5) * dt;
    } else {
      this.suspicion -= guard.suspicionDecay * dt;
    }
    this.suspicion = THREE.MathUtils.clamp(this.suspicion, 0, 1);
  }

  private patrol(dt: number, grid: Grid): void {
    if (this.path.length === 0) {
      if (this.pauseTimer > 0) {
        this.pauseTimer -= dt;
        this.animator.play('idle');
        return;
      }
      this.routeIndex = (this.routeIndex + 1) % this.route.length;
      this.path = grid.findPath(this.position, this.route[this.routeIndex]);
      if (this.path.length === 0) {
        this.pauseTimer = TUNING.guard.waypointPause;
        return;
      }
    }

    this.followPath(dt, TUNING.guard.patrolSpeed, grid);
    this.animator.play('walk');
    if (this.path.length === 0) this.pauseTimer = TUNING.guard.waypointPause;
  }

  /**
   * Safety net for anything that blocks a guard (another guard parked on their waypoint, say):
   * if they haven't really moved for a while, drop the path so the current mode plans afresh.
   */
  private detectStall(dt: number): void {
    const { guard } = TUNING;
    if (this.path.length === 0 || distanceXZ(this.position, this.progressMark) > guard.stallDistance) {
      this.progressMark.copy(this.position);
      this.stalledFor = 0;
      return;
    }
    this.stalledFor += dt;
    if (this.stalledFor > guard.stallTimeout) {
      // An emptied path makes the current mode re-plan; a delivering guard reports arrival,
      // and the drop-off then checks whether they are actually close enough.
      this.path = [];
      this.stalledFor = 0;
    }
  }

  private followPath(dt: number, speed: number, grid: Grid): void {
    this.detectStall(dt);
    let budget = speed * dt;
    while (budget > 0 && this.path.length > 0) {
      const target = this.path[0];
      scratch.subVectors(target, this.position);
      const before = Math.hypot(scratch.x, scratch.z);
      if (before > 1e-3) this.turnTowards(target, dt);
      const remaining = stepTowards(this.position, target, budget);
      budget -= before - remaining;
      if (remaining === 0) this.path.shift();
      else break;
    }
    grid.resolveCircle(this.position, TUNING.guard.radius);
    this.trail.record(this.position);
  }

  private turnTowards(target: THREE.Vector3, dt: number): void {
    const yaw = yawFromDirection(target.x - this.position.x, target.z - this.position.z);
    this.object.rotation.y = dampAngle(this.object.rotation.y, yaw, TUNING.guard.turnRate, dt);
  }

  private canSee(target: THREE.Vector3, grid: Grid): boolean {
    const { guard } = TUNING;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > guard.viewDistance) return false;
    if (distance > 0.5) {
      const offset = yawFromDirection(dx, dz) - this.object.rotation.y;
      const angle = Math.atan2(Math.sin(offset), Math.cos(offset));
      if (Math.abs(angle) > guard.fieldOfView / 2) return false;
    }
    return grid.hasLineOfSight(this.position, target);
  }
}

/** Guards never stand closer than this to each other. */
const GUARD_SEPARATION = 0.9;
/** Pushes are skewed by this angle so two guards meeting head-on sidestep instead of locking. */
const SIDESTEP_ANGLE = THREE.MathUtils.degToRad(35);

/** Resolves overlaps between guards by pushing each pair apart. */
export function separateGuards(guards: readonly Guard[], grid: Grid): void {
  const cos = Math.cos(SIDESTEP_ANGLE);
  const sin = Math.sin(SIDESTEP_ANGLE);
  for (let i = 0; i < guards.length; i++) {
    for (let j = i + 1; j < guards.length; j++) {
      const a = guards[i];
      const b = guards[j];
      let dx = a.position.x - b.position.x;
      let dz = a.position.z - b.position.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= GUARD_SEPARATION) continue;
      if (distance < 1e-4) {
        // Exactly on top of each other: pick an arbitrary but stable direction.
        dx = 1;
        dz = 0;
        distance = 1;
      }
      const overlap = (GUARD_SEPARATION - Math.min(distance, GUARD_SEPARATION)) / 2;
      const nx = dx / distance;
      const nz = dz / distance;
      // Rotate the push direction; both guards turn the same way, so they slide past.
      const px = (nx * cos - nz * sin) * overlap;
      const pz = (nx * sin + nz * cos) * overlap;
      a.push(px, pz, grid);
      b.push(-px, -pz, grid);
    }
  }
}
