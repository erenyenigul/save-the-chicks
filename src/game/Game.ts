import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import type { Input } from '../core/Input';
import { distanceXZ } from '../core/math';
import type { SoundBoard } from '../core/SoundBoard';
import type { HudState } from '../ui/Hud';
import { cellKey } from '../world/Grid';
import { buildLevelScene, type LevelScene } from '../world/LevelBuilder';
import { outwardDirection, parseLevel, type LevelLayout } from '../world/LevelLayout';
import type { LevelDefinition } from '../world/levels';
import { buildBeltLines, nearestBeltSpot, type BeltLine, type MachineMotion } from './Belt';
import { Alarm } from './Alarm';
import { Chick } from './Chick';
import { Guard, separateGuards } from './Guard';
import { Player } from './Player';
import type { Trail } from './Trail';
import { TUNING } from './tuning';

/** What happened during one attempt at a level. */
export interface LevelStats {
  /** Includes chicks that ran out with the player when the level was won. */
  saved: number;
  escapedAtEnd: number;
  ground: number;
  caged: number;
  heldByGuards: number;
  /** Chicks guards grabbed from the player's line over the whole level. */
  taken: number;
  timesSpotted: number;
  seconds: number;
}

export interface GameOutcome {
  won: boolean;
  reason: string;
  stats: LevelStats;
}

/** Moments the tutorial cares about. */
export type GameSignal = 'dashed' | 'grabbed';

/** Anything chicks can follow in a line: the player, or a guard who grabbed them. */
interface Leader {
  readonly position: THREE.Vector3;
  readonly trail: Trail;
}

/** Pause after the deciding moment so its animation can play before the result screen. */
const OUTCOME_DELAY = 1.6;
/** Returned chicks are never put closer than this to a grinder or farm intake. */
const DROP_OFF_END_CLEARANCE = 2;
/** Seconds between chicks when a guard puts several back on a belt. */
const HANDOFF_INTERVAL = 0.8;
/** A chick isn't put on a belt within this distance of one already riding there. */
const HANDOFF_CLEARANCE = 0.6;
/** A guard who wanders further than this from the drop-off abandons the handoff. */
const HANDOFF_LEASH = 1;

/** One play-through of a level: owns every entity and enforces the rules. */
export class Game {
  readonly root = new THREE.Group();

  private readonly layout: LevelLayout;
  private readonly scene: LevelScene;
  private readonly beltLines: BeltLine[];
  private readonly machines: MachineMotion[];
  private readonly player: Player;
  private readonly guards: Guard[];
  private readonly chicks: Chick[] = [];
  /** Following chicks per leader, front of the line first. */
  private readonly lines = new Map<Leader, Chick[]>();
  /** Exit cell key → outward direction. */
  private readonly exits = new Map<string, THREE.Vector3>();

  private readonly alarm: Alarm;
  /** Guards handing chicks back to a belt one at a time: where they stand and when the next goes. */
  private readonly handoffs = new Map<Guard, { at: THREE.Vector3; timer: number }>();

  private saved = 0;
  private escapedAtEnd = 0;
  private readonly losses = { ground: 0, caged: 0 };
  private taken = 0;
  private timesSpotted = 0;
  private elapsed = 0;
  private spawned = 0;
  private spawnTimer = 1;
  private beltStopTimer = 0;
  private leverCooldown = 0;
  private alarmed = false;
  private pendingOutcome: { outcome: GameOutcome; delay: number } | null = null;

  constructor(
    private readonly level: LevelDefinition,
    private readonly levelLabel: string,
    private readonly assets: Assets,
    private readonly sound: SoundBoard,
    private readonly onSignal: (signal: GameSignal) => void = () => {},
  ) {
    this.layout = parseLevel(level);
    this.scene = buildLevelScene(this.layout, assets);
    this.root.add(this.scene.root);
    this.root.add(createLighting(this.layout));

    const belts = buildBeltLines(this.layout.belts, this.scene.machines);
    this.beltLines = belts.lines;
    this.machines = belts.machines;

    for (const cell of this.layout.exits) {
      const out = outwardDirection(cell, this.layout.grid);
      this.exits.set(cellKey(cell), new THREE.Vector3(out.col, 0, out.row));
    }

    this.player = new Player(assets, this.layout.grid.cellCenter(this.layout.playerStart));
    this.root.add(this.player.object);
    this.lines.set(this.player, []);

    this.guards = level.guards.map((route) => new Guard(assets, route, this.layout.grid));
    for (const guard of this.guards) {
      this.root.add(guard.object, guard.cone.mesh);
      this.lines.set(guard, []);
    }

    this.alarm = new Alarm(sound);
    this.sound.setListener(this.player.position);
    this.sound.startLoop('hum');
    this.sound.fadeLoop('hum', 1, 0.8);
    this.sound.play('levelStart');
  }

