// game/Game.js — 主控制器
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CONFIG, POWERUP_META } from './Config.js';
import { World } from './World.js';
import { Bird } from './Bird.js';
import { PipeManager } from './PipeManager.js';
import { Effects } from './Effects.js';
import { Input } from './Input.js';

const STATE = {
  BOOT: 'boot',
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DEAD: 'dead',
  OVER: 'over',
};

export class Game {
  constructor({ stage, ui, backend }) {
    this.stage = stage;
    this.ui = ui;
    this.backend = backend;
    this.state = STATE.BOOT;
    this.score = 0;
    this.best = Number(localStorage.getItem('flappy3d.best') || 0) || 0;

    this._initThree();
    this._initEntities();
    this._initInput();
    this._bindUI();

    this.last = performance.now();
    this._raf = null;
    this.countdownT = 0;
    this.deathDelayT = 0;

    this.effects.onChange = (snap) => this.ui.renderPowerups(snap);

    this._loop = this._loop.bind(this);
  }

  _initThree() {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.stage.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 200);
    this.camera.position.set(-7.5, 1.5, 4.5);
    this.camera.lookAt(2, 0, 0);

    this.scene = new THREE.Scene();

    this.world = new World(this.scene);

    // Composer (bloom)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.7, 0.05);
    bloom.threshold = 0.0;
    bloom.strength = 0.9;
    bloom.radius = 0.7;
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    this.bloom = bloom;

