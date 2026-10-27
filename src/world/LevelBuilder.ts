import * as THREE from 'three/webgpu';
import type { Assets, ModelId } from '../core/Assets';
import { yawFromDirection } from '../core/math';
import { cellKey, type Cell, type Grid } from './Grid';
import { outwardDirection, type BeltRun, type BeltTile, type LevelLayout, type PropKind } from './LevelLayout';

export const WALL_HEIGHT = 1.1;

const PROP_MODELS: Record<PropKind, ModelId> = {
  crate: 'crate',
  crateSmall: 'crateSmall',
  machine: 'machine',
  robotArm: 'robotArm',
  cone: 'cone',
};

const ROBOT_ARM_SCALE = 0.55;
const LEVER_SCALE = 1.8;

/** Yaw that turns a model's authored facing to +Z, so `yawFromDirection` can aim it. */
const AUTHORED_FACING = {
  conveyor: -Math.PI / 2, // belt runs along X
  machine: -Math.PI / 2, // grinder / farm intake on +X
  scanner: -Math.PI / 2, // belt passes through along X
  exitMarker: Math.PI / 2, // arrow points to -X
};

/** Scene objects the simulation needs to animate after the level is built. */
export interface LevelScene {
  root: THREE.Group;
  /** Grinders, farms and scanners, keyed by `cellKey` of their tile. */
  machines: ReadonlyMap<string, THREE.Object3D>;
  levers: readonly THREE.Object3D[];
  dispose(): void;
}

interface Placement {
  cell: Cell;
  yaw?: number;
  y?: number;
  scale?: number;
}

/** Turns a parsed layout into renderable geometry. Static, repeated props are GPU-instanced. */
export function buildLevelScene(layout: LevelLayout, assets: Assets): LevelScene {
  const root = new THREE.Group();
  root.name = 'level';
  const instanced: THREE.InstancedMesh[] = [];
  const owned: { dispose(): void }[] = [];

  const addInstanced = (id: ModelId, placements: readonly Placement[]): void => {
    if (placements.length === 0) return;
    const transform = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (const part of assets.instanceParts(id)) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
      placements.forEach((p, i) => {
        position.set(p.cell.col, p.y ?? 0, p.cell.row);
        rotation.setFromAxisAngle(up, p.yaw ?? 0);
        scale.setScalar(p.scale ?? 1);
        transform.compose(position, rotation, scale).multiply(part.matrix);
        mesh.setMatrixAt(i, transform);
      });
      mesh.castShadow = id !== 'floor' && id !== 'exitMarker';
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      instanced.push(mesh);
      root.add(mesh);
    }
  };

  const addUnique = (id: ModelId, placement: Placement): THREE.Object3D => {
    const { root: object } = assets.instantiate(id);
    object.position.set(placement.cell.col, placement.y ?? 0, placement.cell.row);
    object.rotation.y = placement.yaw ?? 0;
    object.scale.setScalar(placement.scale ?? 1);
    root.add(object);
    return object;
  };

  // Floor and exit markings.
  addInstanced('floor', layout.floor.map((cell) => ({ cell })));
  addInstanced('exitMarker', layout.exits.map((cell) => ({ cell, y: 0.01, yaw: exitArrowYaw(cell, layout.grid) })));

  // Walls are plain blocks; the kit's wall pieces are designed for interiors seen from eye level.
  const wallGeometry = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
  wallGeometry.translate(0, WALL_HEIGHT / 2, 0);
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4278, roughness: 0.85 });
  owned.push(wallGeometry, wallMaterial);
  const walls = new THREE.InstancedMesh(wallGeometry, wallMaterial, layout.walls.length);
  const wallMatrix = new THREE.Matrix4();
  layout.walls.forEach((cell, i) => walls.setMatrixAt(i, wallMatrix.makeTranslation(cell.col, 0, cell.row)));
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.computeBoundingSphere();
  instanced.push(walls);
  root.add(walls);

  // Props.
  const byKind = new Map<PropKind, Placement[]>();
  for (const { kind, cell } of layout.props) {
    const placements = byKind.get(kind) ?? [];
    placements.push({
      cell,
      yaw: kind === 'robotArm' ? 0 : propYaw(cell),
      scale: kind === 'robotArm' ? ROBOT_ARM_SCALE : 1,
    });
    byKind.set(kind, placements);
  }
  for (const [kind, placements] of byKind) addInstanced(PROP_MODELS[kind], placements);

  // Belts: hoppers, conveyor tiles and whatever each run feeds into.
  const machines = new Map<string, THREE.Object3D>();
  const beltTiles: BeltTile[] = [];
  const addRun = (run: BeltRun): void => {
    beltTiles.push(...run.tiles);
    const { end } = run;
    if (end.kind === 'sorter') {
      // The sorter tile is a belt piece with the scanner gate over it.
      beltTiles.push({ cell: end.cell, direction: end.direction });
      machines.set(cellKey(end.cell), addUnique('scanner', { cell: end.cell, yaw: beltYaw(end.direction, 'scanner') }));
      addRun(end.male);
      addRun(end.female);
    } else {
      const intake = { col: -end.direction.col, row: -end.direction.row };
      machines.set(
        cellKey(end.cell),
        addUnique(end.kind === 'grinder' ? 'grinder' : 'farm', { cell: end.cell, yaw: beltYaw(intake, 'machine') }),
      );
    }
  };
  for (const belt of layout.belts) {
    addUnique('hopper', { cell: belt.hopper });
    addRun(belt.run);
  }
  addInstanced(
    'conveyor',
    beltTiles.map((tile) => ({ cell: tile.cell, yaw: beltYaw(tile.direction, 'conveyor') })),
  );

  const levers = layout.levers.map((cell) => addUnique('lever', { cell, yaw: Math.PI / 2, scale: LEVER_SCALE }));

  return {
    root,
    machines,
    levers,
    dispose() {
      root.removeFromParent();
      for (const mesh of instanced) mesh.dispose();
      for (const resource of owned) resource.dispose();
    },
  };
}

function beltYaw(direction: Cell, model: keyof typeof AUTHORED_FACING): number {
  return yawFromDirection(direction.col, direction.row) + AUTHORED_FACING[model];
}

/** Deterministic per-cell variation so repeated props don't look stamped. */
function propYaw(cell: Cell): number {
  const hash = (cell.col * 73856093) ^ (cell.row * 19349663);
  return (Math.abs(hash) % 4) * (Math.PI / 2);
}

function exitArrowYaw(cell: Cell, grid: Grid): number {
  const out = outwardDirection(cell, grid);
  return yawFromDirection(out.col, out.row) + AUTHORED_FACING.exitMarker;
}
