import * as THREE from 'three/webgpu';
import { distanceXZ } from '../core/math';
import type { Grid } from '../world/Grid';
import { nearestBeltSpot, type BeltLine, type BeltSpot } from './Belt';
import type { Chick } from './Chick';
import type { Guard } from './Guard';

/** Chicks are never put back closer than this to a grinder or farm intake. */
const END_CLEARANCE = 2;
/** Seconds between chicks when one guard puts several back. */
const INTERVAL = 0.8;
/** A chick isn't put down within this distance (along the belt) of one already there. */
const CHICK_CLEARANCE = 0.6;
/** Two guards' drop-off spots are kept at least this far apart, so they don't crowd one spot. */
const RESERVATION_GAP = 2.5;
/** How far from where they stand a guard can reach to put a chick down. */
const REACH = 1.6;
/** A guard who strays further than this from their spot has been distracted. */
const LEASH = 1;
/** If the belt stays too busy this long, try a different spot. */
const GIVE_UP_AFTER = 4;
/** How long an abandoned spot is avoided. */
const AVOID_FOR = 10;

interface Reservation {
  spot: BeltSpot;
  stand: THREE.Vector3;
}

interface Handoff {
  at: THREE.Vector3;
  timer: number;
  waited: number;
}

/**
 * Guards putting captured chicks back on belts: each reserves a spot (kept apart
 * from other guards' spots), walks there, then hands chicks over one at a time,
 * skipping ahead or behind along the belt when the exact spot is occupied.
 */
export class BeltReturns {
  private readonly reservations = new Map<Guard, Reservation>();
  private readonly handoffs = new Map<Guard, Handoff>();
  private readonly avoided = new Map<Guard, { point: THREE.Vector3; until: number }>();
  private time = 0;

  constructor(
    private readonly lines: readonly BeltLine[],
    private readonly grid: Grid,
  ) {}

  /** Reserves a belt spot for `guard`; returns where they should stand, or null if none is free. */
  reserve(guard: Guard, from: THREE.Vector3): THREE.Vector3 | null {
    this.release(guard);
    const avoided = this.avoided.get(guard);
    const spot = nearestBeltSpot(this.lines, from, {
      endClearance: END_CLEARANCE,
      accept: (point) =>
        !this.isNearOtherReservation(guard, point) &&
        !(avoided && avoided.until > this.time && distanceXZ(point, avoided.point) < RESERVATION_GAP),
    });
    const stand = spot && this.standingSpot(spot.point, from);
    if (!spot || !stand) return null;
    this.reservations.set(guard, { spot, stand });
    return stand;
  }

  /** The guard says they've arrived. Starts the handoff if they really are at their spot. */
  begin(guard: Guard): void {
    const reservation = this.reservations.get(guard);
    if (!reservation || distanceXZ(guard.position, reservation.stand) > LEASH) {
      this.release(guard);
      return;
    }
    guard.hold(INTERVAL + 0.5, reservation.spot.point);
    this.handoffs.set(guard, { at: guard.position.clone(), timer: 0.3, waited: 0 });
  }

  /**
   * Hands chicks over. `held` gives the chicks a guard is leading (front first);
   * `onPutBack` fires for each chick that goes back on a belt.
   */
  update(
    dt: number,
    chicks: readonly Chick[],
    held: (guard: Guard) => Chick[],
    onPutBack: (guard: Guard) => void,
  ): void {
    this.time += dt;
    for (const guard of this.reservations.keys()) {
      if (!guard.isDelivering && !this.handoffs.has(guard)) this.release(guard);
    }

    for (const [guard, handoff] of this.handoffs) {
      const queue = held(guard);
      const reservation = this.reservations.get(guard)!;
      if (queue.length === 0 || distanceXZ(guard.position, handoff.at) > LEASH) {
        this.release(guard);
        continue;
      }
      // Keep the guard standing there until the last chick is back on.
      if (guard.isHandingOff) guard.hold(INTERVAL + 0.5, reservation.spot.point);

      handoff.timer -= dt;
      if (handoff.timer > 0) continue;

      const spot = this.freeSpotNear(reservation.spot, guard.position, chicks);
      if (!spot) {
        handoff.waited += dt;
        if (handoff.waited > GIVE_UP_AFTER) {
          this.avoided.set(guard, { point: reservation.spot.point.clone(), until: this.time + AVOID_FOR });
          this.release(guard);
        }
        continue;
      }

      queue.shift()!.putBack(spot);
      onPutBack(guard);
      handoff.timer = INTERVAL;
      handoff.waited = 0;
    }
  }

  release(guard: Guard): void {
    this.reservations.delete(guard);
    this.handoffs.delete(guard);
  }

  private isNearOtherReservation(guard: Guard, point: THREE.Vector3): boolean {
    for (const [other, reservation] of this.reservations) {
      if (other !== guard && distanceXZ(point, reservation.spot.point) < RESERVATION_GAP) return true;
    }
    return false;
  }

  /** Walkable tile beside the belt at `point`, nearest to `from`. */
  private standingSpot(point: THREE.Vector3, from: THREE.Vector3): THREE.Vector3 | null {
    const belt = this.grid.cellAt(point);
    const candidates = [
      { col: belt.col + 1, row: belt.row },
      { col: belt.col - 1, row: belt.row },
      { col: belt.col, row: belt.row + 1 },
      { col: belt.col, row: belt.row - 1 },
    ]
      .filter((cell) => this.grid.isWalkable(cell.col, cell.row))
      .map((cell) => this.grid.cellCenter(cell));
    candidates.sort((a, b) => distanceXZ(a, from) - distanceXZ(b, from));
    return candidates[0] ?? null;
  }

  /** The reserved spot, or one a little up or down the belt, that is within reach and unoccupied. */
  private freeSpotNear(reserved: BeltSpot, reachFrom: THREE.Vector3, chicks: readonly Chick[]): BeltSpot | null {
    const { path } = reserved;
    for (const offset of [0, -0.7, 0.7, -1.4, 1.4]) {
      const distance = THREE.MathUtils.clamp(reserved.distance + offset, 0, path.length);
      const point = path.pointAt(distance, new THREE.Vector3());
      if (distanceXZ(point, reachFrom) > REACH) continue;
      if (chicks.some((chick) => chick.isNearOnBelt(path, distance, CHICK_CLEARANCE))) continue;
      return { path, distance, point };
    }
    return null;
  }
}
