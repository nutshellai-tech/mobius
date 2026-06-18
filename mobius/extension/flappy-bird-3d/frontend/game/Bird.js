// game/Bird.js — 玩家小鸟
import * as THREE from 'three';
import { CONFIG } from './Config.js';

export class Bird {
  constructor() {
    this.group = new THREE.Group();

    // 主体 — 发光球
    const coreGeom = new THREE.IcosahedronGeometry(CONFIG.bird.radius, 1);
    this.coreMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x00f0ff,
      emissiveIntensity: 1.4,
      metalness: 0.6,
      roughness: 0.2,
    });
    this.core = new THREE.Mesh(coreGeom, this.coreMat);
    this.group.add(this.core);

    // 外层 — 半透明霓虹壳
    const shellGeom = new THREE.IcosahedronGeometry(CONFIG.bird.radius * 1.35, 0);
    this.shellMat = new THREE.MeshBasicMaterial({
      color: 0xff2bd6,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      wireframe: true,
    });
    this.shell = new THREE.Mesh(shellGeom, this.shellMat);
    this.group.add(this.shell);

    // 翅膀 — 两片发光板
    this.wings = [];
    for (const side of [-1, 1]) {
      const wingGeom = new THREE.BoxGeometry(1.3, 0.08, 0.5);
      const wingMat = new THREE.MeshBasicMaterial({
        color: 0xb026ff,
        transparent: true,
        opacity: 0.9,
      });
      const wing = new THREE.Mesh(wingGeom, wingMat);
      wing.position.set(0, 0, side * 0.55);
      wing.userData.side = side;
      wing.userData.phase = side > 0 ? 0 : Math.PI;
      this.group.add(wing);
      this.wings.push(wing);
    }

    // 拖尾粒子
    const trailCount = 60;
    const positions = new Float32Array(trailCount * 3);
    for (let i = 0; i < trailCount; i++) {
      positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0;
    }
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const trailMat = new THREE.PointsMaterial({
      color: 0x00f0ff,
      size: 0.35,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Points(trailGeom, trailMat);
    this.trailHead = 0;
    this.trailFilled = 0;

    // 状态
    this.velocity = 0;
    this.alive = true;
    this.flapAnimT = 0;
    this.t = 0;
    this.collisionRadiusOverride = null;

    this.reset();
  }

  reset() {
    this.velocity = 0;
    this.alive = true;
    this.flapAnimT = 0;
    this.group.position.set(CONFIG.bird.startX, CONFIG.bird.startY, CONFIG.bird.startZ);
    this.group.rotation.z = 0;
    const pos = this.trail.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) pos[i] = 0;
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trailFilled = 0;
  }

  flap() {
    if (!this.alive) return;
    this.velocity = CONFIG.bird.flapVelocity;
    this.flapAnimT = 0.45;
  }

  kill() {
    this.alive = false;
    this.velocity = Math.min(this.velocity, 0);
  }

  setColor(colorHex) {
    this.coreMat.color.setHex(colorHex);
    this.coreMat.emissive.setHex(colorHex);
  }

  setShellColor(colorHex) {
    this.shellMat.color.setHex(colorHex);
  }

  update(dt) {
    this.t += dt;
    if (!this.alive) {
      this.velocity += CONFIG.bird.gravity * dt * 1.4;
      this.velocity = Math.max(this.velocity, CONFIG.bird.maxFallSpeed * 1.2);
    } else {
      this.velocity += CONFIG.bird.gravity * dt;
      this.velocity = Math.max(this.velocity, CONFIG.bird.maxFallSpeed);
    }

    const y = this.group.position.y + this.velocity * dt;
    this.group.position.y = y;

    // 俯仰姿态
    const targetTilt = THREE.MathUtils.clamp(
      (this.velocity / CONFIG.bird.flapVelocity) * (Math.PI / 5),
      CONFIG.bird.tiltMin,
      CONFIG.bird.tiltMax
    );
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, -targetTilt, 0.18);

    // 核心呼吸
    const pulse = 1 + Math.sin(this.t * 6) * 0.05;
    this.core.scale.setScalar(pulse);
    this.shell.rotation.x += dt * 0.8;
    this.shell.rotation.y += dt * 1.1;

    // 翅膀拍动
    if (this.flapAnimT > 0) this.flapAnimT -= dt;
    const wingBase = this.flapAnimT > 0 ? Math.sin(this.flapAnimT * 20) * 0.8 : Math.sin(this.t * 8) * 0.18;
    for (const w of this.wings) {
      w.rotation.x = wingBase + w.userData.phase * 0.1;
      w.position.y = Math.sin(this.t * 6 + w.userData.phase) * 0.05;
    }

    // 拖尾
    this._updateTrail();
  }

  _updateTrail() {
    const pos = this.trail.geometry.attributes.position.array;
    const N = pos.length / 3;
    const idx = this.trailHead;
    pos[idx * 3]     = this.group.position.x;
    pos[idx * 3 + 1] = this.group.position.y;
    pos[idx * 3 + 2] = this.group.position.z;
    this.trailHead = (this.trailHead + 1) % N;
    this.trailFilled = Math.min(this.trailFilled + 1, N);
    this.trail.geometry.attributes.position.needsUpdate = true;
  }

  get collisionRadius() {
    return this.collisionRadiusOverride ?? CONFIG.bird.radius * 0.85;
  }
}
