// game/PipeManager.js — 管道与道具生成 / 回收
import * as THREE from 'three';
import { CONFIG, POWERUP_TYPES } from './Config.js';
import { Pipe } from './Pipe.js';
import { PowerUp } from './PowerUp.js';

export class PipeManager {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.puGroup = new THREE.Group();
    scene.add(this.group);
    scene.add(this.puGroup);

    this.pipes = [];
    this.powerups = [];
    this.nextSpawnX = CONFIG.pipe.initialOffset;
    this.spawnCounter = 0;
  }

  reset() {
    for (const p of this.pipes) {
      this.group.remove(p.group);
      p.dispose();
    }
    for (const p of this.powerups) {
      this.puGroup.remove(p.group);
      p.dispose();
    }
    this.pipes.length = 0;
    this.powerups.length = 0;
    this.nextSpawnX = CONFIG.pipe.initialOffset;
    this.spawnCounter = 0;
    this._seed();
  }

  _seed() {
    // 启动时铺设若干管道
    let x = CONFIG.bird.startX + CONFIG.pipe.initialOffset;
    for (let i = 0; i < 6; i++) {
      this._spawnPipeAt(x);
      x += CONFIG.pipe.spacing;
    }
    this.nextSpawnX = x;
  }

  _spawnPipeAt(x) {
    const minY = CONFIG.world.floorY + CONFIG.pipe.gap / 2 + 0.6;
    const maxY = CONFIG.world.ceilingY - CONFIG.pipe.gap / 2 - 0.6;
    const gapY = minY + Math.random() * (maxY - minY);
    const pipe = new Pipe(x, gapY);
    pipe.group.position.x = x;
    this.pipes.push(pipe);
    this.group.add(pipe.group);

    // 同步尝试生成道具
    this.spawnCounter++;
    if (this.spawnCounter >= CONFIG.powerup.spawnEveryN) {
      this.spawnCounter = 0;
      if (Math.random() < CONFIG.powerup.spawnChance) {
        this._spawnPowerUpAt(x + CONFIG.pipe.spacing * 0.45, gapY);
      }
    }
  }

  _spawnPowerUpAt(x, y) {
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    const pu = new PowerUp(type, x, y);
    this.powerups.push(pu);
    this.puGroup.add(pu.group);
  }

  /**
   * 推进世界. scrollSpeed 是 X 轴负方向滚动速度.
   * 返回 { passed: Pipe[], picked: PowerUp[] }
   */
  update(dt, scrollSpeed) {
    const dx = -scrollSpeed * dt;
    for (const p of this.pipes) p.setX(p.x + dx);
    for (const p of this.powerups) p.setX(p.x + dx);
    for (const p of this.powerups) p.update(dt);

    // 回收 + 生成
    let removed;
    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const p = this.pipes[i];
      if (p.x < CONFIG.bird.startX - 6) {
        this.group.remove(p.group);
        p.dispose();
        removed = p;
        this.pipes.splice(i, 1);
      }
    }
    if (removed || this.pipes.length === 0) {
      // 用最远管道 X 来决定下一次生成
      let maxX = CONFIG.bird.startX;
      for (const p of this.pipes) if (p.x > maxX) maxX = p.x;
      while (maxX < CONFIG.bird.startX + CONFIG.pipe.spacing * 6) {
        maxX += CONFIG.pipe.spacing;
        this._spawnPipeAt(maxX);
      }
    }

    // 道具回收
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      if (p.x < CONFIG.bird.startX - 4) {
        this.puGroup.remove(p.group);
        p.dispose();
        this.powerups.splice(i, 1);
      }
    }
  }

  forEachPipe(fn) { for (const p of this.pipes) fn(p); }
  forEachPowerUp(fn) { for (const p of this.powerups) if (!p.collected) fn(p); }

  removePowerUp(pu) {
    pu.collected = true;
    this.puGroup.remove(pu.group);
    pu.dispose();
    const i = this.powerups.indexOf(pu);
    if (i >= 0) this.powerups.splice(i, 1);
  }
}
