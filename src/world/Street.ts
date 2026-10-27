import * as THREE from 'three/webgpu';
import type { Assets, ModelId } from '../core/Assets';
import { Animator } from '../core/Animator';
import { yawFromDirection } from '../core/math';
import type { Cell } from './Grid';
import { outwardDirection, type LevelLayout } from './LevelLayout';

/** City Kit pieces are authored at 1 unit per road tile; this makes a two-lane road ~4 tiles wide. */
const CITY_SCALE = 4;
const CHARACTER_SCALE = 1.5;
/** Road tiles are authored with their lanes along X; turn them to run along the street. */
const ROAD_TILE_YAW = Math.PI / 2;
/** How far the street runs past each end of the factory wall. */
const STREET_OVERHANG = 18;
/** Top of the sidewalk tiles (authored 0.02 high); things standing on them sit here. */
export const SIDEWALK_HEIGHT = 0.02 * CITY_SCALE;
/** Street lights are authored with the lamp arm pointing to -X. */
const STREET_LIGHT_YAW = -Math.PI / 2;

/** Passers-by notice a chick this close, stop, and wait until it is this far away again. */
const NOTICE_DISTANCE = 2.6;
const FORGET_DISTANCE = 3.2;
const SURPRISE_DURATION = 0.7;
const LINGER_DURATION = 0.8;

/** Sidewalks are half a City Kit tile wide, so the shops across the road stay in view. */
const SIDEWALK_WIDTH = CITY_SCALE / 2;

/**
 * Street cross-section, in tiles outward from the factory's exit wall:
 * near sidewalk | road (two lanes) | far sidewalk | shops.
 */
const SECTION = {
  nearSidewalk: SIDEWALK_WIDTH / 2,
  road: SIDEWALK_WIDTH + CITY_SCALE / 2,
  farSidewalk: SIDEWALK_WIDTH * 1.5 + CITY_SCALE,
  shops: SIDEWALK_WIDTH * 2 + CITY_SCALE + 2.4,
  curb: SIDEWALK_WIDTH - 0.2,
  lanes: [
    { offset: SIDEWALK_WIDTH + 1, direction: 1 },
    { offset: SIDEWALK_WIDTH + 3, direction: -1 },
  ],
  footpaths: [
    { offset: 0.5, direction: 1 },
    { offset: 1.5, direction: -1 },
    { offset: SIDEWALK_WIDTH + CITY_SCALE + 0.9, direction: 1 },
    { offset: SIDEWALK_WIDTH + CITY_SCALE + 1.6, direction: -1 },
  ],
};

const SHOPS: ModelId[] = ['shopA', 'shopB', 'shopC', 'shopD', 'shopE', 'shopF', 'shopG', 'shopH'];
const CARS: ModelId[] = ['sedan', 'taxi', 'van', 'delivery', 'suv', 'hatchback'];
const PASSERSBY: ModelId[] = ['passerbyA', 'passerbyB', 'passerbyC', 'passerbyD', 'passerbyE', 'passerbyF'];
const YARD_PROPS: ModelId[] = ['containerA', 'tank', 'containerB', 'warehouse', 'containerC', 'chimney'];

const CARS_PER_LANE = 2;
const PEOPLE_PER_FOOTPATH = 2;

export interface StreetScene {
  root: THREE.Group;
  /** `chicks`: world positions of chicks loose outside, which passers-by react to. */
  update(dt: number, chicks: readonly THREE.Vector3[]): void;
  dispose(): void;
}

interface Car {
  object: THREE.Object3D;
  speed: number;
  direction: number;
}

type PasserbyClip = 'walk' | 'idle' | 'jump';

/**
 * walking  strolling along the footpath
 * startled a chick ran by: a surprised hop, then standing still watching it
 */
interface Passerby {
  object: THREE.Object3D;
  speed: number;
  direction: number;
  animator: Animator<PasserbyClip>;
  state: { kind: 'walking' } | { kind: 'startled'; surprise: number; linger: number };
}

/**
 * The world outside: a street with sidewalks, shops and traffic along the wall
 * that has the exits, and an industrial yard around the other walls.
 */
