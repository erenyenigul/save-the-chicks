import { Grid, type Cell } from './Grid';
import type { LevelDefinition } from './levels';

export type PropKind = 'crate' | 'crateSmall' | 'machine' | 'robotArm' | 'cone';

export interface BeltTile {
  cell: Cell;
  /** Travel direction on this tile. */
  direction: Cell;
}

/** Where a run of belt tiles delivers its chicks. */
export type BeltEnd =
  | { kind: 'grinder' | 'farm'; cell: Cell; direction: Cell }
  | { kind: 'sorter'; cell: Cell; direction: Cell; male: BeltRun; female: BeltRun };

/** Consecutive belt tiles in travel order, followed by what they feed into. */
export interface BeltRun {
  tiles: readonly BeltTile[];
  end: BeltEnd;
}

export interface BeltLine {
  hopper: Cell;
  run: BeltRun;
}

/** Parsed, validated form of a LevelDefinition's tile map. */
export interface LevelLayout {
  grid: Grid;
  walls: readonly Cell[];
  floor: readonly Cell[];
  exits: readonly Cell[];
  levers: readonly Cell[];
  props: readonly { kind: PropKind; cell: Cell }[];
  belts: readonly BeltLine[];
  playerStart: Cell;
}

interface TileTraits {
  walkable: boolean;
  opaque: boolean;
}

const TILE_TRAITS: Record<string, TileTraits> = {
  '#': { walkable: false, opaque: true },
  '.': { walkable: true, opaque: false },
  X: { walkable: true, opaque: false },
  P: { walkable: true, opaque: false },
  c: { walkable: true, opaque: false },
  L: { walkable: false, opaque: false },
  H: { walkable: false, opaque: false },
  G: { walkable: false, opaque: true },
  F: { walkable: false, opaque: true },
  S: { walkable: false, opaque: false },
  B: { walkable: false, opaque: true },
  b: { walkable: false, opaque: false },
  M: { walkable: false, opaque: true },
  R: { walkable: false, opaque: true },
  '>': { walkable: false, opaque: false },
  '<': { walkable: false, opaque: false },
  '^': { walkable: false, opaque: false },
  v: { walkable: false, opaque: false },
};

const BELT_DIRECTIONS: Record<string, Cell> = {
  '>': { col: 1, row: 0 },
  '<': { col: -1, row: 0 },
  '^': { col: 0, row: -1 },
  v: { col: 0, row: 1 },
};

const PROP_TILES: Record<string, PropKind> = {
  B: 'crate',
  b: 'crateSmall',
  M: 'machine',
  R: 'robotArm',
  c: 'cone',
};

export function parseLevel(definition: LevelDefinition): LevelLayout {
  const rows = definition.map;
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const tileAt = (col: number, row: number): string | undefined => rows[row]?.[col];

  const walkable: boolean[] = [];
  const opaque: boolean[] = [];
  const walls: Cell[] = [];
  const floor: Cell[] = [];
  const exits: Cell[] = [];
  const levers: Cell[] = [];
  const props: { kind: PropKind; cell: Cell }[] = [];
  const hoppers: Cell[] = [];
  let playerStart: Cell | null = null;

  rows.forEach((line, row) => {
    if (line.length !== width) {
      throw new Error(`Level "${definition.name}": row ${row} is ${line.length} wide, expected ${width}`);
    }
    [...line].forEach((tile, col) => {
      const traits = TILE_TRAITS[tile];
      if (!traits) throw new Error(`Level "${definition.name}": unknown tile "${tile}" at ${col},${row}`);
      walkable.push(traits.walkable);
      opaque.push(traits.opaque);

      const cell = { col, row };
      if (tile === '#') walls.push(cell);
      else floor.push(cell);

      if (tile === 'X') exits.push(cell);
      if (tile === 'L') levers.push(cell);
      if (tile === 'H') hoppers.push(cell);
      if (tile === 'P') playerStart = cell;
      const prop = PROP_TILES[tile];
      if (prop) props.push({ kind: prop, cell });
    });
  });

  if (!playerStart) throw new Error(`Level "${definition.name}" has no player start (P)`);
  if (exits.length === 0) throw new Error(`Level "${definition.name}" has no exit (X)`);

  const belts = hoppers.map((hopper) => traceBelt(definition.name, hopper, tileAt));
  assertAllBeltTilesUsed(definition.name, rows, belts);

  const grid = new Grid(width, height, walkable, opaque);
  for (const route of definition.guards) {
    for (const point of route) {
      if (!grid.isWalkable(point.col, point.row)) {
        throw new Error(`Level "${definition.name}": guard waypoint ${point.col},${point.row} is not walkable`);
      }
    }
  }

  return { grid, walls, floor, exits, levers, props, belts, playerStart };
}

