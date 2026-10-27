import * as THREE from 'three/webgpu';

/** Gameplay constants. Distances are in tiles, times in seconds. */
export const TUNING = {
  player: {
    scale: 1.5,
    radius: 0.28,
    walkSpeed: 4.2,
    stepInterval: 0.32,
    dash: {
      speed: 15,
      duration: 0.16,
      cooldown: 0.9,
      /** Seconds after a dash during which nearby guards can hear it. */
      noiseDuration: 0.6,
    },
    turnRate: 14,
    /** How far from the player a chick on a belt can be grabbed. */
    grabRange: 1.5,
    leverRange: 1.4,
  },
  chick: {
    scale: 0.34,
    beltHeight: 0.4,
    dropDuration: 0.45,
    hopDuration: 0.35,
    hopHeight: 0.8,
    grindDuration: 0.35,
    /** Spacing between chicks in the follower line. */
    spacing: 0.65,
    followSpeed: 8,
    /** Speed per tile of distance to its place in line, so chicks ease in rather than snap. */
    followGain: 7,
    /** How quickly speed changes (damping rate). */
    acceleration: 10,
    escapeSpeed: 3,
    escapeDuration: 2,
    turnRate: 12,
  },
  guard: {
    scale: 1.5,
    radius: 0.3,
    patrolSpeed: 2.2,
    /** Faster than walking, slower than chaining dashes (~6.1 average), so dashing escapes. */
    chaseSpeed: 5.0,
    searchSpeed: 3.0,
    turnRate: 8,
    viewDistance: 6.5,
    fieldOfView: THREE.MathUtils.degToRad(80),
    /** Suspicion gained per second when the player is in plain view, scaled up at close range. */
    suspicionGain: 1.4,
    suspicionDecay: 0.45,
    /** A dash within this radius is heard regardless of facing. */
    hearingRadius: 3.2,
    /** A following chick this close to a guard is grabbed by them. */
    captureDistance: 0.6,
    catchDistance: 0.65,
    waypointPause: 1.2,
    /** Seconds without sight of the player before a chase turns into a search. */
    loseSightAfter: 2.5,
    /** Suspicion a search starts at; a glimpse during a search turns back into a chase quickly. */
    searchAlertness: 0.6,
    /** How far past the last sighting, along the target's heading, the search looks first. */
    searchLead: 3,
    searchSpots: 2,
    searchRadius: 3.5,
    /** Seconds spent looking around at each search spot. */
    glanceDuration: 0.9,
    repathInterval: 0.35,
  },
  lever: {
    stopDuration: 8,
    cooldown: 25,
  },
  camera: {
    offset: new THREE.Vector3(0, 14, 7.5),
    followRate: 6,
  },
} as const;
