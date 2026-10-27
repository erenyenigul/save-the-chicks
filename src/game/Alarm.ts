import type { SoundBoard } from '../core/SoundBoard';

const SIREN_INTERVAL = 0.9;
const HEARTBEAT_INTERVAL = 0.62;
/** Gap between the two thumps of one heartbeat. */
const HEARTBEAT_SECOND_BEAT = 0.17;

/** Siren pulses and a racing heartbeat while any guard is chasing. */
export class Alarm {
  private sirenTimer = 0;
  private heartbeatTimer = 0;
  private secondBeatTimer = -1;

  constructor(private readonly sound: SoundBoard) {}

  update(dt: number, active: boolean): void {
    if (!active) {
      this.sirenTimer = 0;
      this.heartbeatTimer = 0;
      this.secondBeatTimer = -1;
      return;
    }

    this.sirenTimer -= dt;
    if (this.sirenTimer <= 0) {
      this.sirenTimer = SIREN_INTERVAL;
      this.sound.play('siren');
    }

    this.heartbeatTimer -= dt;
    if (this.heartbeatTimer <= 0) {
      this.heartbeatTimer = HEARTBEAT_INTERVAL;
      this.secondBeatTimer = HEARTBEAT_SECOND_BEAT;
      this.sound.play('heartbeat');
    }

    if (this.secondBeatTimer >= 0) {
      this.secondBeatTimer -= dt;
      if (this.secondBeatTimer < 0) this.sound.play('heartbeat');
    }
  }
}