  get focus(): THREE.Vector3 {
    return this.player.position;
  }

  get playerFacing(): number {
    return this.player.facing;
  }

  /** A chick on a belt within the player's reach, if any. */
  get grabbableChickPosition(): THREE.Vector3 | null {
    return this.grabbableChick()?.position ?? null;
  }

  private get followers(): Chick[] {
    return this.lines.get(this.player)!;
  }

  /** Chicks currently held by guards; they come back into play if a guard returns them to a belt. */
  private get captured(): number {
    return this.guards.reduce((sum, guard) => sum + this.lines.get(guard)!.length, 0);
  }

  /** Chicks gone for good. */
  private get lost(): number {
    return this.losses.ground + this.losses.caged;
  }

  update(dt: number, input: Input): GameOutcome | null {
    if (this.pendingOutcome) {
      this.pendingOutcome.delay -= dt;
      this.updateWorld(dt, input, false);
      return this.pendingOutcome.delay <= 0 ? this.pendingOutcome.outcome : null;
    }

    this.elapsed += dt;
    this.updateWorld(dt, input, true);
    if (input.wasPressed('interact')) this.interact();
    this.spawnChicks(dt);
    this.checkRules();
    return null;
  }

  hudState(): HudState {
    const { rules } = this.level;
    return {
      levelLabel: this.levelLabel,
      saved: this.saved,
      chicksToSave: rules.chicksToSave,
      lost: this.lost,
      maxLost: rules.maxLost,
      following: this.followers.length,
      captured: this.captured,
      remaining: this.chicksOnLine(),
      leverCharge: this.leverCharge(),
      dashCharge: this.player.dashCharge,
      beltsStopped: this.beltStopTimer > 0,
      alert: this.alarmed,
      prompt: this.pendingOutcome ? null : this.interactionPrompt(),
    };
  }

  dispose(): void {
    this.sound.stopLoop('hum');
    for (const chick of this.chicks) chick.dispose();
    for (const guard of this.guards) guard.dispose();
    this.player.dispose();
    this.scene.dispose();
    this.root.traverse((object) => {
      if ((object as THREE.Light).isLight) (object as THREE.Light).dispose();
    });
    this.root.removeFromParent();
  }

  private updateWorld(dt: number, input: Input, live: boolean): void {
    const wasRunning = this.beltStopTimer === 0;
    this.beltStopTimer = Math.max(0, this.beltStopTimer - dt);
    this.leverCooldown = Math.max(0, this.leverCooldown - dt);
    const beltsRunning = this.beltStopTimer === 0;
    if (beltsRunning && !wasRunning) this.sound.fadeLoop('hum', 1);
    for (const machine of this.machines) machine.update(dt, beltsRunning);

    const intent = live ? { axis: input.moveAxis(), dash: input.wasPressed('dash') } : null;
    const playerEvent = this.player.update(dt, intent, this.layout.grid);
    if (playerEvent === 'dash') {
      this.sound.play('dash');
      this.onSignal('dashed');
    } else if (playerEvent === 'step') {
      this.sound.play('step');
    }
    this.sound.setListener(this.player.position);

    this.updateGuards(dt, live);
    this.updateHandoffs(dt);
    this.updateChicks(dt, beltsRunning, live);
    this.alarm.update(dt, live && this.alarmed);
  }

