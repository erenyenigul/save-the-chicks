import { Howl, Howler } from 'howler';
import * as THREE from 'three/webgpu';

interface SoundSpec {
  /** File names in /audio without extension; one is picked at random per play. */
  files: readonly string[];
  volume: number;
  /** Random playback-rate spread, e.g. 0.1 → 0.9–1.1. */
  pitchJitter?: number;
  loop?: boolean;
}

const range = (prefix: string, from: number, to: number, pad = 3): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(pad, '0')}`);

const SOUNDS = {
  chirp: { files: range('pepSound', 1, 5, 1), volume: 0.35, pitchJitter: 0.15 },
  step: { files: range('footstep_concrete_', 0, 4), volume: 0.16, pitchJitter: 0.1 },
  dash: { files: range('cloth', 1, 4, 1), volume: 0.7, pitchJitter: 0.1 },
  grab: { files: range('impactSoft_medium_', 0, 2), volume: 0.45 },
  saved: { files: range('confirmation_', 1, 4), volume: 0.45 },
  ground: { files: range('explosionCrunch_', 0, 2), volume: 0.3, pitchJitter: 0.15 },
  caged: { files: ['metalLatch'], volume: 0.5 },
  scanMale: { files: ['lowDown'], volume: 0.3 },
  scanFemale: { files: ['highUp'], volume: 0.3 },
  spotted: { files: ['zapThreeToneUp'], volume: 0.4 },
  siren: { files: ['twoTone1'], volume: 0.22 },
  heartbeat: { files: range('impactSoft_heavy_', 0, 1), volume: 0.5, pitchJitter: 0.04 },
  captured: { files: range('error_', 1, 3), volume: 0.5 },
  putBack: { files: ['ui-switch-a'], volume: 0.6 },
  stopButton: { files: range('switch_', 1, 2), volume: 0.6 },
  beltsStop: { files: range('phaserDown', 1, 3, 1), volume: 0.35 },
  click: { files: ['ui-click-a'], volume: 0.6 },
  levelStart: { files: ['jingles_PIZZI04'], volume: 0.6 },
  win: { files: ['jingles_PIZZI02'], volume: 0.7 },
  hum: { files: ['spaceEngineLow_000'], volume: 0.26, loop: true },
} satisfies Record<string, SoundSpec>;

export type SoundId = keyof typeof SOUNDS;

/** Sounds beyond this distance from the listener are silent. */
const HEARING_DISTANCE = 16;
/** Horizontal offset (in tiles) that pans a sound fully to one side. */
const PAN_DISTANCE = 10;
const MAX_PAN = 0.7;

/** Kenney sound effects via Howler, with simple distance falloff and stereo panning. */
export class SoundBoard {
  private readonly bank = new Map<SoundId, Howl[]>();
  private readonly listener = new THREE.Vector3();
  private muted = false;

  constructor(baseUrl = `${import.meta.env.BASE_URL}audio/`) {
    for (const [id, spec] of Object.entries(SOUNDS) as [SoundId, SoundSpec][]) {
      this.bank.set(
        id,
        spec.files.map(
          (file) =>
            new Howl({
              // Ogg for most browsers, AAC for Safari versions without Vorbis.
              src: [`${baseUrl}${file}.ogg`, `${baseUrl}${file}.m4a`],
              volume: spec.volume,
              loop: spec.loop ?? false,
            }),
        ),
      );
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    Howler.mute(muted);
  }

  setListener(position: THREE.Vector3): void {
    this.listener.copy(position);
  }

  /** Plays a one-shot. With `at`, volume falls off and pans with distance from the listener. */
  play(id: SoundId, at?: THREE.Vector3): void {
    const variants = this.bank.get(id)!;
    const howl = variants[Math.floor(Math.random() * variants.length)];
    const spec: SoundSpec = SOUNDS[id];

    let gain = 1;
    let pan = 0;
    if (at) {
      const distance = Math.hypot(at.x - this.listener.x, at.z - this.listener.z);
      gain = 1 - Math.min(distance / HEARING_DISTANCE, 1);
      if (gain === 0) return;
      pan = THREE.MathUtils.clamp((at.x - this.listener.x) / PAN_DISTANCE, -1, 1) * MAX_PAN;
    }

    const soundId = howl.play();
    howl.volume(spec.volume * gain, soundId);
    howl.stereo(pan, soundId);
    if (spec.pitchJitter) howl.rate(1 + (Math.random() * 2 - 1) * spec.pitchJitter, soundId);
  }

  /** Starts a looping sound if it is not already playing. */
  startLoop(id: SoundId): void {
    const howl = this.bank.get(id)![0];
    if (!howl.playing()) howl.play();
  }

  /** Sets a loop's level (× base volume) and stereo pan immediately; for per-frame mixing. */
  mixLoop(id: SoundId, level: number, pan = 0): void {
    const howl = this.bank.get(id)![0];
    howl.volume(SOUNDS[id].volume * level);
    howl.stereo(THREE.MathUtils.clamp(pan, -1, 1) * MAX_PAN);
  }

  stopLoop(id: SoundId): void {
    this.bank.get(id)![0].stop();
  }
}
