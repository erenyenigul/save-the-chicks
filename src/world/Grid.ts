import * as THREE from 'three/webgpu';
import PF from 'pathfinding';

/** Bresenham line between two cells, inclusive. Exists at runtime but is missing from @types/pathfinding. */
const interpolate = (PF.Util as unknown as {
  interpolate(x0: number, y0: number, x1: number, y1: number): number[][];
}).interpolate;

export interface Cell {
  col: number;
  row: number;
}

/** Stable string key for maps keyed by cell. */
export function cellKey(cell: Cell): string {
  return `${cell.col},${cell.row}`;
}

/**
 * Tile grid of the level. Cell (col, row) is centred on world (col, 0, row)
 * and spans ±0.5 on X/Z. Handles walkability, sight blocking, pathfinding
 * and circle-vs-tile collision.
 */
export class Grid {
  private readonly pathGrid: PF.Grid;
  private readonly finder = new PF.AStarFinder({
    diagonalMovement: PF.DiagonalMovement.OnlyWhenNoObstacles,
  });

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly walkable: readonly boolean[],
    private readonly opaque: readonly boolean[],
  ) {
    const matrix: number[][] = [];
    for (let row = 0; row < height; row++) {
      matrix.push(Array.from({ length: width }, (_, col) => (this.isWalkable(col, row) ? 0 : 1)));
    }
    this.pathGrid = new PF.Grid(matrix);
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.width && row < this.height;
  }

  isWalkable(col: number, row: number): boolean {
    return this.inBounds(col, row) && this.walkable[row * this.width + col];
  }

  isOpaque(col: number, row: number): boolean {
    return !this.inBounds(col, row) || this.opaque[row * this.width + col];
  }

  cellAt(position: THREE.Vector3): Cell {
    return { col: Math.round(position.x), row: Math.round(position.z) };
  }

  cellCenter(cell: Cell, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(cell.col, 0, cell.row);
  }

  /** True if no opaque cell lies strictly between the two positions. */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const a = this.cellAt(from);
    const b = this.cellAt(to);
    const line = interpolate(a.col, a.row, b.col, b.row);
    for (let i = 1; i < line.length - 1; i++) {
      if (this.isOpaque(line[i][0], line[i][1])) return false;
    }
    return true;
  }

  /** Distance along a ray on the XZ plane until it enters an opaque cell, capped at `maxDistance`. */
  raycast(origin: THREE.Vector3, dirX: number, dirZ: number, maxDistance: number, step = 0.08): number {
    for (let t = step; t < maxDistance; t += step) {
      const col = Math.round(origin.x + dirX * t);
      const row = Math.round(origin.z + dirZ * t);
      if (this.isOpaque(col, row)) return t;
    }
    return maxDistance;
  }

  /** Smoothed walkable path between two world positions; empty when unreachable. */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const a = this.nearestWalkableCell(this.cellAt(from));
    const b = this.nearestWalkableCell(this.cellAt(to));
    if (!a || !b) return [];

    const scratch = this.pathGrid.clone();
    const raw = this.finder.findPath(a.col, a.row, b.col, b.row, scratch);
    if (raw.length === 0) return [];

    // Only keep turning points. (PF.Util.smoothenPath throws in strict mode: it assigns an undeclared variable.)
    const path = PF.Util.compressPath(raw)
      .slice(1)
      .map(([col, row]) => new THREE.Vector3(col, 0, row));

    // End on the exact target rather than its cell centre, so a chaser can actually reach
    // someone standing near a cell corner. Safe: both points lie in the same walkable cell.
    const target = this.cellAt(to);
    if (target.col === b.col && target.row === b.row) {
      const exact = new THREE.Vector3(to.x, 0, to.z);
      if (path.length > 0) path[path.length - 1] = exact;
      else path.push(exact);
    }
    return path;
  }

  /** Pushes a circle at `position` out of every blocked cell it overlaps. */
  resolveCircle(position: THREE.Vector3, radius: number): void {
    const center = this.cellAt(position);
    for (let row = center.row - 1; row <= center.row + 1; row++) {
      for (let col = center.col - 1; col <= center.col + 1; col++) {
        if (this.isWalkable(col, row)) continue;

        const nearestX = THREE.MathUtils.clamp(position.x, col - 0.5, col + 0.5);
        const nearestZ = THREE.MathUtils.clamp(position.z, row - 0.5, row + 0.5);
        const dx = position.x - nearestX;
        const dz = position.z - nearestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq >= radius * radius) continue;

        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          position.x += (dx / dist) * (radius - dist);
          position.z += (dz / dist) * (radius - dist);
        } else {
          // Centre is inside the tile: eject through the closest edge.
          const left = position.x - (col - 0.5);
          const right = col + 0.5 - position.x;
          const top = position.z - (row - 0.5);
          const bottom = row + 0.5 - position.z;
          const min = Math.min(left, right, top, bottom);
          if (min === left) position.x = col - 0.5 - radius;
          else if (min === right) position.x = col + 0.5 + radius;
          else if (min === top) position.z = row - 0.5 - radius;
          else position.z = row + 0.5 + radius;
        }
      }
    }
  }

  nearestWalkableCell(cell: Cell): Cell | null {
    if (this.isWalkable(cell.col, cell.row)) return cell;
    for (let radius = 1; radius <= 2; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (this.isWalkable(cell.col + dc, cell.row + dr)) return { col: cell.col + dc, row: cell.row + dr };
        }
      }
    }
    return null;
  }
}
