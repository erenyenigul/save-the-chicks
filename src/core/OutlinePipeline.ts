import * as THREE from 'three/webgpu';
import { mix, pass, smoothstep, uniform, vec4 } from 'three/tsl';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';

/** Edge strength range turned into a solid band; narrow, so the band reads as a crisp cartoon border. */
const EDGE_THRESHOLD = { from: 0.012, to: 0.03 };
/** Blur radius of the outline pass (in its downsampled texels): larger = wider band. */
const BAND_WIDTH = { min: 1.4, max: 4 };
const PULSE_SPEED = 5;

/**
 * Renders the scene with a flat, single-colour silhouette border around selected
 * objects. Visible and hidden edges are drawn alike, so the border shows even
 * through whatever stands in front. The band's width pulses to draw the eye.
 */
export class OutlinePipeline {
  /** Objects to outline this frame; replace the contents freely. */
  readonly selected: THREE.Object3D[] = [];
  private readonly pipeline: THREE.RenderPipeline;
  private readonly bandWidth = uniform(BAND_WIDTH.max);
  private time = 0;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, color: THREE.ColorRepresentation) {
    const scenePass = pass(scene, camera);
    const edges = outline(scene, camera, { selectedObjects: this.selected, edgeThickness: this.bandWidth });
    const band = smoothstep(EDGE_THRESHOLD.from, EDGE_THRESHOLD.to, edges.visibleEdge.add(edges.hiddenEdge));

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = mix(scenePass, vec4(uniform(new THREE.Color(color)), 1), band);
  }

  render(dt: number): void {
    this.time += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * PULSE_SPEED);
    this.bandWidth.value = THREE.MathUtils.lerp(BAND_WIDTH.min, BAND_WIDTH.max, pulse);
    this.pipeline.render();
  }
}