type TileLookup = (col: number, row: number) => string | undefined;

const step = (cell: Cell, direction: Cell): Cell => ({ col: cell.col + direction.col, row: cell.row + direction.row });

/** Belt tiles next to `cell` whose arrows lead away from it, excluding `from`. */
function outgoingBelts(cell: Cell, tileAt: TileLookup, from?: Cell): Cell[] {
  return Object.values(BELT_DIRECTIONS)
    .map((offset) => step(cell, offset))
    .filter((next) => !(from && next.col === from.col && next.row === from.row))
    .filter((next) => {
      const direction = BELT_DIRECTIONS[tileAt(next.col, next.row) ?? ''];
      if (!direction) return false;
      const ahead = step(next, direction);
      return ahead.col !== cell.col || ahead.row !== cell.row;
    });
}

function traceBelt(levelName: string, hopper: Cell, tileAt: TileLookup): BeltLine {
  function fail(message: string): never {
    throw new Error(`Level "${levelName}": ${message}`);
  }

  const outgoing = outgoingBelts(hopper, tileAt);
  if (outgoing.length !== 1) fail(`hopper at ${hopper.col},${hopper.row} needs exactly one outgoing belt`);

  const visited = new Set<string>();
  const traceRun = (first: Cell, insideSorter: boolean): BeltRun => {
    const tiles: BeltTile[] = [];
    let cell = first;
    for (;;) {
      const key = `${cell.col},${cell.row}`;
      if (visited.has(key)) fail(`belt loops back on itself at ${key}`);
      visited.add(key);

      const symbol = tileAt(cell.col, cell.row) ?? '';
      const direction = BELT_DIRECTIONS[symbol];
      if (direction) {
        tiles.push({ cell, direction });
        cell = step(cell, direction);
        continue;
      }

      const last = tiles.at(-1);
      if (!last) fail(`belt at ${key} has no tiles before its end`);
      if (symbol === 'G' || symbol === 'F') {
        return { tiles, end: { kind: symbol === 'G' ? 'grinder' : 'farm', cell, direction: last.direction } };
      }
      if (symbol !== 'S') fail(`belt runs into "${symbol}" at ${key}; expected a belt, G, F or S`);
      if (insideSorter) fail(`sorter at ${key} feeds another sorter, which is not supported`);

      const branches = outgoingBelts(cell, tileAt, last.cell).map((next) => traceRun(next, true));
      const male = branches.find((branch) => branch.end.kind === 'grinder');
      const female = branches.find((branch) => branch.end.kind === 'farm');
      if (branches.length !== 2 || !male || !female) {
        fail(`sorter at ${key} needs one branch to a grinder (G) and one to a farm (F)`);
      }
      return { tiles, end: { kind: 'sorter', cell, direction: last.direction, male, female } };
    }
  };

  return { hopper, run: traceRun(outgoing[0], false) };
}

function beltCells(run: BeltRun): Cell[] {
  const cells = run.tiles.map((tile) => tile.cell);
  if (run.end.kind === 'sorter') cells.push(...beltCells(run.end.male), ...beltCells(run.end.female));
  return cells;
}

function assertAllBeltTilesUsed(levelName: string, rows: readonly string[], belts: readonly BeltLine[]): void {
  const used = new Set(belts.flatMap((belt) => beltCells(belt.run).map((cell) => `${cell.col},${cell.row}`)));
  rows.forEach((line, row) =>
    [...line].forEach((tile, col) => {
      if (tile in BELT_DIRECTIONS && !used.has(`${col},${row}`)) {
        throw new Error(`Level "${levelName}": belt tile at ${col},${row} is not connected to a hopper`);
      }
    }),
  );
}

/** Unit step leading out of the map from a border cell (used for exits). */
export function outwardDirection(cell: Cell, grid: Grid): Cell {
  if (cell.col === 0) return { col: -1, row: 0 };
  if (cell.col === grid.width - 1) return { col: 1, row: 0 };
  if (cell.row === 0) return { col: 0, row: -1 };
  if (cell.row === grid.height - 1) return { col: 0, row: 1 };
  return { col: 0, row: 0 };
}
