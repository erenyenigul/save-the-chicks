import '@fontsource/lilita-one';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './ui/style.css';

import * as THREE from 'three/webgpu';
import { Assets } from './core/Assets';
import { Input } from './core/Input';
import { SoundBoard } from './core/SoundBoard';
import { CameraRig } from './game/CameraRig';
import { Game, type GameOutcome } from './game/Game';
import { Progress } from './game/Progress';
import { scoreLevel } from './game/scoring';
import { element } from './ui/dom';
import { Hud } from './ui/Hud';
import { Overlay, type OverlayAction } from './ui/Overlay';
import { Tutorial } from './ui/Tutorial';
import { LEVELS } from './world/levels';

/** Longest step the simulation takes; protects against tab-switch spikes. */
const MAX_FRAME_TIME = 1 / 20;

class App {
  private readonly renderer = new THREE.WebGPURenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly rig = new CameraRig(window.innerWidth / window.innerHeight);
  private readonly timer = new THREE.Timer();
  private readonly input = new Input();
  private readonly assets = new Assets();
  private readonly sound = new SoundBoard();
  private readonly hud = new Hud();
  private readonly tutorial = new Tutorial();
  private readonly overlay = new Overlay(() => this.sound.play('click'));
  private readonly progress = Progress.load();
  private game: Game | null = null;
  private levelIndex = 0;
  private backendLabel = '';

  async start(container: HTMLElement): Promise<void> {
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
    window.addEventListener('resize', this.onResize);
    this.timer.connect(document);

    await this.assets.loadAll((loaded, total) => this.overlay.setLoading(loaded, total));
    this.showMenu();
    this.renderer.setAnimationLoop(this.frame);
  }

  private showMenu(): void {
    this.hud.setVisible(false);
    const entries = LEVELS.map((level, index) => ({
      name: level.name,
      unlocked: this.progress.isUnlocked(LEVELS, index),
      record: this.progress.record(level),
    }));
    this.overlay.showMenu(entries, this.progress.nextLevelIndex(LEVELS), (index) => this.startLevel(index));
  }

  private setUpStage(): void {
    const background = new THREE.Color(0x1b1730);
    this.scene.background = background;
    this.scene.fog = new THREE.Fog(background, 24, 48);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x2a2444, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private startLevel(index: number): void {
    this.game?.dispose();
    this.levelIndex = index;
    const level = LEVELS[index];
    const label = `Level ${index + 1} · ${level.name}`;
    this.game = new Game(level, label, this.assets, this.sound, (signal) =>
      this.tutorial.complete(signal === 'dashed' ? 'dash' : 'grab'),
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
    this.hud.setVisible(false);
    this.sound.play(outcome.won ? 'win' : 'lose');

    const level = LEVELS[this.levelIndex];
    const score = scoreLevel(outcome.stats, level.rules, outcome.won);
    const { newBest, previousBest } = this.progress.addAttempt(level, {
      won: outcome.won,
      score: score.total,
      stars: score.stars,
      saved: outcome.stats.saved,
      seconds: outcome.stats.seconds,
    });

    const hasNext = this.levelIndex + 1 < LEVELS.length;
    const retry: OverlayAction = { label: 'Try again', onClick: () => this.startLevel(this.levelIndex) };
    const menu: OverlayAction = { label: 'Levels', onClick: () => this.showMenu(), secondary: true };
    let title = 'Shift over';
    let actions: OverlayAction[] = [retry, menu];
    if (outcome.won && hasNext) {
      title = 'They’re free!';
      actions = [
        { label: 'Next level', onClick: () => this.startLevel(this.levelIndex + 1) },
        { ...retry, label: 'Replay', secondary: true },
        menu,
      ];
    } else if (outcome.won) {
      title = 'Factory emptied!';
      actions = [{ ...retry, label: 'Replay' }, menu];
    }

    this.overlay.showResult(
      { title, reason: outcome.reason, won: outcome.won, score, stats: outcome.stats, newBest, previousBest },
      actions,
    );
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

    const playing = this.game !== null && this.overlay.hidden;
    if (this.game && playing) {
      const outcome = this.game.update(dt, this.input);
      this.hud.update(this.game.hudState());
      if (outcome) this.endLevel(outcome);
    }
    if (this.game) this.rig.update(dt, this.game.focus);

    this.tutorial.update(
      this.rig.camera,
      this.game && this.overlay.hidden
        ? { player: this.game.focus, facing: this.game.playerFacing, grabbable: this.game.grabbableChickPosition }
        : null,
    );

    this.input.endFrame();
    this.renderer.render(this.scene, this.rig.camera);
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