export function buildStreet(layout: LevelLayout, assets: Assets): StreetScene {
  const root = new THREE.Group();
  root.name = 'outside';
  const random = seededRandom(layout.grid.width * 31 + layout.grid.height);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  const frame = streetFrame(layout);
  const street = new THREE.Group();
  street.position.copy(frame.origin);
  street.rotation.y = frame.yaw;
  root.add(street);

  const place = (
    id: ModelId,
    u: number,
    v: number,
    options: { yaw?: number; scale?: number; widthScale?: number; y?: number } = {},
  ) => {
    const { root: object } = assets.instantiate(id);
    object.position.set(u, options.y ?? 0, v);
    object.rotation.y = options.yaw ?? 0;
    object.scale.setScalar(options.scale ?? CITY_SCALE);
    if (options.widthScale !== undefined) object.scale.x = options.widthScale;
    street.add(object);
    return object;
  };

  // Ground: sidewalks and road, tiled along the street.
  const halfLength = frame.halfLength;
  for (let v = -halfLength; v <= halfLength; v += CITY_SCALE) {
    place('sidewalk', SECTION.nearSidewalk, v, { widthScale: SIDEWALK_WIDTH });
    place('road', SECTION.road, v, { yaw: ROAD_TILE_YAW });
    place('sidewalk', SECTION.farSidewalk, v, { widthScale: SIDEWALK_WIDTH });
  }

  // Street furniture.
  const facingRoad = yawFromDirection(1, 0);
  for (let v = -halfLength + 4; v <= halfLength; v += 10) {
    // Lamps and the sign stand on the curb edge, clear of the chicks' and walkers' path.
    place('streetLight', SECTION.curb, v, { yaw: STREET_LIGHT_YAW, y: SIDEWALK_HEIGHT });
    const treeU = SECTION.farSidewalk - SIDEWALK_WIDTH / 2 + 0.3;
    place(random() < 0.5 ? 'tree' : 'treeSmall', treeU, v + 5, { y: SIDEWALK_HEIGHT });
  }
  place('streetSign', SECTION.curb, frame.wallHalfLength + 3, { yaw: facingRoad, y: SIDEWALK_HEIGHT });

  // Shops across the road, facing it.
  const facingFactory = yawFromDirection(-1, 0);
  for (let v = -halfLength; v <= halfLength; v += 4.4) {
    place(pick(SHOPS), SECTION.shops, v, { yaw: facingFactory });
  }

  // Traffic and people.
  const cars: Car[] = [];
  for (const lane of SECTION.lanes) {
    const speed = 5 + random() * 3;
    for (let i = 0; i < CARS_PER_LANE; i++) {
      const v = -halfLength + ((i + random() * 0.5) / CARS_PER_LANE) * halfLength * 2;
      const object = place(pick(CARS), lane.offset, v, { yaw: yawFromDirection(0, lane.direction), scale: 1 });
      cars.push({ object, speed, direction: lane.direction });
    }
  }
  const people: Passerby[] = [];
  for (const path of SECTION.footpaths) {
    for (let i = 0; i < PEOPLE_PER_FOOTPATH; i++) {
      const v = -halfLength + random() * halfLength * 2;
      const { root: object, animations } = assets.instantiate(pick(PASSERSBY));
      object.position.set(path.offset, SIDEWALK_HEIGHT, v);
      object.rotation.y = yawFromDirection(0, path.direction);
      object.scale.setScalar(CHARACTER_SCALE);
      street.add(object);
      const speed = 1.1 + random() * 0.6;
      const animator = new Animator<PasserbyClip>(object, animations);
      animator.play('walk', { timeScale: speed / 1.3 });
      people.push({ object, speed, direction: path.direction, animator, state: { kind: 'walking' } });
    }
  }

  buildYard(layout, frame.side, assets, root, pick);

  const wrap = (z: number): number => (z > halfLength ? z - halfLength * 2 : z < -halfLength ? z + halfLength * 2 : z);
  const localChicks: THREE.Vector3[] = [];

  return {
    root,
    update(dt, chicks) {
      for (const car of cars) {
        car.object.position.z = wrap(car.object.position.z + car.speed * car.direction * dt);
      }

      street.updateMatrixWorld();
      localChicks.length = 0;
      for (const chick of chicks) localChicks.push(street.worldToLocal(chick.clone()));
      for (const person of people) updatePasserby(person, dt, localChicks, wrap);
    },
    dispose() {
      for (const person of people) person.animator.dispose();
      root.removeFromParent();
    },
  };
}

