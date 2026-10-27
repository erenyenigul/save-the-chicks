import { TUNING } from './tuning';

/** The emergency stop: halts every belt for a while, then needs to recharge. */
export class EmergencyStop {
  private stopTimer = 0;
  private cooldown = 0;

  get beltsRunning(): boolean {
    return this.stopTimer === 0;
  }

  get isReady(): boolean {
    return this.stopTimer === 0 && this.cooldown === 0;
  }

  /** While stopped: fraction of the stop left. Otherwise recharge progress (1 = ready). */
  get charge(): number {
    const { stopDuration, cooldown } = TUNING.emergencyStop;
    return this.stopTimer > 0 ? this.stopTimer / stopDuration : 1 - this.cooldown / cooldown;
  }

  /** Seconds until the belts restart, or until the button can be pressed again. */
  get secondsLeft(): number {
    return this.stopTimer > 0 ? this.stopTimer : this.cooldown;
  }

  get state(): 'ready' | 'stopped' | 'recharging' {
    if (this.stopTimer > 0) return 'stopped';
    return this.cooldown > 0 ? 'recharging' : 'ready';
  }

  press(): boolean {
    if (!this.isReady) return false;
    this.stopTimer = TUNING.emergencyStop.stopDuration;
    this.cooldown = TUNING.emergencyStop.cooldown;
    return true;
  }

  /** Returns 'restarted' on the frame the belts start moving again. */
  update(dt: number): 'restarted' | null {
    const wasStopped = this.stopTimer > 0;
    this.stopTimer = Math.max(0, this.stopTimer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    return wasStopped && this.stopTimer === 0 ? 'restarted' : null;
  }
}
