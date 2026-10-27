import * as THREE from 'three/webgpu';
import type { Assets } from '../core/Assets';
import { Animator } from '../core/Animator';
import { dampAngle, yawFromDirection } from '../core/math';
import type { Grid } from '../world/Grid';
import { Trail } from './Trail';
import { TUNING } from './tuning';

type PlayerClip = 'idle' | 'walk' | 'sprint' | 'interact-right' | 'die';

const INTERACT_ANIMATION_TIME = 0.35;
const TRAIL_LENGTH = 40;
/** Largest movement per collision step; keeps dashes from tunnelling through one-tile walls. */
const MAX_COLLISION_STEP = 0.2;

export interface MoveIntent {
  /** Unit (or zero) direction on the ground plane: x → +X, y → +Z. */
  axis: { x: number; y: number };
  /** Dash was pressed this frame. */
  dash: boolean;
}

export type PlayerEvent = 'dash' | 'step';

export class Player {
  readonly object: THREE.Object3D;
  readonly trail = new Trail(TRAIL_LENGTH);
  private readonly animator: Animator<PlayerClip>;
  private readonly dashDirection = new THREE.Vector3();
  private interactTimer = 0;
  private dashTimer = 0;
  private dashCooldown = 0;
  private noiseTimer = 0;
  private stepTimer = 0;
  private caught = false;

  constructor(assets: Assets, start: THREE.Vector3) {
    const { root, animations } = assets.instantiate('player');
    this.object = root;
    this.object.scale.setScalar(TUNING.player.scale);
    this.object.position.copy(start);
    this.object.rotation.y = Math.PI / 2;
    this.animator = new Animator(root, animations);
    this.animator.play('idle');
    this.trail.reset(start);
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  /** Direction of the current (or most recent) dash. */
  get dashHeading(): THREE.Vector3 {
    return this.dashDirection;
  }

  get facing(): number {
    return this.object.rotation.y;
  }

  /** Guards can hear the player shortly after a dash. */
  get isNoisy(): boolean {
    return this.noiseTimer > 0;
  }

  /** 1 when a dash is available, rising from 0 while it recharges. */
  get dashCharge(): number {
    return 1 - this.dashCooldown / TUNING.player.dash.cooldown;
  }

  /** Turn towards something and play the reach animation. */
  interactWith(target: THREE.Vector3): void {
    this.object.rotation.y = yawFromDirection(target.x - this.position.x, target.z - this.position.z);
    this.interactTimer = INTERACT_ANIMATION_TIME;
    this.animator.play('interact-right', { fade: 0.08, once: true, timeScale: 1.6 });
  }

  /** Freeze in the caught pose; further input is ignored. */
  surrender(): void {
    this.caught = true;
    this.animator.play('die', { once: true });
  }

  /** `intent` is null when the player has no control (e.g. after the level is decided). */
  update(dt: number, intent: MoveIntent | null, grid: Grid): PlayerEvent | null {
    this.animator.update(dt);
    if (this.caught) return null;

    const { player } = TUNING;
    const move = intent?.axis ?? { x: 0, y: 0 };
    const moving = move.x !== 0 || move.y !== 0;
    let event: PlayerEvent | null = null;

    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.noiseTimer = Math.max(0, this.noiseTimer - dt);
    if (intent?.dash && this.dashCooldown === 0) {
      // Dash where the stick points, or straight ahead when standing still.
      if (moving) this.dashDirection.set(move.x, 0, move.y);
      else this.dashDirection.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.dashTimer = player.dash.duration;
      this.dashCooldown = player.dash.cooldown;
      this.noiseTimer = player.dash.noiseDuration;
      event = 'dash';
    }

    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - dt);
      this.moveBy(this.dashDirection.x, this.dashDirection.z, player.dash.speed * dt, grid);
      this.turnTowards(this.dashDirection.x, this.dashDirection.z, dt);
      this.animator.play('sprint', { fade: 0.05 });
      return event;
    }

    if (moving) {
      this.moveBy(move.x, move.y, player.walkSpeed * dt, grid);
      this.turnTowards(move.x, move.y, dt);
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = player.stepInterval;
        event ??= 'step';
      }
    } else {
      this.stepTimer = 0;
    }

    this.interactTimer = Math.max(0, this.interactTimer - dt);
    if (this.interactTimer === 0) this.animator.play(moving ? 'walk' : 'idle');
    return event;
  }

  dispose(): void {
    this.animator.dispose();
    this.object.removeFromParent();
  }

  private moveBy(dirX: number, dirZ: number, distance: number, grid: Grid): void {
    const steps = Math.max(1, Math.ceil(distance / MAX_COLLISION_STEP));
    for (let i = 0; i < steps; i++) {
      this.position.x += (dirX * distance) / steps;
      this.position.z += (dirZ * distance) / steps;
      grid.resolveCircle(this.position, TUNING.player.radius);
    }
    this.trail.record(this.position);
  }

  private turnTowards(dirX: number, dirZ: number, dt: number): void {
    this.object.rotation.y = dampAngle(this.object.rotation.y, yawFromDirection(dirX, dirZ), TUNING.player.turnRate, dt);
  }
}