  private updateGuards(dt: number, live: boolean): void {
    const base = {
      grid: this.layout.grid,
      playerPosition: this.player.position,
      playerNoisy: this.player.isNoisy,
      looseChicks: this.followers.filter((chick) => chick.isFollowing).map((chick) => chick.position),
      findDropOff: (from: THREE.Vector3) => this.findDropOff(from),
    };
    for (const guard of this.guards) {
      const event = guard.update(dt, { ...base, carrying: this.lines.get(guard)!.length > 0 });
      if (event === 'spotted') {
        this.sound.play('spotted', guard.position);
        if (live) this.timesSpotted++;
      }
      if (event === 'delivered') this.startHandoff(guard);
      if (event === 'caught' && live) {
        this.player.surrender();
        guard.gloat(this.player.position);
        this.finish(false, 'A guard caught you.');
      }
      if (live) this.captureFollowersNear(guard);
    }
    separateGuards(this.guards, this.layout.grid);
    this.alarmed = this.guards.some((guard) => guard.isChasing);
  }

  /** A guard who bumps into the player's line takes the chicks they touch. */
  private captureFollowersNear(guard: Guard): void {
    const followers = this.followers;
    const captured = this.lines.get(guard)!;
    for (let i = followers.length - 1; i >= 0; i--) {
      const chick = followers[i];
      if (!chick.isFollowing || distanceXZ(chick.position, guard.position) > TUNING.guard.captureDistance) continue;
      followers.splice(i, 1);
      captured.push(chick);
      this.taken++;
      this.sound.play('captured', chick.position);
    }
  }

