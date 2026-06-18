// game/PowerUp.js — 拾取道具
import * as THREE from 'three';
import { CONFIG, POWERUP_META } from './Config.js';

export class PowerUp {
  constructor(type, x, y) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.dead = false;
    this.collected = false;
    this.t = 0;

    const meta = POWERUP_META[type];
    this.colorHex = meta.color;

    this.group = new THREE.Group();
    this.group.position.set(x, y, 0);

    // 外环 — 旋转的能量环
    const ringGeom = new THREE.TorusGeometry(0.55, 0.08, 10, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.95,
    });
    this.ring = new THREE.Mesh(ringGeom, ringMat);
    this.group.add(this.ring);

    // 内部多面体
    const innerGeom = new THREE.OctahedronGeometry(0.3, 0);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
    });
    this.inner = new THREE.Mesh(innerGeom, innerMat);
    this.group.add(this.inner);

    // 光晕球
    const glowGeom = new THREE.SphereGeometry(0.7, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Mesh(glowGeom, glowMat);
    this.group.add(this.glow);

    // 标识符 — 浮空粒子
    const dotCount = 8;
    const positions = new Float32Array(dotCount * 3);
    for (let i = 0; i < dotCount; i++) {
      const a = (i / dotCount) * Math.PI * 2;
      positions[i * 3]     = Math.cos(a) * 0.85;
      positions[i * 3 + 1] = Math.sin(a) * 0.85;
      positions[i * 3 + 2] = 0;
    }
    const dotGeom = new THREE.BufferGeometry();
    dotGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dotMat = new THREE.PointsMaterial({
      color: meta.color,
      size: 0.12,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    });
    this.dots = new THREE.Points(dotGeom, dotMat);
    this.group.add(this.dots);
  }

  setX(x) {
    this.x = x;
    this.group.position.x = x;
  }

  collidesWith(bird) {
    const r = CONFIG.powerup.pickupRadius + bird.collisionRadius;
    const dx = bird.group.position.x - this.x;
    const dy = bird.group.position.y - this.y;
    return dx * dx + dy * dy <= r * r;
  }

  update(dt) {
    this.t += dt;
    this.ring.rotation.x += dt * 1.6;
    this.ring.rotation.y += dt * 2.1;
    this.inner.rotation.x += dt * 2.4;
    this.inner.rotation.z += dt * 1.8;
    this.dots.rotation.z += dt * 1.0;

    const pulse = 1 + Math.sin(this.t * 4) * 0.15;
    this.glow.scale.setScalar(pulse);

    // 上下漂浮
    this.group.position.y = this.y + Math.sin(this.t * 2) * 0.25;
  }

  dispose() {
    this.group.traverse((m) => {
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
        else m.material.dispose();
      }
    });
  }
}
