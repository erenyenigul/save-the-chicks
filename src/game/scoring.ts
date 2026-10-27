import type { LevelRules } from '../world/levels';
import type { LevelStats } from './Game';

export interface ScoreLine {
  label: string;
  points: number;
}

export interface Score {
  total: number;
  /** 0 for a lost level; otherwise 1–3. */
  stars: number;
  lines: ScoreLine[];
}

const POINTS = {
  perSaved: 100,
  /** Extra for each chick still with the player when the level was won. */
  perEscapedAtEnd: 50,
  perLost: -30,
  neverSpotted: 500,
  perSecondUnderPar: 5,
};

/**
 * Stars: one for winning, one for losing at most half the allowed chicks,
 * one for never being spotted.
 */
export function scoreLevel(stats: LevelStats, rules: LevelRules, won: boolean): Score {
  const lost = stats.ground + stats.caged;
  const lines: ScoreLine[] = [
    { label: `${stats.saved} chicks saved`, points: stats.saved * POINTS.perSaved },
  ];
  if (stats.escapedAtEnd > 0) {
    lines.push({ label: `${stats.escapedAtEnd} ran out with you`, points: stats.escapedAtEnd * POINTS.perEscapedAtEnd });
  }
  if (lost > 0) lines.push({ label: `${lost} chicks lost`, points: lost * POINTS.perLost });
  if (won && stats.timesSpotted === 0) lines.push({ label: 'Never spotted', points: POINTS.neverSpotted });
  const underPar = Math.floor(rules.parSeconds - stats.seconds);
  if (won && underPar > 0) lines.push({ label: 'Speed bonus', points: underPar * POINTS.perSecondUnderPar });

  const total = Math.max(0, lines.reduce((sum, line) => sum + line.points, 0));
  const stars = won ? 1 + Number(lost <= rules.maxLost / 2) + Number(stats.timesSpotted === 0) : 0;
  return { total, stars, lines };
}
