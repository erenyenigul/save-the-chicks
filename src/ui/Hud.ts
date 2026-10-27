import { element } from './dom';

export interface HudState {
  levelLabel: string;
  saved: number;
  chicksToSave: number;
  lost: number;
  maxLost: number;
  following: number;
  captured: number;
  remaining: number;
  /** 0 = just used, 1 = ready. */
  leverCharge: number;
  dashCharge: number;
  beltsStopped: boolean;
  alert: boolean;
  prompt: string | null;
}

/** In-game overlay. Writes to the DOM only when a value changes. */
export class Hud {
  private readonly root = element('hud');
  private readonly level = element('hud-level');
  private readonly saved = element('hud-saved');
  private readonly lost = element('hud-lost');
  private readonly following = element('hud-following');
  private readonly captured = element('hud-captured');
  private readonly capturedTile = element('hud-captured-tile');
  private readonly remaining = element('hud-remaining');
  private readonly leverFill = element('hud-lever-fill');
  private readonly dashFill = element('hud-dash-fill');
  private readonly alert = element('hud-alert');
  private readonly danger = element('hud-danger');
  private readonly prompt = element('hud-prompt');
  private readonly backend = element('hud-backend');
  private readonly cache = new Map<string, string | boolean>();

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setBackend(label: string): void {
    this.backend.textContent = label;
  }

  update(state: HudState): void {
    this.text(this.level, state.levelLabel);
    this.text(this.saved, `${state.saved}/${state.chicksToSave}`);
    this.text(this.lost, `${state.lost}/${state.maxLost}`);
    this.text(this.following, String(state.following));
    this.text(this.captured, String(state.captured));
    this.toggle(this.capturedTile, 'hidden', state.captured === 0);
    this.text(this.remaining, String(state.remaining));
    this.text(this.prompt, state.prompt ?? '');
    this.toggle(this.prompt, 'hidden', state.prompt === null);
    this.toggle(this.alert, 'hidden', !state.alert);
    this.toggle(this.danger, 'hidden', !state.alert);
    this.toggle(this.leverFill, 'active', state.beltsStopped);
    this.toggle(this.dashFill, 'active', state.dashCharge >= 1);
    this.leverFill.style.setProperty('--value', state.leverCharge.toFixed(3));
    this.dashFill.style.setProperty('--value', state.dashCharge.toFixed(3));
  }

  private text(target: HTMLElement, value: string): void {
    if (this.cache.get(target.id) === value) return;
    this.cache.set(target.id, value);
    target.textContent = value;
  }

  private toggle(target: HTMLElement, flag: 'hidden' | 'active', on: boolean): void {
    const key = `${target.id}:${flag}`;
    if (this.cache.get(key) === on) return;
    this.cache.set(key, on);
    if (flag === 'hidden') target.hidden = on;
    else target.classList.toggle(flag, on);
  }
}
