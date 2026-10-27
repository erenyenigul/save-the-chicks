import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import type { Input } from '../core/Input';
import { distanceXZ } from '../core/math';
import type { SoundBoard } from '../core/SoundBoard';
import type { HudState } from '../ui/Hud';
import { cellKey } from '../world/Grid';
import { buildLevelScene, type LevelScene } from '../world/LevelBuilder';
import { outwardDirection, parseLevel, type LevelLayout } from '../world/LevelLayout';
import { buildStreet, type StreetScene } from '../world/Street';
import type { LevelDefinition } from '../world/levels';
import { Alarm } from './Alarm';
import { buildBeltLines, nearestBeltSpot, type BeltLine, type MachineMotion } from './Belt';
import { BeltReturns } from './BeltReturns';
import { Chick, type EscapeRoute } from './Chick';
import { ChickSpawner } from './ChickSpawner';
import { Effects } from './Effects';
import { EmergencyStop } from './EmergencyStop';
import { Guard, separateGuards } from './Guard';
import { GuardEmotes } from './GuardEmotes';
import { Player } from './Player';
import { StopStations } from './StopStations';
import { Sun } from './Sun';
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
export type GameSignal = 'dashed' | 'dashedWhileChased' | 'grabbed';

/** Anything chicks can follow in a line: the player, or a guard who grabbed them. */
interface Leader {
  readonly position: THREE.Vector3;
  readonly trail: Trail;
}

/** Pause after the deciding moment so its animation can play before the result screen. */
const OUTCOME_DELAY = 1.6;
/** The factory hum is only audible within this distance of a belt. */
const BELT_HEARING_DISTANCE = 6;
/** Hum level while the emergency stop has the belts halted. */
const STOPPED_HUM_LEVEL = 0.15;

/**
 * One play-through of a level. Owns the entities, wires the components
 * (spawner, emergency stop, belt returns, alarm) together and enforces the rules.
 */
export class Game {
  readonly root = new THREE.Group();

  private readonly layout: LevelLayout;
  private readonly scene: LevelScene;
  private readonly street: StreetScene;
  private readonly sun: Sun;
  private readonly machines: MachineMotion[];
  private readonly beltLines: BeltLine[];
  private readonly player: Player;
  private readonly guards: Guard[];
  private readonly chicks: Chick[] = [];
  /** Following chicks per leader, front of the line first. */
  private readonly lines = new Map<Leader, Chick[]>();
  /** Exit cell key → outward direction. */
  private readonly exits = new Map<string, THREE.Vector3>();

  private readonly spawner: ChickSpawner;
  private readonly emergencyStop = new EmergencyStop();
  private readonly returns: BeltReturns;
  private readonly alarm: Alarm;
  private readonly effects: Effects;
  private readonly stopStations: StopStations;
  private readonly emotes: GuardEmotes;

  private saved = 0;
  private escapedAtEnd = 0;
  private readonly losses = { ground: 0, caged: 0 };
  private taken = 0;
  private timesSpotted = 0;
  private elapsed = 0;
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
    this.street = buildStreet(this.layout, assets);
    this.root.add(this.scene.root, this.street.root);

    const belts = buildBeltLines(this.layout.belts, this.scene.machines);
    this.machines = belts.machines;
    this.beltLines = belts.lines;
    this.spawner = new ChickSpawner(level.rules, belts.lines);
    this.returns = new BeltReturns(belts.lines, this.layout.grid);

    for (const cell of this.layout.exits) {
      const out = outwardDirection(cell, this.layout.grid);
      this.exits.set(cellKey(cell), new THREE.Vector3(out.col, 0, out.row));
    }

    this.player = new Player(assets, this.layout.grid.cellCenter(this.layout.playerStart));
    this.root.add(this.player.object);
    this.sun = new Sun(this.player.position);
    this.root.add(...this.sun.objects);
    this.lines.set(this.player, []);

    this.guards = level.guards.map((route) => new Guard(assets, route, this.layout.grid));
    for (const guard of this.guards) {
      this.root.add(guard.object, guard.cone.mesh);
      this.lines.set(guard, []);
    }

    this.effects = new Effects();
    this.stopStations = new StopStations(this.scene.stopStations);
    this.emotes = new GuardEmotes(assets, this.guards);
    this.root.add(this.effects.root, this.emotes.root);

