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
  machine: 'factory/machine.glb',
  crate: 'factory/box-large.glb',
  crateSmall: 'factory/box-small.glb',
  robotArm: 'factory/robot-arm-a.glb',
  lever: 'factory/lever-single.glb',
  exitMarker: 'factory/indicator-special-arrow.glb',
  cone: 'factory/cone.glb',
} as const;

export type ModelId = keyof typeof MODEL_PATHS;

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

  constructor(private readonly baseUrl = `${import.meta.env.BASE_URL}models/`) {}

  async loadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    const ids = Object.keys(MODEL_PATHS) as ModelId[];
    let loaded = 0;

    await Promise.all(
      ids.map(async (id) => {
        const gltf = await loader.loadAsync(this.baseUrl + MODEL_PATHS[id]);
        this.models.set(id, {
          scene: gltf.scene,
          animations: gltf.animations,
          parts: collectParts(gltf.scene),
        });
        onProgress?.(++loaded, ids.length);
      }),
    );
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
