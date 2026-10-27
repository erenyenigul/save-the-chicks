import type { Cell } from './Grid';

export interface LevelRules {
  /** Finishing faster than this earns a time bonus. */
  parSeconds: number;
  /** Chicks the hoppers will drop over the whole level. */
  totalChicks: number;
  /** Chicks that must reach the exit to win. */
  chicksToSave: number;
  /** Level is lost once this many chicks reach a grinder. */
  maxLost: number;
  /** Belt speed in tiles per second. */
  beltSpeed: number;
  /** Seconds between drops at the start and at the end of the level. */
  spawnInterval: { start: number; end: number };
}

export interface LevelDefinition {
  /** Stable key for saved progress; never change it once shipped. */
  id: string;
  name: string;
  /**
   * Top-down tile map, one string per row.
   *   #  wall            .  floor           X  exit
   *   P  player start    L  emergency lever
   *   H  hopper; a belt starts next to it and runs (> < ^ v) into a grinder G
   *   S  sorter: scans each chick and splits the belt — males to a grinder G,
   *      females on to an egg farm F
   *   B  large crate (blocks sight)          b  small crate (low, see-through)
   *   M  machine         R  robot arm        c  traffic cone
   */
  map: readonly string[];
  /** Patrol loops, as walkable cells visited in order. */
  guards: readonly (readonly Cell[])[];
  rules: LevelRules;
}

const cell = (col: number, row: number): Cell => ({ col, row });

export const LEVELS: readonly LevelDefinition[] = [
  {
    id: 'processing-hall',
    name: 'Processing Hall',
    map: [
      '##################################',
      '#c.......B.............b........c#',
      '#..H>>>>>>>>>>>>>>>>>>>>>>>G..R..#',
      '#................................#',
      '#.....BB.......M.......BB.......L#',
      '#................................#',
      'X.......b...H>>>>>>>>>>>>>G..R...#',
      'X..P.............................#',
      'X.......b.......M........BB......#',
      '#................................#',
      '#..H>>>>>>>>>>>>>>>>>>>>>>>G..R..#',
      '#c.......b.............B........c#',
      '##################################',
    ],
    guards: [
      [cell(5, 3), cell(28, 3)],
      [cell(28, 9), cell(10, 9)],
      [cell(31, 1), cell(31, 11)],
    ],
    rules: {
      parSeconds: 120,
      totalChicks: 24,
      chicksToSave: 12,
      maxLost: 10,
      beltSpeed: 0.55,
      spawnInterval: { start: 3.2, end: 2.0 },
    },
  },
  {
    id: 'sorting-floor',
    name: 'Sorting Floor',
    map: [
      '####################################',
      '#c..........B.........b...........c#',
      '#..H>>>>>>>>>>>>S>>>>>>>>>>>>>F....#',
      '#...............v..................#',
      '#..b.....BB.....v.....M.....BB.....#',
      '#...............G..................#',
      '#..................................#',
      'X.....b.....H>>>>>>>>S>>>>>>>>F..L.#',
      'X..P.................v.............#',
      'X.........BB.........G......b......#',
      '#..................................#',
      '#...............G..................#',
      '#..b.....BB.....^.....M.....BB.....#',
      '#...............^..................#',
      '#..H>>>>>>>>>>>>S>>>>>>>>>>>>>F....#',
      '#c..........B.........b...........c#',
      '####################################',
    ],
    guards: [
      [cell(6, 6), cell(32, 6)],
      [cell(32, 10), cell(8, 10)],
      [cell(26, 3), cell(33, 3), cell(33, 13), cell(26, 13)],
    ],
    rules: {
      parSeconds: 150,
      totalChicks: 30,
      chicksToSave: 14,
      maxLost: 12,
      beltSpeed: 0.6,
      spawnInterval: { start: 3.0, end: 1.8 },
    },
  },
];
