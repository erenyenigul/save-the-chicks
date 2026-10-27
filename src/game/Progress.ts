import type { LevelDefinition } from '../world/levels';

export interface LevelRecord {
  completed: boolean;
  attempts: number;
  bestScore: number;
  bestStars: number;
  bestSaved: number;
  /** Fastest win, in seconds. */
  bestSeconds: number | null;
}

interface SaveData {
  version: 1;
  levels: Record<string, LevelRecord>;
  muted: boolean;
}

const STORAGE_KEY = 'coop-breakout:save';

const emptySave = (): SaveData => ({ version: 1, levels: {}, muted: false });

/** Per-level records and settings, persisted to localStorage when it is available. */
export class Progress {
  private constructor(private readonly data: SaveData) {}

  static load(): Progress {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<SaveData>) : null;
      if (parsed?.version === 1 && parsed.levels) return new Progress({ ...emptySave(), ...parsed } as SaveData);
    } catch {
      // Unreadable or blocked storage: start fresh.
    }
    return new Progress(emptySave());
  }

  get muted(): boolean {
    return this.data.muted;
  }

  set muted(value: boolean) {
    this.data.muted = value;
    this.save();
  }

  record(level: LevelDefinition): LevelRecord | undefined {
    return this.data.levels[level.id];
  }

  /** The first level is always open; each later one opens when the previous is completed. */
  isUnlocked(levels: readonly LevelDefinition[], index: number): boolean {
    return index === 0 || this.record(levels[index - 1])?.completed === true;
  }

  /** First unlocked level not yet completed, or the last level if everything is done. */
  nextLevelIndex(levels: readonly LevelDefinition[]): number {
    const index = levels.findIndex((level, i) => this.isUnlocked(levels, i) && !this.record(level)?.completed);
    return index >= 0 ? index : levels.length - 1;
  }

  /** Stores an attempt. Returns whether it beat the previous best score. */
  addAttempt(
    level: LevelDefinition,
    result: { won: boolean; score: number; stars: number; saved: number; seconds: number },
  ): { newBest: boolean; previousBest: number } {
    const previous: LevelRecord = this.record(level) ?? {
      completed: false,
      attempts: 0,
      bestScore: 0,
      bestStars: 0,
      bestSaved: 0,
      bestSeconds: null,
    };
    const newBest = result.won && result.score > previous.bestScore;
    this.data.levels[level.id] = {
      completed: previous.completed || result.won,
      attempts: previous.attempts + 1,
      bestScore: result.won ? Math.max(previous.bestScore, result.score) : previous.bestScore,
      bestStars: Math.max(previous.bestStars, result.stars),
      bestSaved: Math.max(previous.bestSaved, result.saved),
      bestSeconds:
        result.won && (previous.bestSeconds === null || result.seconds < previous.bestSeconds)
          ? result.seconds
          : previous.bestSeconds,
    };
    this.save();
    return { newBest, previousBest: previous.bestScore };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable: progress lasts for this session only.
    }
  }
}
