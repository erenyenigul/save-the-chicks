import * as THREE from 'three/webgpu';
import { cellKey, type Cell } from '../world/Grid';
import type { BeltLine as BeltLineLayout, BeltRun } from '../world/LevelLayout';
import { TUNING } from './tuning';

export type Sex = 'male' | 'female';

const HOPPER_MOUTH_HEIGHT = 1.4;
const KICK_DURATION = 0.3;

/** Rumbles a machine while the line runs and kicks it when it takes a chick. */
export class MachineMotion {
  private readonly rest: THREE.Vector3;
  private kickTimer = 0;
  private time = Math.random() * 10;

  constructor(
    private readonly object: THREE.Object3D,
    private readonly rumble: number,
  ) {
    this.rest = object.position.clone();
  }

  get position(): THREE.Vector3 {
    return this.rest;
  }

  kick(): void {
    this.kickTimer = KICK_DURATION;
  }

  update(dt: number, running: boolean): void {
    this.time += dt;
    this.kickTimer = Math.max(0, this.kickTimer - dt);
    const shake = running ? Math.sin(this.time * 45) * this.rumble : 0;
    this.object.position.set(this.rest.x + shake, this.rest.y, this.rest.z);
    this.object.scale.setScalar(1 + (this.kickTimer / KICK_DURATION) * 0.12);
  }
}

export type PathEnd =
  | { kind: 'grinder' | 'farm'; machine: MachineMotion }
  | { kind: 'sorter'; machine: MachineMotion; branches: Record<Sex, BeltPath> };

/** A polyline along belt surfaces, parameterised by distance travelled. */
export class BeltPath {
  readonly length: number;
  private readonly cumulative: number[] = [0];

  constructor(
    private readonly points: readonly THREE.Vector3[],
    readonly end: PathEnd,
  ) {
    for (let i = 1; i < points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  get start(): THREE.Vector3 {
    return this.points[0];
  }

  pointAt(distance: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.segmentAt(distance);
    const t = (distance - this.cumulative[i]) / (this.cumulative[i + 1] - this.cumulative[i]);
    return out.lerpVectors(this.points[i], this.points[i + 1], THREE.MathUtils.clamp(t, 0, 1));
  }

  /** Distance along the path of the point closest to `position` (XZ only). */
  closestDistance(position: THREE.Vector3): number {
    let best = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const abX = b.x - a.x;
      const abZ = b.z - a.z;
      const lengthSq = abX * abX + abZ * abZ;
      const t = THREE.MathUtils.clamp(((position.x - a.x) * abX + (position.z - a.z) * abZ) / lengthSq, 0, 1);
      const dx = a.x + abX * t - position.x;
      const dz = a.z + abZ * t - position.z;
      if (dx * dx + dz * dz < bestDistSq) {
        bestDistSq = dx * dx + dz * dz;
        best = this.cumulative[i] + t * (this.cumulative[i + 1] - this.cumulative[i]);
      }
    }
    return best;
  }

  /** This path and every branch after it. */
  *walk(): Generator<BeltPath> {
    yield this;
    if (this.end.kind === 'sorter') {
      yield* this.end.branches.male.walk();
      yield* this.end.branches.female.walk();
    }
  }

  directionAt(distance: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.segmentAt(distance);
    return out.subVectors(this.points[i + 1], this.points[i]).normalize();
  }

  private segmentAt(distance: number): number {
    let i = 0;
    while (i < this.cumulative.length - 2 && this.cumulative[i + 1] < distance) i++;
    return i;
  }
}

/** A hopper and the belt network it feeds. */
export class BeltLine {
  readonly hopperMouth: THREE.Vector3;

  constructor(
    hopper: Cell,
    readonly root: BeltPath,
  ) {
    this.hopperMouth = new THREE.Vector3(hopper.col, HOPPER_MOUTH_HEIGHT, hopper.row);
  }
}

export interface BeltSpot {
  path: BeltPath;
  distance: number;
  point: THREE.Vector3;
}

/** Candidate offsets (along the belt) tried around the closest point, so a rejected spot has alternatives. */
const SPOT_SEARCH_OFFSETS = [0, -1, 1, -2, 2, -3, 3];

/**
 * Spot on any belt closest to `position`, at least `endClearance` from machine intakes,
 * and passing `accept` (used to keep different guards' spots apart).
 */
export function nearestBeltSpot(
  lines: readonly BeltLine[],
  position: THREE.Vector3,
  options: { endClearance: number; accept?: (point: THREE.Vector3) => boolean },
): BeltSpot | null {
  let best: BeltSpot | null = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    for (const path of line.root.walk()) {
      const usable = path.length - (path.end.kind === 'sorter' ? 0 : options.endClearance);
      if (usable <= 0) continue;
      const closest = path.closestDistance(position);
      for (const offset of SPOT_SEARCH_OFFSETS) {
        const distance = THREE.MathUtils.clamp(closest + offset, 0, usable);
        const point = path.pointAt(distance, new THREE.Vector3());
        const away = Math.hypot(point.x - position.x, point.z - position.z);
        if (away >= bestDistance || (options.accept && !options.accept(point))) continue;
        bestDistance = away;
        best = { path, distance, point };
      }
    }
  }
  return best;
}

/** Turns parsed belt layouts into paths, wiring each end to its scene machine. */
export function buildBeltLines(
  layouts: readonly BeltLineLayout[],
  sceneMachines: ReadonlyMap<string, THREE.Object3D>,
): { lines: BeltLine[]; machines: MachineMotion[] } {
  const machines: MachineMotion[] = [];
  const motionAt = (cell: Cell, rumble: number): MachineMotion => {
    const object = sceneMachines.get(cellKey(cell));
    if (!object) throw new Error(`No machine was built at ${cellKey(cell)}`);
    const motion = new MachineMotion(object, rumble);
    machines.push(motion);
    return motion;
  };

  const surface = (cell: Cell): THREE.Vector3 => new THREE.Vector3(cell.col, TUNING.chick.beltHeight, cell.row);

  const buildPath = (run: BeltRun, origin?: Cell): BeltPath => {
    const points = run.tiles.map((tile) => surface(tile.cell));
    if (origin) points.unshift(surface(origin));

    const { end } = run;
    if (end.kind === 'sorter') {
      points.push(surface(end.cell));
      return new BeltPath(points, {
        kind: 'sorter',
        machine: motionAt(end.cell, 0),
        branches: { male: buildPath(end.male, end.cell), female: buildPath(end.female, end.cell) },
      });
    }
    // Chicks vanish at the machine's intake, half a tile before its centre.
    const intake = surface(end.cell).addScaledVector(new THREE.Vector3(end.direction.col, 0, end.direction.row), -0.5);
    points.push(intake);
    return new BeltPath(points, { kind: end.kind, machine: motionAt(end.cell, 0.012) });
  };

  const lines = layouts.map((layout) => new BeltLine(layout.hopper, buildPath(layout.run)));
  return { lines, machines };
}
