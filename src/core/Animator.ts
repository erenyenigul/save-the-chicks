import * as THREE from 'three/webgpu';

/** Thin wrapper over AnimationMixer that cross-fades between named clips. */
export class Animator<Clip extends string> {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;

  constructor(root: THREE.Object3D, clips: readonly THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
  }

  play(name: Clip, options: { fade?: number; once?: boolean; timeScale?: number } = {}): void {
    const { fade = 0.2, once = false, timeScale = 1 } = options;
    const next = this.actions.get(name);
    if (!next) throw new Error(`Animation clip "${name}" not found`);

    next.timeScale = timeScale;
    // A looping clip that is already playing carries on; a one-shot replays from the start.
    if (next === this.current && !once) return;

    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.play();
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, fade, false);
    this.current = next;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}
