// game/Pipe.js — 一根霓虹管道 + 上下间隙
import * as THREE from 'three';
import { CONFIG, PIPE_PALETTE } from './Config.js';

export class Pipe {
  constructor(x, gapY, colorHex) {
    this.x = x;
    this.gapY = gapY;
    this.passed = false;
    this.dead = false;
    this.color = colorHex || PIPE_PALETTE[Math.floor(Math.random() * PIPE_PALETTE.length)];

    this.group = new THREE.Group();

    // 上管段
    const topH = (CONFIG.world.ceilingY - CONFIG.world.floorY) - CONFIG.pipe.gap - (gapY - CONFIG.pipe.gap / 2 - CONFIG.world.floorY);
    this.topMesh = this._buildSegment(topH, this.color);
    const topCenterY = CONFIG.world.ceilingY - topH / 2;
    this.topMesh.position.y = topCenterY;

    // 下管段
    const bottomH = gapY - CONFIG.pipe.gap / 2 - CONFIG.world.floorY;
    this.bottomMesh = this._buildSegment(bottomH, this.color);
    const bottomCenterY = CONFIG.world.floorY + bottomH / 2;
    this.bottomMesh.position.y = bottomCenterY;

    this.group.add(this.topMesh, this.bottomMesh);
  }

  _buildSegment(height, color) {
    const grp = new THREE.Group();
    const safeH = Math.max(0.1, height);
    const r = CONFIG.pipe.pipeRadius;
    const t = CONFIG.pipe.pipeThickness;

    // 实体外管 (主体)
    const outerGeom = new THREE.CylinderGeometry(r, r, safeH, 18, 1, true);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x0a0218,
      side: THREE.DoubleSide,
    });
    const outer = new THREE.Mesh(outerGeom, outerMat);
    grp.add(outer);

    // 霓虹线框 — 外壳
    const wireGeom = new THREE.CylinderGeometry(r * 1.01, r * 1.01, safeH, 18, 1, true);
    const wireMat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.85,
    });
    const wire = new THREE.Mesh(wireGeom, wireMat);
    grp.add(wire);

    // 实心环 (端头加粗)
    const ringR = r * 1.2;
    const ringT = 0.3;
    const ringGeom = new THREE.TorusGeometry(ringR, ringT, 8, 22);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
    });
    const ringTop = new THREE.Mesh(ringGeom, ringMat);
    ringTop.rotation.x = Math.PI / 2;
    ringTop.position.y = safeH / 2 - 0.1;
    grp.add(ringTop);

    // 内壁发光柱 (中间能量)
    const innerR = r * 0.4;
    const innerGeom = new THREE.CylinderGeometry(innerR, innerR, safeH, 8, 1, true);
    const innerMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
    });
    const inner = new THREE.Mesh(innerGeom, innerMat);
    grp.add(inner);

    return grp;
  }

  setX(x) {
    this.x = x;
    this.group.position.x = x;
  }

  collidesWith(bird) {
    // 简化: 只检测 bird.position 在管道 X 范围内时, Y 是否在 gap 之外
    const r = CONFIG.pipe.pipeRadius + bird.collisionRadius;
    const dx = Math.abs(bird.group.position.x - this.x);
    if (dx > r + 0.4) return false;

    const gapTop = this.gapY + CONFIG.pipe.gap / 2;
    const gapBot = this.gapY - CONFIG.pipe.gap / 2;
    const by = bird.group.position.y;
    if (by + bird.collisionRadius > gapTop) return true;
    if (by - bird.collisionRadius < gapBot) return true;
    return false;
  }

  isInGap(bird) {
    const r = CONFIG.pipe.pipeRadius + bird.collisionRadius;
    const dx = Math.abs(bird.group.position.x - this.x);
    if (dx > r + 0.4) return false;
    const gapTop = this.gapY + CONFIG.pipe.gap / 2;
    const gapBot = this.gapY - CONFIG.pipe.gap / 2;
    const by = bird.group.position.y;
    return by + bird.collisionRadius <= gapTop && by - bird.collisionRadius >= gapBot;
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