function updatePasserby(
  person: Passerby,
  dt: number,
  chicks: readonly THREE.Vector3[],
  wrap: (z: number) => number,
): void {
  person.animator.update(dt);
  const { position } = person.object;

  let nearest: THREE.Vector3 | null = null;
  let nearestDistance = Infinity;
  for (const chick of chicks) {
    const distance = Math.hypot(chick.x - position.x, chick.z - position.z);
    if (distance < nearestDistance) {
      nearest = chick;
      nearestDistance = distance;
    }
  }

  const state = person.state;
  if (state.kind === 'walking') {
    if (nearest && nearestDistance < NOTICE_DISTANCE) {
      person.state = { kind: 'startled', surprise: SURPRISE_DURATION, linger: LINGER_DURATION };
      person.animator.play('jump', { once: true, fade: 0.1 });
      return;
    }
    position.z = wrap(position.z + person.speed * person.direction * dt);
    return;
  }

  // Startled: hop, then stand and watch until the chick has gone by.
  if (nearest) {
    person.object.rotation.y = yawFromDirection(nearest.x - position.x, nearest.z - position.z);
  }
  state.surprise -= dt;
  if (state.surprise > 0) return;
  person.animator.play('idle');

  if (nearest && nearestDistance < FORGET_DISTANCE) {
    state.linger = LINGER_DURATION;
    return;
  }
  state.linger -= dt;
  if (state.linger <= 0) {
    person.state = { kind: 'walking' };
    person.object.rotation.y = yawFromDirection(0, person.direction);
    person.animator.play('walk', { timeScale: person.speed / 1.3 });
  }
}

/**
 * Local frame for the street: +X points away from the exit wall, Z runs along it,
 * origin at the middle of the wall's outer face.
 */
function streetFrame(layout: LevelLayout) {
  const { width, height } = layout.grid;
  const side = outwardDirection(layout.exits[0], layout.grid);
  const alongZ = side.col !== 0;
  const wallLength = alongZ ? height : width;
  const center = new THREE.Vector3((width - 1) / 2, 0, (height - 1) / 2);

  const origin = center.clone();
  if (side.col < 0) origin.x = -0.5;
  if (side.col > 0) origin.x = width - 0.5;
  if (side.row < 0) origin.z = -0.5;
  if (side.row > 0) origin.z = height - 0.5;

  return {
    side,
    origin,
    // Rotate local +X onto the outward direction.
    yaw: Math.atan2(-side.row, side.col),
    wallHalfLength: wallLength / 2,
    halfLength: Math.ceil((wallLength / 2 + STREET_OVERHANG) / CITY_SCALE) * CITY_SCALE,
  };
}

/** Containers, tanks and sheds around the walls that don't face the street. */
function buildYard(
  layout: LevelLayout,
  streetSide: Cell,
  assets: Assets,
  root: THREE.Group,
  pick: <T>(items: readonly T[]) => T,
): void {
  const { width, height } = layout.grid;
  const sides: { out: Cell; from: THREE.Vector3; to: THREE.Vector3 }[] = [
    { out: { col: 0, row: -1 }, from: new THREE.Vector3(-2, 0, -4.5), to: new THREE.Vector3(width + 1, 0, -4.5) },
    { out: { col: 0, row: 1 }, from: new THREE.Vector3(-2, 0, height + 3.5), to: new THREE.Vector3(width + 1, 0, height + 3.5) },
    { out: { col: 1, row: 0 }, from: new THREE.Vector3(width + 3.5, 0, -2), to: new THREE.Vector3(width + 3.5, 0, height + 1) },
    { out: { col: -1, row: 0 }, from: new THREE.Vector3(-4.5, 0, -2), to: new THREE.Vector3(-4.5, 0, height + 1) },
  ];

  for (const side of sides) {
    if (side.out.col === streetSide.col && side.out.row === streetSide.row) continue;
    const length = side.from.distanceTo(side.to);
    const facing = yawFromDirection(-side.out.col, -side.out.row);
    for (let t = 0; t <= length; t += 6.5) {
      const { root: object } = assets.instantiate(pick(YARD_PROPS));
      object.position.lerpVectors(side.from, side.to, t / length);
      object.rotation.y = facing;
      object.scale.setScalar(CITY_SCALE * 0.75);
      root.add(object);
    }
  }
}

/** Small deterministic PRNG so the street looks the same every time a level loads. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
