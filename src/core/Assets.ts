import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneHierarchy } from 'three/addons/utils/SkeletonUtils.js';

/** Every model the game uses, keyed by a stable id. Paths are relative to /models. */
export const MODEL_PATHS = {
  chick: 'pets/animal-chick.glb',
  player: 'characters/character-female-b.glb',
  guard: 'characters/character-male-c.glb',
  floor: 'factory/floor.glb',
  conveyor: 'factory/conveyor-stripe-sides.glb',
  hopper: 'factory/hopper-high-square.glb',
  grinder: 'factory/machine-fortified.glb',
  farm: 'factory/machine-window-bar.glb',
  scanner: 'factory/scanner-high.glb',
  crate: 'factory/box-large.glb',
  crateSmall: 'factory/box-small.glb',
  robotArm: 'factory/robot-arm-a.glb',
  stopButton: 'factory/button-floor-round.glb',
  statusTube: 'factory/pipe-glass-large-long.glb',
  exitMarker: 'factory/indicator-special-arrow.glb',
  cone: 'factory/cone.glb',
  // Outside the factory.
  road: 'roads/road-straight.glb',
  sidewalk: 'roads/tile-low.glb',
  streetLight: 'roads/light-square.glb',
  streetSign: 'roads/road-sign-street.glb',
  shopA: 'commercial/building-a.glb',
  shopB: 'commercial/building-b.glb',
  shopC: 'commercial/building-c.glb',
  shopD: 'commercial/building-d.glb',
  shopE: 'commercial/building-e.glb',
  shopF: 'commercial/building-f.glb',
  shopG: 'commercial/building-g.glb',
  shopH: 'commercial/building-h.glb',
  warehouse: 'industrial/building-g.glb',
  chimney: 'industrial/chimney-large.glb',
  tank: 'industrial/detail-tank-large.glb',
  containerA: 'industrial/shipping-container-a.glb',
  containerB: 'industrial/shipping-container-b.glb',
  containerC: 'industrial/shipping-container-c.glb',
  sedan: 'cars/sedan.glb',
  taxi: 'cars/taxi.glb',
  van: 'cars/van.glb',
  delivery: 'cars/delivery.glb',
  suv: 'cars/suv.glb',
  hatchback: 'cars/hatchback-sports.glb',
  tree: 'suburban/tree-large.glb',
  treeSmall: 'suburban/tree-small.glb',
  planter: 'suburban/planter.glb',
  // (character-female-a is left out: the model has crutches built in.)
  passerbyA: 'characters/character-female-d.glb',
  passerbyB: 'characters/character-female-c.glb',
  passerbyC: 'characters/character-male-a.glb',
  passerbyD: 'characters/character-male-b.glb',
  passerbyE: 'characters/character-female-e.glb',
  passerbyF: 'characters/character-male-d.glb',
} as const;

export type ModelId = keyof typeof MODEL_PATHS;

/** Sprite textures (Kenney Emotes Pack), relative to /fx. */
export const TEXTURE_PATHS = {
  emoteQuestion: 'emote-question.png',
  emoteAlert: 'emote-alert.png',
  emoteConfused: 'emote-confused.png',
} as const;

export type TextureId = keyof typeof TEXTURE_PATHS;

export interface ModelInstance {
  root: THREE.Object3D;
  animations: readonly THREE.AnimationClip[];
}

/** A single mesh of a model, flattened into model space, ready to be drawn as an InstancedMesh. */
export interface InstancePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Mesh transform relative to the model root. */
  matrix: THREE.Matrix4;
}

interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  parts: InstancePart[];
}

/** Loads all glTF models up front and hands out clones or instancing data. */
export class Assets {
  private readonly models = new Map<ModelId, LoadedModel>();
  private readonly textures = new Map<TextureId, THREE.Texture>();

  constructor(private readonly baseUrl = import.meta.env.BASE_URL) {}

  async loadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const gltfLoader = new GLTFLoader();
    const textureLoader = new THREE.TextureLoader();
    const modelIds = Object.keys(MODEL_PATHS) as ModelId[];
    const textureIds = Object.keys(TEXTURE_PATHS) as TextureId[];
    const total = modelIds.length + textureIds.length;
    let loaded = 0;
    const tick = () => onProgress?.(++loaded, total);

    await Promise.all([
      ...modelIds.map(async (id) => {
        const gltf = await gltfLoader.loadAsync(`${this.baseUrl}models/${MODEL_PATHS[id]}`);
        this.models.set(id, { scene: gltf.scene, animations: gltf.animations, parts: collectParts(gltf.scene) });
        tick();
      }),
      ...textureIds.map(async (id) => {
        const texture = await textureLoader.loadAsync(`${this.baseUrl}fx/${TEXTURE_PATHS[id]}`);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.textures.set(id, texture);
        tick();
      }),
    ]);
  }

  texture(id: TextureId): THREE.Texture {
    const texture = this.textures.get(id);
    if (!texture) throw new Error(`Texture "${id}" has not been loaded`);
    return texture;
  }

  /** Deep clone of a model (safe for animated hierarchies) with shadows enabled. */
  instantiate(id: ModelId): ModelInstance {
    const model = this.get(id);
    const root = cloneHierarchy(model.scene);
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { root, animations: model.animations };
  }

  instanceParts(id: ModelId): readonly InstancePart[] {
    return this.get(id).parts;
  }

  private get(id: ModelId): LoadedModel {
    const model = this.models.get(id);
    if (!model) throw new Error(`Model "${id}" has not been loaded`);
    return model;
  }
}

function collectParts(scene: THREE.Object3D): InstancePart[] {
  scene.updateMatrixWorld(true);
  const parts: InstancePart[] = [];
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone() });
    }
  });
  return parts;
}
