import '@fontsource/lilita-one';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './ui/style.css';

import * as THREE from 'three/webgpu';
import { Assets } from './core/Assets';
import { Input } from './core/Input';
import { OutlinePipeline } from './core/OutlinePipeline';
import { SoundBoard } from './core/SoundBoard';
import { CameraRig } from './game/CameraRig';
import { Game, type GameOutcome, type GameSignal } from './game/Game';
import { Progress } from './game/Progress';
import { scoreLevel } from './game/scoring';
import { element } from './ui/dom';
import { Hud } from './ui/Hud';
import { Overlay, type OverlayAction } from './ui/Overlay';
import { Tutorial, type Lesson } from './ui/Tutorial';
import { Wipe } from './ui/Wipe';
import { loadLevels, type LevelDefinition } from './world/levels';

/** Which tutorial lessons each game signal completes. */
const SIGNAL_LESSONS: Record<GameSignal, Lesson[]> = {
  dashed: ['dash'],
  dashedWhileChased: ['dash', 'escape'],
  grabbed: ['grab'],
};

/** Longest step the simulation takes; protects against tab-switch spikes. */
const MAX_FRAME_TIME = 1 / 20;

class App {
  private readonly renderer = new THREE.WebGPURenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly rig = new CameraRig(window.innerWidth / window.innerHeight);
  /** Outlines interactive things (ready levers, the chick in reach) in one cartoon colour. */
  private readonly outlines = new OutlinePipeline(this.renderer, this.scene, this.rig.camera, 0x4fe07a);
  private readonly timer = new THREE.Timer();
  private readonly input = new Input();
  private readonly assets = new Assets();
  private readonly sound = new SoundBoard();
  private readonly hud = new Hud();
  private readonly tutorial = new Tutorial();
  private readonly overlay = new Overlay(() => this.sound.play('click'));
  private readonly wipe = new Wipe();
  /** A swipe is running; gameplay is frozen and further transitions are ignored. */
  private transitioning = false;
  private readonly progress = Progress.load();
  private game: Game | null = null;
  private levels: readonly LevelDefinition[] = [];
  private levelIndex = 0;
  private backendLabel = '';

  async start(container: HTMLElement): Promise<void> {
    this.levels = loadLevels();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.append(this.renderer.domElement);
    await this.renderer.init();

    const isWebGPU = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    this.backendLabel = `Renderer: ${isWebGPU ? 'WebGPU' : 'WebGL 2 fallback'}`;
    this.sound.setMuted(this.progress.muted);
    this.updateFooter();

    this.setUpStage();
    this.rig.snapTo(new THREE.Vector3());
    window.addEventListener('resize', this.onResize);
    this.timer.connect(document);

    await this.assets.loadAll((loaded, total) => this.overlay.setLoading(loaded, total));
    this.showMenu();
    this.renderer.setAnimationLoop(this.frame);
  }

  private showMenu(): void {
    this.hud.setVisible(false);
    const entries = this.levels.map((level, index) => ({
      name: level.name,
      unlocked: this.progress.isUnlocked(this.levels, index),
      record: this.progress.record(level),
    }));
    this.overlay.showMenu(entries, this.progress.nextLevelIndex(this.levels), (index) => this.play(index));
  }

  /** Swipe the screen closed, apply `change` underneath, then swipe it open. */
  private async transition(change: () => void): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    await this.wipe.cover();
    change();
    await this.wipe.reveal();
    this.transitioning = false;
  }

  private play(index: number): void {
    void this.transition(() => {
      this.overlay.hide();
      this.startLevel(index);
    });
  }

  private setUpStage(): void {
    const background = new THREE.Color(0x86a8a6);
    this.scene.background = background;
    this.scene.fog = new THREE.Fog(background, 24, 48);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x77a066, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    // Ambient sky light lives with the stage so menus have a lit backdrop; levels add the sun.
    this.scene.add(ground, new THREE.HemisphereLight(0xfff2e2, 0x6d8a70, 1.3));
  }

  private startLevel(index: number): void {
    this.game?.dispose();
    this.levelIndex = index;
    const level = this.levels[index];
    const label = `Level ${index + 1} · ${level.name}`;
    this.game = new Game(level, label, this.assets, this.sound, (signal) =>
      SIGNAL_LESSONS[signal].forEach((lesson) => this.tutorial.complete(lesson)),
    );
    this.scene.add(this.game.root);
    this.rig.snapTo(this.game.focus);
    this.hud.setVisible(true);
    if (import.meta.env.DEV) {
      // Debug handles for the console and automated play-testing.
      Object.assign(window, { game: this.game, startLevel: (i: number) => this.startLevel(i) });
    }
  }

  private endLevel(outcome: GameOutcome): void {
    if (outcome.won) this.sound.play('win');

    const level = this.levels[this.levelIndex];
    const score = scoreLevel(outcome.stats, level.rules, outcome.won);
    const { newBest, previousBest } = this.progress.addAttempt(level, {
      won: outcome.won,
      score: score.total,
      stars: score.stars,
      saved: outcome.stats.saved,
      seconds: outcome.stats.seconds,
    });

    const hasNext = this.levelIndex + 1 < this.levels.length;
    const retry: OverlayAction = { label: 'Try again', onClick: () => this.play(this.levelIndex) };
    const menu: OverlayAction = {
      label: 'Levels',
      onClick: () => void this.transition(() => this.showMenu()),
      secondary: true,
    };
    let title = 'Busted!';
    let actions: OverlayAction[] = [retry, menu];
    if (outcome.won && hasNext) {
      title = 'They’re free!';
      actions = [
        { label: 'Next level', onClick: () => this.play(this.levelIndex + 1) },
        { ...retry, label: 'Replay', secondary: true },
        menu,
      ];
    } else if (outcome.won) {
      title = 'Factory emptied!';
      actions = [{ ...retry, label: 'Replay' }, menu];
    }

    const result = { title, reason: outcome.reason, won: outcome.won, score, stats: outcome.stats, newBest, previousBest };
    void this.transition(() => {
      this.hud.setVisible(false);
      this.overlay.showResult(result, actions);
    });
  }

  private updateFooter(): void {
    this.hud.setBackend(`${this.backendLabel} · M: sound ${this.sound.isMuted ? 'off' : 'on'}`);
  }

  private readonly frame = (timestamp: number): void => {
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), MAX_FRAME_TIME);

    if (this.input.wasPressed('mute')) {
      this.sound.setMuted(!this.sound.isMuted);
      this.progress.muted = this.sound.isMuted;
      this.updateFooter();
    }

    const playing = this.game !== null && this.overlay.hidden && !this.transitioning;
    if (this.game && playing) {
      const outcome = this.game.update(dt, this.input);
      this.hud.update(this.game.hudState());
      if (outcome) this.endLevel(outcome);
    }
    if (this.game) this.rig.update(dt, this.game.focus);

    this.tutorial.update(
      this.rig.camera,
      this.game && this.overlay.hidden
        ? {
            player: this.game.focus,
            facing: this.game.playerFacing,
            grabbable: this.game.grabbableChickPosition,
            chased: this.game.isChased,
            dashReady: this.game.dashReady,
          }
        : null,
    );

    this.input.endFrame();
    this.outlines.selected.splice(0, Infinity, ...(this.game && playing ? this.game.highlights() : []));
    this.outlines.render(dt);
  };

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  };
}

const app = new App();
app.start(element('app')).catch((error: unknown) => {
  console.error(error);
  new Overlay().showError(error instanceof Error ? error.message : String(error));
});