    window.addEventListener('resize', () => this._onResize());
  }

  _initEntities() {
    this.bird = new Bird();
    this.scene.add(this.bird.group);
    this.scene.add(this.bird.trail);

    this.pipes = new PipeManager(this.scene);
    this.effects = new Effects();
  }

  _initInput() {
    this.input = new Input(window);
    this.input.on('flap', () => this._handleFlap());
    this.input.on('pause', () => this._togglePause());
    this.input.on('restart', () => {
      if (this.state === STATE.PLAYING || this.state === STATE.DEAD || this.state === STATE.OVER || this.state === STATE.PAUSED) {
        this.startGame();
      }
    });
    this.input.on('menu', () => this.showMenu());
  }

  _bindUI() {
    this.ui.onStart(() => this.startGame());
    this.ui.onPause(() => this._togglePause());
    this.ui.onResume(() => this._togglePause());
    this.ui.onRestartFromPause(() => this.startGame());
    this.ui.onRetry(() => this.startGame());
    this.ui.onBackMenu(() => this.showMenu());
  }

  // ---------- Lifecycle ----------

  showMenu() {
    this.state = STATE.MENU;
    this.ui.showMenu();
    this.ui.setBest(this.best);
    this.backend.getLeaderboard().then((lb) => this.ui.renderLeaderboard('leaderboard', lb)).catch(() => {});
  }

  async startGame() {
    this.score = 0;
    this.effects.reset();
    this.pipes.reset();
    this.bird.reset();
    this.bird.setColor(0x00f0ff);
    this.bird.setShellColor(0xff2bd6);
    this.ui.hideAllOverlays();
    this.ui.setScore(0);
    this.ui.setSpeed(1);
    this.ui.setBest(this.best);
    this.ui.showHud();
    this.state = STATE.COUNTDOWN;
    this.countdownT = 0.9;
    // 入场振翅
    this.bird.flap();
  }

  _togglePause() {
    if (this.state === STATE.PLAYING) {
      this.state = STATE.PAUSED;
      this.ui.showPause();
    } else if (this.state === STATE.PAUSED) {
      this.state = STATE.PLAYING;
      this.ui.hidePause();
    }
  }

  _handleFlap() {
    if (this.state === STATE.MENU) {
      this.startGame();
      return;
    }
    if (this.state === STATE.PAUSED) {
      this._togglePause();
      return;
    }
    if (this.state === STATE.DEAD || this.state === STATE.OVER) {
      return;
    }
    if (this.state === STATE.COUNTDOWN) {
      // 倒计时期间允许振翅以预热
      this.bird.flap();
      return;
    }
    if (this.state === STATE.PLAYING) {
      this.bird.flap();
    }
  }

  // ---------- Loop ----------

  start() {
    if (this._raf) return;
    this.last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
    this.showMenu();
  }

  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(dt, 0.05);

    this._update(dt);
    this._render();
  }

  _update(dt) {
    // 道具效果时间
    if (this.state === STATE.PLAYING) {
      this.effects.update(dt);
    }
    this.world.update(dt, this._currentScrollSpeed());

    // 小鸟在所有非 MENU 状态下都有运动 (死亡后下坠)
    if (this.state === STATE.COUNTDOWN || this.state === STATE.PLAYING || this.state === STATE.DEAD) {
      this.bird.update(dt);
    } else if (this.state === STATE.MENU) {
      // 菜单态: 小鸟悬浮展示
      this._menuIdleAnim(dt);
    }

    // 玩家活跃
    if (this.state === STATE.PLAYING) {
      this.pipes.update(dt, this._currentScrollSpeed());

      // 碰撞
      this._checkCollisions();

      // 计分
      this.pipes.forEachPipe((p) => {
        if (!p.passed && p.x < this.bird.group.position.x - 0.1) {
          p.passed = true;
          this._addScore(1);
        }
      });
    }

    if (this.state === STATE.COUNTDOWN) {
      this.countdownT -= dt;
      if (this.countdownT <= 0) {
        this.state = STATE.PLAYING;
        this.bird.flap();
      }
    }

    if (this.state === STATE.DEAD) {
      this.deathDelayT -= dt;
      // 等落地或超时再弹结算
      if (this.bird.group.position.y <= CONFIG.world.floorY + 0.5 || this.deathDelayT <= 0) {
        this.state = STATE.OVER;
        this._finishDeath();
      }
    }

    this._updateCamera(dt);
    this._updateBirdVisualByEffects();
  }

  _menuIdleAnim(dt) {
    const t = performance.now() / 1000;
    this.bird.velocity = 0;
    this.bird.group.position.set(
      CONFIG.bird.startX,
      Math.sin(t * 1.5) * 0.8,
      CONFIG.bird.startZ
    );
    this.bird.group.rotation.z = Math.sin(t * 1.5) * 0.12;
    this.bird.t += dt;
    // 翅膀保持柔和拍动
    for (const w of this.bird.wings) {
      w.rotation.x = Math.sin(this.bird.t * 4 + w.userData.phase) * 0.15;
    }
    this.bird._updateTrail();
  }

  _currentScrollSpeed() {
    let s = CONFIG.pipe.scrollSpeed + this.score * CONFIG.pipe.speedRamp;
    s *= this.effects.speedFactor;
    return Math.min(s, CONFIG.pipe.speedMax);
  }

  _addScore(base) {
    const gained = base * this.effects.scoreFactor;
    this.score += gained;
    this.ui.setScore(Math.floor(this.score));
  }

  _checkCollisions() {
    const bird = this.bird;
    const r0 = CONFIG.bird.radius * 0.85;
    bird.collisionRadiusOverride = r0 * this.effects.collisionRadiusScale;

    // 道具拾取
    this.pipes.forEachPowerUp((pu) => {
      if (pu.collidesWith(bird)) {
        this._onPickup(pu);
      }
    });

    // 管道碰撞 (磁极时容差放宽一点点 — 视觉上像吸过去, 实际更宽容)
    const tolerance = this.effects.has('magnet') ? 0.25 : 0;
    let hit = false;
    this.pipes.forEachPipe((p) => {
      if (hit) return;
      const gapTop = p.gapY + CONFIG.pipe.gap / 2 + tolerance;
      const gapBot = p.gapY - CONFIG.pipe.gap / 2 - tolerance;
      const dx = Math.abs(bird.group.position.x - p.x);
      if (dx > CONFIG.pipe.pipeRadius + bird.collisionRadius + 0.4) return;
      if (bird.group.position.y + bird.collisionRadius > gapTop) hit = true;
      else if (bird.group.position.y - bird.collisionRadius < gapBot) hit = true;
    });

    // 边界
    if (bird.group.position.y - bird.collisionRadius < CONFIG.world.floorY) {
      bird.group.position.y = CONFIG.world.floorY + bird.collisionRadius;
      hit = true;
    }
    if (bird.group.position.y + bird.collisionRadius > CONFIG.world.ceilingY) {
      bird.group.position.y = CONFIG.world.ceilingY - bird.collisionRadius;
      bird.velocity = Math.min(bird.velocity, 0);
    }

    if (hit) {
      if (this.effects.consumeShield()) {
        this.bird.flap();
        return;
      }
      this._onDie();
    }
  }

  _onPickup(pu) {
    this.pipes.removePowerUp(pu);
    this.effects.activate(pu.type);
    this.ui.flashPickup(pu.type);
  }

  _onDie() {
    if (this.state !== STATE.PLAYING) return;
    this.bird.kill();
    this.state = STATE.DEAD;
    this.deathDelayT = 1.4;
    this.ui.flashDeath();
  }

  async _finishDeath() {
    if (this.state !== STATE.OVER) return;
    const finalScore = Math.floor(this.score);
    const isBest = finalScore > this.best;
    if (isBest) {
      this.best = finalScore;
      localStorage.setItem('flappy3d.best', String(this.best));
    }
    let rank = null;
    let lb = [];
    try {
      const r = await this.backend.submitScore(finalScore);
      if (r && r.ok) {
        rank = r.rank;
        lb = r.leaderboard || [];
      }
    } catch (e) {
      try { lb = await this.backend.getLeaderboard(); } catch {}
    }
    this.ui.showGameOver({
      score: finalScore,
      best: this.best,
      rank,
      isBest,
      leaderboard: lb,
    });
  }

  _updateCamera(dt) {
    // 跟随相机: X 固定, Y 跟随
    const targetY = THREE.MathUtils.clamp(this.bird.group.position.y * 0.4, -2.5, 2.5);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, 1.2 + targetY, 0.06);
    // 视角微微抖动 — 死亡时震动
    if (this.state === STATE.DEAD) {
      const shake = Math.max(0, this.deathDelayT / 1.4);
      this.camera.position.x = -7.5 + (Math.random() - 0.5) * shake * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.4;
    } else {
      this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, -7.5, 0.1);
    }
    this.camera.lookAt(this.bird.group.position.x + 2.5, this.bird.group.position.y * 0.5, 0);
  }

  _updateBirdVisualByEffects() {
    // 小鸟颜色随状态切换
    let core = 0x00f0ff;
    let shell = 0xff2bd6;
    if (this.effects.shieldActive) {
      core = 0x00f0ff;
      shell = 0x00f0ff;
    } else if (this.effects.has('magnet')) {
      core = 0xb026ff;
      shell = 0xb026ff;
    } else if (this.effects.has('slow')) {
      core = 0x39ff14;
      shell = 0x39ff14;
    } else if (this.effects.has('double')) {
      core = 0xffe600;
      shell = 0xffe600;
    } else if (this.effects.has('tiny')) {
      core = 0xff2bd6;
      shell = 0xff2bd6;
    }
    this.bird.setColor(core);
    this.bird.setShellColor(shell);

    // 缩放
    const targetScale = this.effects.has('tiny') ? 0.55 : 1.0;
    const cur = this.bird.group.scale.x;
    const next = THREE.MathUtils.lerp(cur, targetScale, 0.15);
    this.bird.group.scale.setScalar(next);
  }

  _onResize() {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  _render() {
    this.composer.render();
  }
}
