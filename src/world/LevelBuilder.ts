import * as THREE from 'three/webgpu';
import type { Assets, ModelId, ModelInstance } from '../core/Assets';
import { yawFromDirection } from '../core/math';
import { cellKey, type Cell, type Grid } from './Grid';
import { outwardDirection, type BeltRun, type BeltTile, type LevelLayout, type PropKind } from './LevelLayout';

export const WALL_HEIGHT = 1.1;
const WALL_CAP_HEIGHT = 0.08;
/** Muted red brick, with a lighter coping (from the top-down camera the coping is most of what you see). */
const WALL_COLOR = 0x8f5446;
const WALL_CAP_COLOR = 0xa86a5a;

const PROP_MODELS: Record<PropKind, ModelId> = {
  crate: 'crate',
  crateSmall: 'crateSmall',
  machine: 'machine',
  robotArm: 'robotArm',
  cone: 'cone',
};

const ROBOT_ARM_SCALE = 0.55;
const STOP_BUTTON_SCALE = 2;
/** Height of the wall-mounted button's centre. */
const STOP_BUTTON_HEIGHT = 0.65;
/**
 * How far the button face tilts up from pointing straight out of the wall. Facing fully
 * sideways it would be edge-on to the top-down camera; tilted, it reads like a control panel.
 */
const STOP_BUTTON_TILT = THREE.MathUtils.degToRad(0);
/** The status tube is the kit's 2-long glass pipe, stretched along the wall and slimmed. */
const STATUS_TUBE_SCALE = new THREE.Vector3(1.2, 0.5, 0.5);

/** Yaw that turns a model's authored facing to +Z, so `yawFromDirection` can aim it. */
const AUTHORED_FACING = {
  conveyor: -Math.PI / 2, // belt runs along X
  machine: -Math.PI / 2, // grinder / farm intake on +X
  scanner: -Math.PI / 2, // belt passes through along X
  exitMarker: Math.PI / 2, // arrow points to -X
};

export interface StopStation {
  /** The push button; its cap is the child named "button". */
  button: ModelInstance;
  /** Glass tube on the wall beside the button; its liquid shows the stop's state. Runs along local X. */
  tube: THREE.Object3D;
}

/** Scene objects the simulation needs to animate after the level is built. */
export interface LevelScene {
  root: THREE.Group;
  /** Grinders, farms and scanners, keyed by `cellKey` of their tile. */
  machines: ReadonlyMap<string, THREE.Object3D>;
  stopStations: readonly StopStation[];
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

  const place = (id: ModelId, placement: Placement): ModelInstance => {
    const instance = assets.instantiate(id);
    instance.root.position.set(placement.cell.col, placement.y ?? 0, placement.cell.row);
    instance.root.rotation.y = placement.yaw ?? 0;
    instance.root.scale.setScalar(placement.scale ?? 1);
    root.add(instance.root);
    return instance;
  };
  const addUnique = (id: ModelId, placement: Placement): THREE.Object3D => place(id, placement).root;

  // Floor and exit markings.
  addInstanced('floor', layout.floor.map((cell) => ({ cell })));
  addInstanced('exitMarker', layout.exits.map((cell) => ({ cell, y: 0.01, yaw: exitArrowYaw(cell, layout.grid) })));

  // Walls are plain blocks; the kit's wall pieces are designed for interiors seen from eye level.
  const addBlocks = (height: number, y: number, color: number): void => {
    const geometry = new THREE.BoxGeometry(1, height, 1);
    geometry.translate(0, y + height / 2, 0);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    owned.push(geometry, material);
    const mesh = new THREE.InstancedMesh(geometry, material, layout.walls.length);
    const matrix = new THREE.Matrix4();
    layout.walls.forEach((cell, i) => mesh.setMatrixAt(i, matrix.makeTranslation(cell.col, 0, cell.row)));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    instanced.push(mesh);
    root.add(mesh);
  };
  addBlocks(WALL_HEIGHT, 0, WALL_COLOR);
  addBlocks(WALL_CAP_HEIGHT, WALL_HEIGHT, WALL_CAP_COLOR);

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

  // Emergency stops: a push button on the wall, and a status tube lying along the top of that wall.
  const stopStations = layout.stopButtons.map(({ cell, wallSide }) => {
    const button = place('stopButton', { cell, scale: STOP_BUTTON_SCALE });
    // The kit's button faces up (+Y); turn it to face out of the wall into the room, tilted upward.
    const facing = new THREE.Vector3(-wallSide.col, 0, -wallSide.row)
      .multiplyScalar(Math.cos(STOP_BUTTON_TILT))
      .setY(Math.sin(STOP_BUTTON_TILT));
    button.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), facing);
    button.root.position.set(cell.col + wallSide.col * 0.5, STOP_BUTTON_HEIGHT, cell.row + wallSide.row * 0.5);
    const wall = { col: cell.col + wallSide.col, row: cell.row + wallSide.row };
    // The tube runs along the wall, i.e. across the direction from the button to the wall.
    const tube = addUnique('statusTube', {
      cell: wall,
      y: WALL_HEIGHT + WALL_CAP_HEIGHT,
      yaw: wallSide.col !== 0 ? Math.PI / 2 : 0,
    });
    tube.scale.copy(STATUS_TUBE_SCALE);
    return { button, tube };
  });

  return {
    root,
    machines,
    stopStations,
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
