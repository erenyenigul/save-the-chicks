import * as THREE from 'three/webgpu';
import { element } from './dom';

/**
 * dash    any dash at all
 * escape  a dash while a guard is chasing (the hint comes back during chases until then)
 * grab    grabbing a chick off a belt
 */
export type Lesson = 'dash' | 'escape' | 'grab';

export interface TutorialCues {
  player: THREE.Vector3;
  /** Player yaw; +Z-forward convention. */
  facing: number;
  /** Chick within reach, if any. */
  grabbable: THREE.Vector3 | null;
  /** A guard is chasing the player. */
  chased: boolean;
  dashReady: boolean;
}

const STORAGE_KEY = 'coop-breakout:lessons';
/** Screen distance from the player to the dash arrow, in CSS pixels. */
const ARROW_OFFSET = 70;
const GRAB_HINT_HEIGHT = 1.7;

const scratch = new THREE.Vector3();

/**
 * In-world hints: a Shift + arrow next to the player until they first dash (and
 * again whenever a guard chases them, until they have dashed away once), and a
 * Space key over the first chick they can grab. Learned lessons are remembered
 * across sessions when storage is available.
 */
export class Tutorial {
  private readonly learned = loadLearned();
  private readonly dashHint = element('hint-dash');
  private readonly dashArrow = element<HTMLImageElement>('hint-dash-arrow');
  private readonly dashCaption = element('hint-dash-caption');
  private readonly grabHint = element('hint-grab');

  complete(lesson: Lesson): void {
    if (this.learned.has(lesson)) return;
    this.learned.add(lesson);
    saveLearned(this.learned);
  }

  /** Pass null to hide every hint (e.g. while a menu is open). */
  update(camera: THREE.Camera, cues: TutorialCues | null): void {
    const escapeHint = cues !== null && cues.chased && cues.dashReady && !this.learned.has('escape');
    const showDash = escapeHint || (cues !== null && !this.learned.has('dash'));
    this.dashHint.classList.toggle('urgent', escapeHint);
    this.dashCaption.textContent = escapeHint ? 'dash away!' : 'dash';
    const showGrab = cues?.grabbable != null && !this.learned.has('grab');
    this.dashHint.hidden = !showDash;
    this.grabHint.hidden = !showGrab;

    if (showDash && cues) {
      const origin = toScreen(cues.player, camera);
      scratch.set(Math.sin(cues.facing), 0, Math.cos(cues.facing)).add(cues.player);
      const ahead = toScreen(scratch, camera);
      const angle = Math.atan2(ahead.y - origin.y, ahead.x - origin.x);

      place(this.dashHint, origin);
      this.dashArrow.style.transform =
        `translate(-50%, -50%) translate(${Math.cos(angle) * ARROW_OFFSET}px, ${Math.sin(angle) * ARROW_OFFSET}px) ` +
        `rotate(${angle}rad)`;
    }

    if (showGrab) {
      scratch.copy(cues.grabbable!).setY(cues.grabbable!.y + GRAB_HINT_HEIGHT);
      place(this.grabHint, toScreen(scratch, camera));
    }
  }
}

function toScreen(position: THREE.Vector3, camera: THREE.Camera): { x: number; y: number } {
  const ndc = position.clone().project(camera);
  return { x: ((ndc.x + 1) / 2) * window.innerWidth, y: ((1 - ndc.y) / 2) * window.innerHeight };
}

function place(target: HTMLElement, at: { x: number; y: number }): void {
  target.style.left = `${at.x}px`;
  target.style.top = `${at.y}px`;
}

function loadLearned(): Set<Lesson> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Lesson[];
    return new Set(stored);
  } catch {
    return new Set();
  }
}

function saveLearned(learned: Set<Lesson>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...learned]));
  } catch {
    // Storage unavailable (private mode, blocked): hints simply show again next session.
  }
}
