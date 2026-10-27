export type Action = 'up' | 'down' | 'left' | 'right' | 'dash' | 'interact' | 'mute';

const BINDINGS: Record<string, Action> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyM: 'mute',
  KeyE: 'interact',
  Space: 'interact',
};

/**
 * Keyboard state mapped to game actions. `pressed` is edge-triggered and
 * must be cleared once per frame with `endFrame()`.
 */
export class Input {
  private readonly held = new Set<Action>();
  private readonly pressedThisFrame = new Set<Action>();

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  wasPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  /** Movement intent on the ground plane: x = right, y = down (screen space), length ≤ 1. */
  moveAxis(): { x: number; y: number } {
    const x = Number(this.isHeld('right')) - Number(this.isHeld('left'));
    const y = Number(this.isHeld('down')) - Number(this.isHeld('up'));
    const length = Math.hypot(x, y);
    return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  }

  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const action = BINDINGS[event.code];
    if (!action) return;
    event.preventDefault();
    if (!event.repeat) this.pressedThisFrame.add(action);
    this.held.add(action);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const action = BINDINGS[event.code];
    if (action) this.held.delete(action);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };
}
