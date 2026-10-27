import * as THREE from 'three/webgpu';
import type { LevelRules } from '../world/levels';
import type { BeltLine, BeltPath } from './Belt';
import type { Chick } from './Chick';
import { TUNING } from './tuning';

/**
 * Decides when and onto which belt the hoppers drop the next chick. Drops keep
 * coming even while the emergency stop has the belts halted: each newcomer
 * shoves the queue at the start of the belt further along to make room.
 */
export class ChickSpawner {
  private dropped = 0;
  private timer = 1;

  constructor(
    private readonly rules: LevelRules,
    private readonly lines: readonly BeltLine[],
  ) {}

  /** Chicks the hoppers have yet to drop. */
  get remaining(): number {
    return this.rules.totalChicks - this.dropped;
  }

  /** The line to drop a chick onto this frame, if it's time and its hopper is free. */
  update(dt: number, chicks: readonly Chick[]): BeltLine | null {
    if (this.remaining === 0) return null;
    this.timer -= dt;
    if (this.timer > 0) return null;

    const free = this.lines.filter((line) => chicks.every((chick) => !chick.isDroppingOnto(line)));
    if (free.length === 0) return null;

    const line = free[Math.floor(Math.random() * free.length)];
    makeRoomAtStart(line.root, chicks);
    this.dropped++;
    const { start, end } = this.rules.spawnInterval;
    this.timer = THREE.MathUtils.lerp(start, end, this.dropped / this.rules.totalChicks);
    return line;
  }
}

/** Shoves chicks near the start of `path` forward so each keeps `beltSpacing` from the one behind. */
function makeRoomAtStart(path: BeltPath, chicks: readonly Chick[]): void {
  const spacing = TUNING.chick.beltSpacing;
  const riders = chicks
    .map((chick) => ({ chick, position: chick.beltPosition }))
    .filter((rider) => rider.position?.path === path)
    .sort((a, b) => a.position!.distance - b.position!.distance);

  let needed = spacing;
  for (const { chick, position } of riders) {
    if (position!.distance >= needed) break;
    chick.shoveTo(needed);
    needed += spacing;
  }
}
