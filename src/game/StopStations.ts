import * as THREE from 'three/webgpu';
import type { StopStation } from '../world/LevelBuilder';
import type { EmergencyStop } from './EmergencyStop';

/** Liquid colour per emergency-stop state. */
/** The button's cap is painted plain emergency red. */
const CAP_COLOR = 0xe0433f;

const LIQUID_COLORS = {
  ready: new THREE.Color(0x4fe07a),
  stopped: new THREE.Color(0x5bb8ff),
  recharging: new THREE.Color(0xffb347),
};
/** Liquid inside the tube, in the tube model's units (it runs from x = -1 to 1, centred at y = 0.5). */
const LIQUID_RADIUS = 0.3;
const LIQUID_START = -0.95;
const LIQUID_LENGTH = 1.9;
const COLOR_EASE = 6;
const FILL_EASE = 8;
/** Button press, in the button model's units: how far the cap sinks, and the spring back. */
const PRESS = { depth: 0.08, downTime: 0.07, damping: 9, frequency: 22, duration: 0.8 };

/** A button's movable cap and the time since it was last pressed. */
interface ButtonCap {
  cap: THREE.Object3D;
  restY: number;
  pressedFor: number;
}

/**
 * The emergency-stop hardware: push buttons whose cap sinks and springs back when
 * pressed, and wall tubes whose liquid shows the stop's state — full green
 * when ready, blue draining while the belts are stopped, amber refilling while
 * it recharges.
 */
export class StopStations {
  private readonly caps: ButtonCap[];
  private readonly liquids: THREE.Mesh[];
  private readonly geometry = new THREE.CylinderGeometry(LIQUID_RADIUS, LIQUID_RADIUS, 1, 16)
    .rotateZ(Math.PI / 2)
    .translate(0.5, 0, 0);
  private readonly material = new THREE.MeshBasicMaterial({ color: LIQUID_COLORS.ready });
  private readonly capMaterial = new THREE.MeshStandardMaterial({ color: CAP_COLOR, roughness: 0.6 });
  private fill = 1;

  constructor(private readonly stations: readonly StopStation[]) {
    this.caps = stations.map(({ button }) => {
      const cap = button.root.getObjectByName('button') ?? button.root;
      if ((cap as THREE.Mesh).isMesh) (cap as THREE.Mesh).material = this.capMaterial;
      return { cap, restY: cap.position.y, pressedFor: Infinity };
    });
    this.liquids = stations.map(({ tube }) => {
      const liquid = new THREE.Mesh(this.geometry, this.material);
      liquid.position.set(LIQUID_START, 0.5, 0);
      tube.add(liquid);
      return liquid;
    });
  }

  get buttons(): THREE.Object3D[] {
    return this.stations.map(({ button }) => button.root);
  }

  /** Pushes `button`'s cap down; it springs back by itself. */
  press(button: THREE.Object3D): void {
    const index = this.stations.findIndex((station) => station.button.root === button);
    if (index >= 0) this.caps[index].pressedFor = 0;
  }

  update(dt: number, stop: EmergencyStop): void {
    for (const cap of this.caps) {
      cap.pressedFor += dt;
      cap.cap.position.y = cap.restY - PRESS.depth * pressCurve(cap.pressedFor);
    }

    const state = stop.state;
    const target = state === 'ready' ? 1 : stop.charge;
    this.fill = THREE.MathUtils.damp(this.fill, target, FILL_EASE, dt);
    this.material.color.lerp(LIQUID_COLORS[state], 1 - Math.exp(-COLOR_EASE * dt));
    for (const liquid of this.liquids) {
      liquid.scale.x = Math.max(this.fill, 0.001) * LIQUID_LENGTH;
    }
  }

  dispose(): void {
    for (const liquid of this.liquids) liquid.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.capMaterial.dispose();
  }
}

/** 0 at rest, 1 fully pressed: a quick push down, then a damped spring back up. */
function pressCurve(t: number): number {
  if (t >= PRESS.duration) return 0;
  if (t < PRESS.downTime) return t / PRESS.downTime;
  const release = t - PRESS.downTime;
  return Math.exp(-PRESS.damping * release) * Math.cos(PRESS.frequency * release);
}
