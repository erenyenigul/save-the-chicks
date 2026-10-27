import { element } from './dom';

const DURATION = 750;
/** The second band trails the first by this much, for a layered cartoon swipe. */
const STAGGER = 120;

/**
 * Full-screen swipe transition: skewed bands sweep in from the left until the
 * screen is covered, then carry on out to the right.
 */
export class Wipe {
  private readonly root = element('wipe');
  private readonly bands = [...this.root.children] as HTMLElement[];

  /** Sweeps in; resolves once the screen is fully covered. */
  cover(): Promise<void> {
    this.root.hidden = false;
    return this.sweep('-140%', '0%', 'cubic-bezier(0.5, 0, 0.75, 0)');
  }

  /** Sweeps out to the right; resolves once the screen is clear. */
  async reveal(): Promise<void> {
    await this.sweep('0%', '140%', 'cubic-bezier(0.25, 1, 0.5, 1)');
    this.root.hidden = true;
  }

  private async sweep(from: string, to: string, easing: string): Promise<void> {
    const animations = this.bands.map((band, i) =>
      band.animate(
        [{ transform: `translateX(${from}) skewX(-14deg)` }, { transform: `translateX(${to}) skewX(-14deg)` }],
        // Covering, the front band leads; revealing, the back band leaves last.
        { duration: DURATION, delay: i * STAGGER, easing, fill: 'forwards' },
      ),
    );
    await Promise.all(animations.map((animation) => animation.finished));
  }
}
