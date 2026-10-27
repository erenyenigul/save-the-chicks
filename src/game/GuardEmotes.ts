import * as THREE from 'three/webgpu';
import type { Assets, TextureId } from '../core/Assets';
import type { Guard, GuardMood } from './Guard';

const HEIGHT = 1.75;
const SIZE = 0.62;
const POP_DURATION = 0.25;

const MOOD_TEXTURES: Record<Exclude<GuardMood, 'calm'>, TextureId> = {
  curious: 'emoteQuestion',
  confused: 'emoteConfused',
  alarmed: 'emoteAlert',
};

interface Bubble {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  mood: GuardMood;
  pop: number;
}

/** Speech-bubble emotes over guards: ? when curious, a swirl when searching, ! when chasing. */
export class GuardEmotes {
  readonly root = new THREE.Group();
  private readonly bubbles = new Map<Guard, Bubble>();

  constructor(
    private readonly assets: Assets,
    guards: readonly Guard[],
  ) {
    for (const guard of guards) {
      const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 3;
      this.root.add(sprite);
      this.bubbles.set(guard, { sprite, material, mood: 'calm', pop: 0 });
    }
  }

  update(dt: number): void {
    for (const [guard, bubble] of this.bubbles) {
      const mood = guard.mood;
      if (mood !== bubble.mood) {
        bubble.mood = mood;
        bubble.pop = 0;
        if (mood !== 'calm') {
          bubble.material.map = this.assets.texture(MOOD_TEXTURES[mood]);
          bubble.material.needsUpdate = true;
        }
      }

      bubble.sprite.visible = mood !== 'calm';
      if (!bubble.sprite.visible) continue;

      // Pop in with a little overshoot, then bob.
      bubble.pop = Math.min(bubble.pop + dt / POP_DURATION, 1);
      const scale = SIZE * (bubble.pop < 1 ? Math.sin(bubble.pop * Math.PI * 0.75) * 1.25 : 1);
      bubble.sprite.scale.set(scale, scale * (38 / 32), 1);
      bubble.sprite.position.copy(guard.position).setY(HEIGHT + Math.sin(performance.now() / 180) * 0.04);
    }
  }

  dispose(): void {
    for (const bubble of this.bubbles.values()) bubble.material.dispose();
    this.root.removeFromParent();
  }
}