    this.alarm = new Alarm(sound);
    this.sound.setListener(this.player.position);
    this.sound.startLoop('hum');
    this.mixHum();
    this.sound.play('levelStart');
  }

  get focus(): THREE.Vector3 {
    return this.player.position;
  }

  get playerFacing(): number {
    return this.player.facing;
  }

  /** A guard is chasing the player right now. */
  get isChased(): boolean {
    return this.alarmed;
  }

  get dashReady(): boolean {
    return this.player.dashCharge >= 1;
  }

  /**
   * Things the player can act on right now, for the renderer to outline:
   * stop buttons while the emergency stop is ready, and the chick within reach.
   */
  highlights(): THREE.Object3D[] {
    if (this.pendingOutcome) return [];
    const buttons = this.emergencyStop.isReady ? this.stopStations.buttons : [];
    const chick = this.grabbableChick();
    return chick ? [...buttons, chick.object] : buttons;
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

  /** Chicks not yet dropped plus those still on a belt. */
  private get onLine(): number {
    return this.spawner.remaining + this.chicks.filter((chick) => chick.isOnLine).length;
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
    this.dropChick(dt);
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
      remaining: this.onLine,
      stopCharge: this.emergencyStop.charge,
      stopSeconds: this.emergencyStop.secondsLeft,
      dashCharge: this.player.dashCharge,
      beltsStopped: !this.emergencyStop.beltsRunning,
      alert: this.alarmed,
      prompt: this.pendingOutcome ? null : this.interactionPrompt(),
    };
  }

  dispose(): void {
    this.sound.stopLoop('hum');
    this.effects.dispose();
    this.stopStations.dispose();
    this.emotes.dispose();
    for (const chick of this.chicks) chick.dispose();
    for (const guard of this.guards) guard.dispose();
    this.player.dispose();
    this.scene.dispose();
    this.street.dispose();
    this.sun.dispose();
    this.root.removeFromParent();
  }

  private updateWorld(dt: number, input: Input, live: boolean): void {
    this.emergencyStop.update(dt);
    this.stopStations.update(dt, this.emergencyStop);
    const beltsRunning = this.emergencyStop.beltsRunning;
    for (const machine of this.machines) machine.update(dt, beltsRunning);
    this.street.update(
      dt,
      this.chicks.filter((chick) => chick.isEscaping).map((chick) => chick.position),
    );

    const intent = live ? { axis: input.moveAxis(), dash: input.wasPressed('dash') } : null;
    const playerEvent = this.player.update(dt, intent, this.layout.grid);
    if (playerEvent === 'dash') {
      this.sound.play('dash');
      this.effects.dash(this.player.position, this.player.dashHeading);
      this.onSignal(this.alarmed ? 'dashedWhileChased' : 'dashed');
    } else if (playerEvent === 'step') {
      this.sound.play('step');
    }
    this.sound.setListener(this.player.position);
    this.sun.follow(this.player.position);
    this.mixHum();
    this.effects.update(dt);

    this.updateGuards(dt, live);
    this.returns.update(
      dt,
      this.chicks,
      (guard) => this.lines.get(guard)!,
      (guard) => this.sound.play('putBack', guard.position),
    );
    this.updateChicks(dt, beltsRunning, live);
    this.alarm.update(dt, live && this.alarmed);
  }

  private updateGuards(dt: number, live: boolean): void {
    const shared = {
      grid: this.layout.grid,
      playerPosition: this.player.position,
      playerNoisy: this.player.isNoisy,
      looseChicks: this.followers.filter((chick) => chick.isFollowing).map((chick) => chick.position),
    };
    for (const guard of this.guards) {
      const event = guard.update(dt, {
        ...shared,
        carrying: this.lines.get(guard)!.length > 0,
        findDropOff: (from) => this.returns.reserve(guard, from),
      });
      if (event === 'spotted') {
        this.sound.play('spotted', guard.position);
        if (live) this.timesSpotted++;
      }
      if (event === 'delivered') this.returns.begin(guard);
      if (event === 'caught' && live) {
        this.player.surrender();
        for (const other of this.guards) other.halt(this.player.position);
        guard.gloat(this.player.position);
        this.finish(false, 'A guard caught you.');
      }
      if (live) this.captureFollowersNear(guard);
    }
    separateGuards(this.guards, this.layout.grid);
    this.emotes.update(dt);
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

    chick.escape(escapeRoute(outward));
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

    const button = this.nearbyStopButton();
    if (button && this.emergencyStop.press()) {
      this.player.interactWith(button.position);
      this.stopStations.press(button);
      this.sound.play('stopButton');
      this.sound.play('beltsStop');
    }
  }

  /**
   * The factory hum comes from the belts: it fades in near one, pans towards it,
   * drops low while the emergency stop is on, and dies away once the level is decided.
   */
  private mixHum(): void {
    const spot = nearestBeltSpot(this.beltLines, this.player.position, { endClearance: 0 });
    if (!spot || this.pendingOutcome) {
      this.sound.mixLoop('hum', 0);
      return;
    }
    const closeness = 1 - Math.min(distanceXZ(spot.point, this.player.position) / BELT_HEARING_DISTANCE, 1);
    const running = this.emergencyStop.beltsRunning ? 1 : STOPPED_HUM_LEVEL;
    this.sound.mixLoop('hum', closeness ** 1.5 * running, (spot.point.x - this.player.position.x) / BELT_HEARING_DISTANCE);
  }

  private interactionPrompt(): string | null {
    if (this.grabbableChick()) return 'Space — grab the chick';
    if (!this.nearbyStopButton()) return null;
    if (!this.emergencyStop.beltsRunning) return 'Belts stopped!';
    return this.emergencyStop.isReady ? 'Space — press the emergency stop' : 'Emergency stop is recharging…';
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

  private nearbyStopButton(): THREE.Object3D | null {
    const range = TUNING.player.buttonRange;
    return this.stopStations.buttons.find((button) => distanceXZ(button.position, this.player.position) < range) ?? null;
  }

  private dropChick(dt: number): void {
    const line = this.spawner.update(dt, this.chicks);
    if (!line) return;
    const chick = new Chick(this.assets, line, Math.random() < 0.5 ? 'male' : 'female');
    this.chicks.push(chick);
    this.root.add(chick.object);
    this.sound.play('chirp', line.hopperMouth);
  }

  private checkRules(): void {
    const { chicksToSave, maxLost } = this.level.rules;
    if (this.saved >= chicksToSave) {
      this.win();
    } else if (this.lost >= maxLost) {
      this.finish(false, this.lossSummary());
    } else if (this.saved + this.followers.length + this.captured + this.onLine < chicksToSave) {
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
      chick.fleeTo(path, escapeRoute(exit.outward));
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
  }
}

/** Out through the exit, then left or right down the sidewalk at random. */
function escapeRoute(outward: THREE.Vector3): EscapeRoute {
  const side = Math.random() < 0.5 ? 1 : -1;
  return { outward, along: new THREE.Vector3(-outward.z * side, 0, outward.x * side) };
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