  /** Walkable tile next to the belt nearest `from`, closest to `from`. */
  private findDropOff(from: THREE.Vector3): THREE.Vector3 | null {
    const spot = nearestBeltSpot(this.beltLines, from, DROP_OFF_END_CLEARANCE);
    if (!spot) return null;
    const { grid } = this.layout;
    const beltCell = grid.cellAt(spot.point);
    let best: THREE.Vector3 | null = null;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cell = { col: beltCell.col + dc, row: beltCell.row + dr };
      if (!grid.isWalkable(cell.col, cell.row)) continue;
      const center = grid.cellCenter(cell);
      if (!best || distanceXZ(center, from) < distanceXZ(best, from)) best = center;
    }
    return best;
  }

  /** A guard arrived at a drop-off: they stand there and hand chicks back one by one. */
  private startHandoff(guard: Guard): void {
    const held = this.lines.get(guard)!;
    const spot = nearestBeltSpot(this.beltLines, guard.position, DROP_OFF_END_CLEARANCE);
    if (!spot || held.length === 0) return;
    guard.hold(HANDOFF_INTERVAL + 0.5, spot.point);
    this.handoffs.set(guard, { at: guard.position.clone(), timer: 0.3 });
  }

  private updateHandoffs(dt: number): void {
    for (const [guard, handoff] of this.handoffs) {
      const held = this.lines.get(guard)!;
      // Distracted (spotted the player, say): the rest stay with them and get delivered later.
      if (held.length === 0 || distanceXZ(guard.position, handoff.at) > HANDOFF_LEASH) {
        this.handoffs.delete(guard);
        continue;
      }

      const spot = nearestBeltSpot(this.beltLines, guard.position, DROP_OFF_END_CLEARANCE);
      if (!spot) {
        this.handoffs.delete(guard);
        continue;
      }
      // Keep the guard standing there until the last chick is back on (unless something else got their attention).
      if (guard.isHandingOff) guard.hold(HANDOFF_INTERVAL + 0.5, spot.point);

      handoff.timer -= dt;
      if (handoff.timer > 0) continue;
      if (this.chicks.some((chick) => chick.isNearOnBelt(spot.path, spot.distance, HANDOFF_CLEARANCE))) {
        handoff.timer = 0.1; // Wait for the previous chick to ride clear.
        continue;
      }

      held.shift()!.putBack(spot);
      this.sound.play('putBack', guard.position);
      handoff.timer = HANDOFF_INTERVAL;
    }
  }

  private updateChicks(dt: number, beltsRunning: boolean, live: boolean): void {
    const { beltSpeed } = this.level.rules;

    const targets = new Map<Chick, THREE.Vector3>();
    for (const [leader, line] of this.lines) {
      line.forEach((chick, slot) => {
        const distance = (slot + 1) * TUNING.chick.spacing;
        targets.set(chick, leader.trail.sample(leader.position, distance, new THREE.Vector3()));
      });
    }

    for (let i = this.chicks.length - 1; i >= 0; i--) {
      const chick = this.chicks[i];
      const event = chick.update(dt, { beltsRunning, beltSpeed, followTarget: targets.get(chick) ?? null });

      switch (event) {
        case 'scanned':
          this.sound.play(chick.sex === 'male' ? 'scanMale' : 'scanFemale', chick.position);
          break;
        case 'ground':
          if (live) this.losses.ground++;
          this.sound.play('ground', chick.position);
          break;
        case 'caged':
          if (live) this.losses.caged++;
          this.sound.play('caged', chick.position);
          break;
        case 'removed':
          chick.dispose();
          this.chicks.splice(i, 1);
          continue;
      }

      if (live && chick.isFollowing) this.tryEscape(chick);
    }
  }

  /** A chick in the player's line that reaches an exit tile is saved. */
  private tryEscape(chick: Chick): void {
    const slot = this.followers.indexOf(chick);
    if (slot < 0) return;
    const outward = this.exits.get(cellKey(this.layout.grid.cellAt(chick.position)));
    if (!outward) return;

    chick.escape(outward);
    this.followers.splice(slot, 1);
    this.saved++;
    this.sound.play('saved');
  }

  private interact(): void {
    const chick = this.grabbableChick();
    if (chick) {
      this.player.interactWith(chick.position);
      const landing = new THREE.Vector3().lerpVectors(this.player.position, chick.position, 0.45).setY(0);
      this.layout.grid.resolveCircle(landing, 0.2);
      chick.rescue(landing);
      this.followers.push(chick);
      this.sound.play('grab');
      this.sound.play('chirp');
      this.onSignal('grabbed');
      return;
    }

    const lever = this.nearbyLever();
    if (lever && this.leverCooldown === 0 && this.beltStopTimer === 0) {
      this.player.interactWith(lever.position);
      lever.rotation.y += Math.PI;
      this.beltStopTimer = TUNING.lever.stopDuration;
      this.leverCooldown = TUNING.lever.cooldown;
      this.sound.play('lever');
      this.sound.play('beltsStop');
      this.sound.fadeLoop('hum', 0.15);
    }
  }

  /** Belt stop time left while active, otherwise recharge progress. */
  private leverCharge(): number {
    const { stopDuration, cooldown } = TUNING.lever;
    if (this.beltStopTimer > 0) return this.beltStopTimer / stopDuration;
    return 1 - this.leverCooldown / cooldown;
  }

  private interactionPrompt(): string | null {
    if (this.grabbableChick()) return 'Space — grab the chick';
    if (!this.nearbyLever()) return null;
    if (this.beltStopTimer > 0) return 'Belts stopped!';
    return this.leverCooldown > 0 ? 'Emergency stop is recharging…' : 'Space — pull the emergency stop';
  }

  private grabbableChick(): Chick | null {
    let best: Chick | null = null;
    let bestDistance: number = TUNING.player.grabRange;
    for (const chick of this.chicks) {
      if (!chick.isRiding) continue;
      const distance = distanceXZ(chick.position, this.player.position);
      if (distance < bestDistance) {
        best = chick;
        bestDistance = distance;
      }
    }
    return best;
  }

  private nearbyLever(): THREE.Object3D | null {
    return (
      this.scene.levers.find((lever) => distanceXZ(lever.position, this.player.position) < TUNING.player.leverRange) ??
      null
    );
  }

  private spawnChicks(dt: number): void {
    const { totalChicks, spawnInterval } = this.level.rules;
    if (this.spawned >= totalChicks || this.beltStopTimer > 0) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    const free = this.beltLines.filter((line) => this.chicks.every((chick) => !chick.blocksHopper(line)));
    if (free.length === 0) return;

    const line = free[Math.floor(Math.random() * free.length)];
    const chick = new Chick(this.assets, line, Math.random() < 0.5 ? 'male' : 'female');
    this.chicks.push(chick);
    this.root.add(chick.object);
    this.spawned++;
    this.sound.play('chirp', line.hopperMouth);

    const progress = this.spawned / totalChicks;
    this.spawnTimer = THREE.MathUtils.lerp(spawnInterval.start, spawnInterval.end, progress);
  }

  /** Chicks not yet dropped plus those still on a belt. */
  private chicksOnLine(): number {
    const onBelts = this.chicks.filter((chick) => chick.isOnLine).length;
    return this.level.rules.totalChicks - this.spawned + onBelts;
  }

  private checkRules(): void {
    const { chicksToSave, maxLost } = this.level.rules;
    if (this.saved >= chicksToSave) {
      this.win();
    } else if (this.lost >= maxLost) {
      this.finish(false, this.lossSummary());
    } else if (this.saved + this.followers.length + this.captured + this.chicksOnLine() < chicksToSave) {
      this.finish(false, `Not enough chicks left to save. ${this.lossSummary()}`);
    }
  }

  private lossSummary(): string {
    const { ground, caged } = this.losses;
    const captured = this.captured;
    const parts = [
      ground > 0 && `${ground} ground up`,
      caged > 0 && `${caged} caged on the egg farm`,
      captured > 0 && `${captured} taken by guards`,
    ].filter(Boolean);
    return parts.length > 0 ? `Lost chicks: ${parts.join(', ')}.` : '';
  }

  /** Level won: everyone still following runs for the nearest exit and counts as saved. */
  private win(): void {
    let longestRun = 0;
    for (const chick of this.followers) {
      const exit = this.nearestExit(chick.position);
      const path = this.layout.grid.findPath(chick.position, exit.cell);
      chick.fleeTo(path, exit.outward);
      longestRun = Math.max(longestRun, pathLength(chick.position, path));
    }
    this.escapedAtEnd = this.followers.length;
    this.saved += this.escapedAtEnd;
    this.followers.length = 0;

    const extra = this.escapedAtEnd > 0 ? ` ${this.escapedAtEnd} more ran out with you.` : '';
    this.finish(true, `You got ${this.saved} chicks out of the factory.${extra}`);
    // Give the runners time to reach the door before the results come up.
    if (this.pendingOutcome) {
      this.pendingOutcome.delay = Math.max(OUTCOME_DELAY, longestRun / TUNING.chick.followSpeed + 1);
    }
  }

  private nearestExit(from: THREE.Vector3): { cell: THREE.Vector3; outward: THREE.Vector3 } {
    let best: { cell: THREE.Vector3; outward: THREE.Vector3 } | null = null;
    for (const cell of this.layout.exits) {
      const center = this.layout.grid.cellCenter(cell);
      if (!best || distanceXZ(center, from) < distanceXZ(best.cell, from)) {
        best = { cell: center, outward: this.exits.get(cellKey(cell))! };
      }
    }
    return best!;
  }

  private finish(won: boolean, reason: string): void {
    if (this.pendingOutcome) return;
    const stats: LevelStats = {
      saved: this.saved,
      escapedAtEnd: this.escapedAtEnd,
      ground: this.losses.ground,
      caged: this.losses.caged,
      heldByGuards: this.captured,
      taken: this.taken,
      timesSpotted: this.timesSpotted,
      seconds: this.elapsed,
    };
    this.pendingOutcome = { outcome: { won, reason, stats }, delay: OUTCOME_DELAY };
    this.sound.fadeLoop('hum', 0, OUTCOME_DELAY);
  }
}

function pathLength(from: THREE.Vector3, path: readonly THREE.Vector3[]): number {
  let length = 0;
  let previous = from;
  for (const point of path) {
    length += distanceXZ(previous, point);
    previous = point;
  }
  return length;
}

function createLighting(layout: LevelLayout): THREE.Group {
  const { width, height } = layout.grid;
  const group = new THREE.Group();
  group.add(new THREE.HemisphereLight(0xd9dcff, 0x3b2f55, 1.6));

  const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
  const center = new THREE.Vector3((width - 1) / 2, 0, (height - 1) / 2);
  sun.position.copy(center).add(new THREE.Vector3(-8, 18, 10));
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  const extent = Math.max(width, height) * 0.65;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 60 });
  sun.shadow.camera.updateProjectionMatrix();

  group.add(sun, sun.target);
  return group;
}
