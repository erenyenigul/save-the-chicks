import type { LevelStats } from '../game/Game';
import type { LevelRecord } from '../game/Progress';
import type { Score } from '../game/scoring';
import { element } from './dom';

export interface LevelEntry {
  name: string;
  unlocked: boolean;
  record: LevelRecord | undefined;
}

export interface OverlayAction {
  label: string;
  onClick: () => void;
  secondary?: boolean;
}

export interface ResultView {
  title: string;
  reason: string;
  won: boolean;
  score: Score;
  stats: LevelStats;
  newBest: boolean;
  previousBest: number;
}

const MAX_STARS = 3;

/** The menu / result panel shown over the game. */
export class Overlay {
  private readonly root = element('overlay');
  private readonly title = element('overlay-title');
  private readonly text = element('overlay-text');
  private readonly body = element('overlay-body');
  private readonly controls = element('overlay-controls');
  private readonly actions = element('overlay-actions');
  private readonly loading = element<HTMLButtonElement>('overlay-button');
  private readonly intro = this.text.textContent ?? '';

  constructor(private readonly onButton: () => void = () => {}) {}

  get hidden(): boolean {
    return this.root.hidden;
  }

  setLoading(loaded: number, total: number): void {
    this.loading.textContent = `Loading… ${loaded}/${total}`;
  }

  showMenu(levels: readonly LevelEntry[], suggested: number, onPlay: (index: number) => void): void {
    this.title.textContent = 'Coop Breakout';
    this.text.hidden = false;
    this.text.textContent = this.intro;
    this.controls.hidden = false;

    const list = make('ol', 'level-list');
    levels.forEach((level, index) => {
      const row = make('button', 'tile level-row');
      row.type = 'button';
      row.disabled = !level.unlocked;
      row.append(
        make('span', 'level-number', String(index + 1)),
        make('span', 'level-name', level.name),
        level.unlocked ? starsElement(level.record?.bestStars ?? 0) : make('span', 'level-locked', 'Locked'),
        make('span', 'level-best', level.record?.bestScore ? `Best ${formatPoints(level.record.bestScore)}` : ''),
      );
      row.onclick = () => this.choose(() => onPlay(index));
      const item = make('li');
      item.append(row);
      list.append(item);
    });
    this.body.replaceChildren(list);

    const anyPlayed = levels.some((level) => level.record);
    this.setActions([
      { label: anyPlayed ? `Continue: ${levels[suggested].name}` : 'Start', onClick: () => onPlay(suggested) },
    ]);
  }

  showResult(view: ResultView, actions: readonly OverlayAction[]): void {
    this.title.textContent = view.title;
    this.text.hidden = false;
    this.text.textContent = view.reason;
    this.controls.hidden = true;

    const summary = make('div', 'result-summary');
    summary.append(starsElement(view.score.stars, 'stars-large'));
    const total = make('div', 'result-total', formatPoints(view.score.total));
    total.append(make('span', 'result-total-label', ' points'));
    summary.append(total);
    if (view.newBest) summary.append(make('div', 'badge-best', 'New best!'));
    else if (view.won && view.previousBest > 0) {
      summary.append(make('div', 'result-previous', `Best: ${formatPoints(view.previousBest)}`));
    }

    const breakdown = make('table', 'result-breakdown');
    for (const line of view.score.lines) {
      const row = make('tr');
      row.append(make('td', '', line.label), make('td', line.points < 0 ? 'negative' : '', signed(line.points)));
      breakdown.append(row);
    }

    const { stats } = view;
    const facts = make('dl', 'result-facts');
    const fact = (label: string, value: string): void => facts.append(make('dt', '', label), make('dd', '', value));
    fact('Time', formatTime(stats.seconds));
    fact('Times spotted', String(stats.timesSpotted));
    fact('Ground up', String(stats.ground));
    fact('Caged', String(stats.caged));
    fact('Taken by guards', String(stats.taken));
    if (stats.heldByGuards > 0) fact('Still held by guards', String(stats.heldByGuards));

    this.body.replaceChildren(summary, breakdown, facts);
    this.setActions(actions);
  }

  showError(message: string): void {
    this.title.textContent = 'Something went wrong';
    this.text.hidden = false;
    this.text.textContent = message;
    this.text.style.whiteSpace = 'pre-line';
    this.body.replaceChildren();
    this.controls.hidden = true;
    this.actions.replaceChildren();
    this.root.hidden = false;
  }

  private setActions(actions: readonly OverlayAction[]): void {
    const buttons = actions.map((action) => {
      const button = make('button', action.secondary ? 'button-secondary' : 'button-primary', action.label);
      button.type = 'button';
      button.onclick = () => this.choose(action.onClick);
      return button;
    });
    this.actions.replaceChildren(...buttons);
    this.root.hidden = false;
    buttons[0]?.focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** Buttons only report the choice; the caller decides when the overlay goes (e.g. under a wipe). */
  private choose(onClick: () => void): void {
    this.onButton();
    onClick();
  }
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function starsElement(count: number, extraClass = ''): HTMLElement {
  const stars = make('span', `stars ${extraClass}`.trim());
  stars.setAttribute('aria-label', `${count} of ${MAX_STARS} stars`);
  for (let i = 0; i < MAX_STARS; i++) stars.append(make('span', i < count ? 'star filled' : 'star', '★'));
  return stars;
}

function formatPoints(points: number): string {
  return points.toLocaleString('en-US');
}

function signed(points: number): string {
  return points >= 0 ? `+${formatPoints(points)}` : `−${formatPoints(-points)}`;
}

function formatTime(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
