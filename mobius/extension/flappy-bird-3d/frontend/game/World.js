// game/World.js — 场景 / 灯光 / 地面网格 / 远景星空 / 雾
import * as THREE from 'three';
import { CONFIG } from './Config.js';

export class World {
  constructor(scene) {
    this.scene = scene;

    this._buildFog();
    this._buildLights();
    this._buildGround();
    this._buildSky();
    this._buildPillars();
  }

  _buildFog() {
    this.scene.fog = new THREE.Fog(CONFIG.world.bg, CONFIG.world.fogNear, CONFIG.world.fogFar);
    this.scene.background = new THREE.Color(CONFIG.world.bg);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0x6080ff, 0x100020, 0.45);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xff66ff, 0.65);
    dir.position.set(-3, 12, 4);
    this.scene.add(dir);

    const dir2 = new THREE.DirectionalLight(0x00f0ff, 0.45);
    dir2.position.set(5, 6, -6);
    this.scene.add(dir2);

    const ambient = new THREE.AmbientLight(0x202040, 0.6);
    this.scene.add(ambient);
  }

  _buildGround() {
    // 底部网格
    const grid = new THREE.GridHelper(400, 80, 0x00f0ff, 0xb026ff);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.y = CONFIG.world.floorY;
    this.scene.add(grid);
    this.floorGrid = grid;

    // 顶部反向网格
    const gridTop = new THREE.GridHelper(400, 80, 0xff2bd6, 0x601080);
    gridTop.material.transparent = true;
    gridTop.material.opacity = 0.35;
    gridTop.position.y = CONFIG.world.ceilingY;
    this.scene.add(grid);
    this.scene.add(gridTop);
    this.ceilGrid = gridTop;

    // 远处天地平线发光板
    const planeGeom = new THREE.PlaneGeometry(400, 6);
    const planeMat1 = new THREE.MeshBasicMaterial({
      color: 0xff2bd6, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    });
    const horizonGlow1 = new THREE.Mesh(planeGeom, planeMat1);
    horizonGlow1.position.set(0, CONFIG.world.floorY + 0.1, -80);
    this.scene.add(horizonGlow1);

    const planeMat2 = new THREE.MeshBasicMaterial({
      color: 0x00f0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
    });
    const horizonGlow2 = new THREE.Mesh(planeGeom, planeMat2);
    horizonGlow2.position.set(0, CONFIG.world.ceilingY - 0.1, -80);
    this.scene.add(horizonGlow2);
  }

  _buildSky() {
    // 星空粒子
    const count = 1200;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const palette = [
      [0.0, 0.94, 1.0],
      [1.0, 0.17, 0.84],
      [0.69, 0.15, 1.0],
      [1.0, 0.9, 0.0],
      [1.0, 1.0, 1.0],
    ];
    for (let i = 0; i < count; i++) {
      const r = 80 + Math.random() * 120;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 40;
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i * 3]     = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.7,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geom, mat);
    this.scene.add(this.stars);
  }

  _buildPillars() {
    // 远处霓虹立柱群, 视觉填充
    this.pillars = new THREE.Group();
    const colors = [0x00f0ff, 0xff2bd6, 0xb026ff, 0xffe600];
    for (let i = 0; i < 16; i++) {
      const h = 6 + Math.random() * 14;
      const w = 0.4 + Math.random() * 0.6;
      const geom = new THREE.BoxGeometry(w, h, w);
      const mat = new THREE.MeshBasicMaterial({
        color: colors[i % colors.length],
        transparent: true,
        opacity: 0.45,
      });
      const m = new THREE.Mesh(geom, mat);
      const side = Math.random() > 0.5 ? 1 : -1;
      m.position.set(
        side * (8 + Math.random() * 12),
        (Math.random() - 0.5) * 8,
        -30 - Math.random() * 60
      );
      this.pillars.add(m);
    }
    this.scene.add(this.pillars);
  }

  update(dt, scrollSpeed) {
    // 地面网格沿 -X 滚动 (管道也是这个方向, 让世界看起来在动)
    const v = scrollSpeed * dt;
    const cellSize = 5; // GridHelper 80格 / 400长度 = 5
    const wrap = (x) => ((x % cellSize) + cellSize) % cellSize;
    this.floorGrid.position.x = wrap(this.floorGrid.position.x - v);
    this.ceilGrid.position.x  = wrap(this.ceilGrid.position.x  - v);

    if (this.stars) this.stars.rotation.y += dt * 0.01;
  }

  reset() {
    if (this.floorGrid) this.floorGrid.position.x = 0;
    if (this.ceilGrid)  this.ceilGrid.position.x  = 0;
  }
}
