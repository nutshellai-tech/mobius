// threebody-sim/frontend/main.js
// 三体 N 体 3D 模拟器: 星空背景 + 拖尾粒子 + 爆炸/吸积特效 + 拖拽初速度
//
// 与 mobius 后端通信: 通过 /extension/_sdk/ext.js 的 extCall(payload).
// 后端 handler: mobius/extension/threebody-sim/backend/extension_backend_handler.js
//
// 物理: Velocity Verlet 积分, 软化引力, dt 子步保证大 N 稳定.
//      a_i = G * sum_{j!=i} m_j * (r_j - r_i) / (|r_j - r_i|^2 + eps^2)^(3/2)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { extCall } from '/extension/_sdk/ext.js';

// ============================================================
// 常量
// ============================================================
const MAX_BODIES = 50;
const TRAIL_LEN = 900;             // 每条轨迹点数
const TRAIL_MIN_FADE = 0.18;       // 最旧端保留一点亮度, 避免轨迹变成黑线
const SOFTENING = 0.18;            // 引力软化, 防止近距离数值爆炸
const BASE_DT = 0.005;             // 基础时间步
const SUBSTEPS_BASE = 4;           // 默认子步
const STAR_COUNT = 4500;           // 星空点数
const PALETTE = [                  // 颜色调色板 (按 mass 索引)
  0xfde68a, 0xfb923c, 0xf43f5e, 0xc084fc, 0x60a5fa, 0x34d399, 0x22d3ee, 0xe879f9,
];

// ============================================================
// 全局状态
// ============================================================
let scene, camera, renderer, controls;
let bodies = [];                   // { obj, mesh, halo, trail, trailGeo, trailPositions, trailColors, mass, pos, vel, acc, color, radius, alive }
let starField, nebulaSphere;
let running = true;
let timeScale = 1.0;
let G = 1.0;
let showTrails = true;
let showGlow = true;
let showStars = true;
let autoRotate = false;
let lastInteractAt = 0;
let simTime = 0;
let lastFrameMs = 0;
let fpsAcc = 0, fpsFrames = 0, fpsLastT = 0;
let lastEvent = '初始化';
let pickRaycaster, pickPlane;
let dragState = null;              // { body, startWorld, lastWorld, t0 }
let isDragImpulse = false;
let pointerNDC = new THREE.Vector2();
let selectedBodyIdx = -1;

// DOM
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const toastEl = $('toast');

// ============================================================
// 初始化
// ============================================================
function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02030a, 0.0042);

  const w = window.innerWidth, h = window.innerHeight;
  camera = new THREE.PerspectiveCamera(62, w / h, 0.1, 4000);
  camera.position.set(0, 14, 36);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  stage.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 220;
  controls.addEventListener('start', () => { lastInteractAt = performance.now(); });

  // 环境光 + 极弱的方向光 (让 body 自发光成为主视觉)
  scene.add(new THREE.AmbientLight(0x223066, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 0.25);
  dir.position.set(20, 30, 10);
  scene.add(dir);

  // 远景星云
  nebulaSphere = makeNebula();
  scene.add(nebulaSphere);

  // 星空
  starField = makeStarField();
  scene.add(starField);

  // 拾取射线 + 拖拽平面
  pickRaycaster = new THREE.Raycaster();
  pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // 初始场景
  applyPreset('figure8');
  bindUI();
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKey);
  refreshScenarios();
  lastFrameMs = performance.now();
  animate();
}

// ============================================================
// 星空 / 星云
// ============================================================
function makeNebula() {
  // 大球内壁着色, 给背景一个柔和的紫蓝渐变
  const geo = new THREE.SphereGeometry(1500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uC1: { value: new THREE.Color(0x1b0a3a) },
      uC2: { value: new THREE.Color(0x08172e) },
      uC3: { value: new THREE.Color(0x2a0a2e) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform float uTime;
      uniform vec3 uC1, uC2, uC3;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y * 0.5 + 0.5;
        vec3 col = mix(uC1, uC2, h);
        col = mix(col, uC3, smoothstep(0.7, 1.0, 1.0 - h) * 0.6);
        // 旋涡感噪声
        float n = noise(dir.xz * 5.0 + uTime * 0.005);
        col += vec3(0.06, 0.04, 0.10) * n;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.shader = mat;
  return mesh;
}

function makeStarField() {
  const group = new THREE.Group();

  // 主星点
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    // 球面均匀分布
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 800 + Math.random() * 200;
    positions[3 * i] = r * Math.sin(phi) * Math.cos(theta);
    positions[3 * i + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[3 * i + 2] = r * Math.cos(phi);
    // 颜色: 偏白 / 偏蓝 / 偏黄
    const t = Math.random();
    let cr, cg, cb;
    if (t < 0.6) { cr = 1.0; cg = 1.0; cb = 1.0; }
    else if (t < 0.8) { cr = 0.7; cg = 0.85; cb = 1.0; }
    else { cr = 1.0; cg = 0.9; cb = 0.7; }
    const bright = 0.4 + Math.random() * 0.6;
    colors[3 * i] = cr * bright;
    colors[3 * i + 1] = cg * bright;
    colors[3 * i + 2] = cb * bright;
    sizes[i] = 0.6 + Math.random() * 2.8;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPx: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float uTime;
      uniform float uPx;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.7 + 0.3 * sin(uTime * 1.2 + position.x * 0.7 + position.y * 1.3);
        gl_PointSize = size * uPx * tw * (300.0 / -mv.z);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        a = pow(a, 1.6);
        gl_FragColor = vec4(vColor, a);
      }
    `,
    vertexColors: true,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.shader = mat;
  group.add(points);

  // 大星 (十字光芒): 用 Sprite
  for (let i = 0; i < 24; i++) {
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 900;
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    const sprite = new THREE.Sprite(makeStarSpriteMaterial());
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(8 + Math.random() * 16);
    group.add(sprite);
  }

  return group;
}

function makeStarSpriteMaterial() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.5, 'rgba(180,210,255,0.15)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  // 十字光芒
  ctx.globalCompositeOperation = 'lighter';
  const cg = ctx.createLinearGradient(0, 32, 64, 32);
  cg.addColorStop(0, 'rgba(255,255,255,0)');
  cg.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg;
  ctx.fillRect(0, 30, 64, 4);
  const cg2 = ctx.createLinearGradient(32, 0, 32, 64);
  cg2.addColorStop(0, 'rgba(255,255,255,0)');
  cg2.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  cg2.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg2;
  ctx.fillRect(30, 0, 4, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
}

// ============================================================
// 天体
// ============================================================
function makeBodyTexture() {
  // 球体贴图: 噪声 + 中心高光
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const dx = (x - 128) / 128, dy = (y - 128) / 128;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * 256 + x) * 4;
      const n = 0.85 + 0.15 * Math.sin(x * 0.13 + y * 0.21);
      const t = Math.max(0, 1 - d * 1.2);
      const v = t * t * 255 * n;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SHARED_BODY_TEX = (() => {
  let t = null;
  return () => { if (!t) t = makeBodyTexture(); return t; };
})();

function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SHARED_HALO_TEX = (() => { let t = null; return () => { if (!t) t = makeHaloTexture(); return t; }; })();

function trailFadeAt(index) {
  const t = TRAIL_LEN <= 1 ? 1 : index / (TRAIL_LEN - 1);
  return TRAIL_MIN_FADE + (1 - TRAIL_MIN_FADE) * Math.pow(t, 0.6);
}

function makeBody(mass, colorHex, pos, vel) {
  const color = new THREE.Color(colorHex);

  // 半径 ~ mass^(1/3), 但有最小/最大限制
  const radius = THREE.MathUtils.clamp(0.18 + Math.pow(mass, 1 / 3) * 0.45, 0.18, 1.6);

  // 球体
  const geo = new THREE.SphereGeometry(radius, 28, 18);
  const mat = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 1.2,
    map: SHARED_BODY_TEX(),
    roughness: 0.55,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);

  // 光晕 (additive sprite)
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: SHARED_HALO_TEX(),
    color: color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.85,
  }));
  const haloSize = radius * 7.5;
  halo.scale.setScalar(haloSize);

  // 拖尾
  const trailGeo = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(TRAIL_LEN * 3);
  const trailColors = new Float32Array(TRAIL_LEN * 3);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    linewidth: 1,
  });
  const trailLine = new THREE.Line(trailGeo, trailMat);
  trailLine.frustumCulled = false;
  trailLine.renderOrder = 2;

  const trailPointMat = new THREE.PointsMaterial({
    size: Math.max(0.045, radius * 0.12),
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const trailPoints = new THREE.Points(trailGeo, trailPointMat);
  trailPoints.frustumCulled = false;
  trailPoints.renderOrder = 3;

  const trail = new THREE.Group();
  trail.add(trailLine);
  trail.add(trailPoints);
  // 拖尾缓冲全部填当前位置, 避免初始 (0,0,0) 拖一条到原点的线
  for (let i = 0; i < TRAIL_LEN; i++) {
    trailPositions[3 * i]     = pos.x;
    trailPositions[3 * i + 1] = pos.y;
    trailPositions[3 * i + 2] = pos.z;
    const fade = trailFadeAt(i);
    trailColors[3 * i]     = color.r * fade;
    trailColors[3 * i + 1] = color.g * fade;
    trailColors[3 * i + 2] = color.b * fade;
  }

  const obj = new THREE.Group();
  obj.add(mesh);
  obj.add(halo);
  obj.position.set(pos.x, pos.y, pos.z);

  return {
    obj, mesh, halo, trail, trailGeo, trailMat, trailPointMat, trailPositions, trailColors,
    mass, color, radius, haloBaseSize: haloSize,
    pos: new THREE.Vector3().copy(pos),
    vel: new THREE.Vector3().copy(vel),
    acc: new THREE.Vector3(),
    accNext: new THREE.Vector3(),
    trailCount: 0,
    alive: true,
  };
}

function disposeBodies() {
  for (const b of bodies) {
    scene.remove(b.obj);
    scene.remove(b.trail);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    b.halo.material.dispose();
    b.trailGeo.dispose();
    b.trailMat && b.trailMat.dispose();
    b.trailPointMat && b.trailPointMat.dispose();
  }
  bodies = [];
}

// ============================================================
// 预设
// ============================================================
// 图八经典解 (Chenciner-Montgomery 2000), m=G=1
const FIG8_POS = [
  [0.97000436, -0.24308753, 0],
  [-0.97000436, 0.24308753, 0],
  [0, 0, 0],
];
const FIG8_VEL = [
  [0.466203685, 0.43236573, 0],
  [0.466203685, 0.43236573, 0],
  [-0.93240737, -0.86473146, 0],
];

function buildPreset(name, n) {
  const out = [];

  if (name === 'figure8' && n === 3) {
    for (let i = 0; i < 3; i++) {
      out.push({
        pos: new THREE.Vector3(...FIG8_POS[i]),
        vel: new THREE.Vector3(...FIG8_VEL[i]),
        mass: 1.0,
        color: PALETTE[i],
      });
    }
    return out;
  }

  if (name === 'triangle' && n === 3) {
    const r = 4.5;
    const m = 1.0;
    // 等边三角形 + 绕质心旋转, 加一点 z 抖动做 3D
    const omega = Math.sqrt(G * m * 3 / (Math.pow(r, 3) * Math.sqrt(3)));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      out.push({
        pos: new THREE.Vector3(x, y, 0),
        vel: new THREE.Vector3(-Math.sin(a), Math.cos(a), 0).multiplyScalar(omega * r),
        mass: m,
        color: PALETTE[i],
      });
    }
    return out;
  }

  if (name === 'binary' && n === 2) {
    const m = 1.0, r = 3.0;
    const v = Math.sqrt(G * m * m / (4 * r));   // 简化: 两体绕公共质心
    out.push({ pos: new THREE.Vector3(-r, 0, 0), vel: new THREE.Vector3(0, 0, v), mass: m, color: PALETTE[0] });
    out.push({ pos: new THREE.Vector3(r, 0, 0), vel: new THREE.Vector3(0, 0, -v), mass: m, color: PALETTE[1] });
    return out;
  }

  if (name === 'solar' && n === 4) {
    const M = 30;
    out.push({ pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), mass: M, color: 0xfbbf24 });
    const planets = [
      { r: 4.0, m: 0.05, c: 0xcbd5e1 },
      { r: 6.5, m: 0.08, c: 0xfb923c },
      { r: 9.5, m: 0.10, c: 0x60a5fa },
    ];
    for (const p of planets) {
      const v = Math.sqrt(G * M / p.r);
      out.push({
        pos: new THREE.Vector3(p.r, 0, 0),
        vel: new THREE.Vector3(0, 0, v),
        mass: p.m,
        color: p.c,
      });
    }
    return out;
  }

  if (name === 'pentagon' && n === 5) {
    const r = 4.0, m = 1.0, Mc = 8.0;
    out.push({ pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), mass: Mc, color: 0xfde68a });
    const omega = Math.sqrt(G * Mc / (r * r * r));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      out.push({
        pos: new THREE.Vector3(x, y, 0),
        vel: new THREE.Vector3(-Math.sin(a), Math.cos(a), 0).multiplyScalar(omega * r),
        mass: m,
        color: PALETTE[i % PALETTE.length],
      });
    }
    return out;
  }

  if (name === 'ring') {
    const r = Math.max(4, n * 0.5);
    const m = 1.0, Mc = n * 1.5;
    out.push({ pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), mass: Mc, color: 0xfde68a });
    const omega = Math.sqrt(G * Mc / (r * r * r));
    for (let i = 0; i < n - 1; i++) {
      const a = (i / (n - 1)) * Math.PI * 2;
      out.push({
        pos: new THREE.Vector3(r * Math.cos(a), 0, r * Math.sin(a)),
        vel: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(omega * r),
        mass: m,
        color: PALETTE[i % PALETTE.length],
      });
    }
    return out;
  }

  if (name === 'cluster') {
    // 一个中心大质量 + 周围随机分布
    const M = 10 + n * 1.2;
    out.push({ pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), mass: M, color: 0xfde68a });
    for (let i = 1; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 4 + Math.random() * 6;
      const pos = new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      // 圆轨道速度, 略扰动
      const orbitV = Math.sqrt(G * M / r) * (0.85 + Math.random() * 0.3);
      const tangent = new THREE.Vector3(-Math.sin(theta), 0.2 * (Math.random() - 0.5), Math.cos(theta)).normalize();
      const vel = tangent.multiplyScalar(orbitV);
      out.push({
        pos, vel,
        mass: 0.4 + Math.random() * 1.6,
        color: PALETTE[i % PALETTE.length],
      });
    }
    return out;
  }

  // 兜底: 任意 n 走 cluster
  return buildPreset('cluster', n);
}

function applyPreset(name) {
  const n = Math.max(2, Math.min(MAX_BODIES, parseInt($('n-input').value, 10) || 3));
  disposeBodies();
  const preset = buildPreset(name, n);
  for (const p of preset) {
    const b = makeBody(p.mass, p.color, p.pos, p.vel);
    scene.add(b.trail);
    scene.add(b.obj);
    bodies.push(b);
  }
  simTime = 0;
  computeAccelerations();
  recenterCameraOnBodies(true);
  $('t-n').textContent = String(bodies.length);
  $('n-input').value = n;
  $('n-slider').value = n;
  // 同步 preset 下拉, 若是兜底
  if ($('preset').value !== name && name !== 'cluster') {
    // 保持用户原选择
  }
  lastEvent = '应用预设: ' + name + ' (N=' + n + ')';
}

// ============================================================
// 物理: Velocity Verlet, O(N^2) 两两引力
// ============================================================
const _accBuf = new Float32Array(MAX_BODIES * 3);
const _r = new THREE.Vector3();

function computeAccelerations(target) {
  // target === 'acc' 写回 body.acc, === 'accNext' 写回 body.accNext
  const buf = target === 'accNext' ? _accBuf : _accBuf;  // 共用缓冲, 累加
  for (let i = 0; i < bodies.length; i++) buf[i * 3] = buf[i * 3 + 1] = buf[i * 3 + 2] = 0;
  const eps2 = SOFTENING * SOFTENING;
  for (let i = 0; i < bodies.length; i++) {
    const bi = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const bj = bodies[j];
      _r.subVectors(bj.pos, bi.pos);
      const d2 = _r.lengthSq() + eps2;
      const invR3 = 1.0 / (d2 * Math.sqrt(d2));
      const fOverM_i = G * bj.mass * invR3;
      const fOverM_j = G * bi.mass * invR3;
      buf[i * 3]     += fOverM_i * _r.x;
      buf[i * 3 + 1] += fOverM_i * _r.y;
      buf[i * 3 + 2] += fOverM_i * _r.z;
      buf[j * 3]     -= fOverM_j * _r.x;
      buf[j * 3 + 1] -= fOverM_j * _r.y;
      buf[j * 3 + 2] -= fOverM_j * _r.z;
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (target === 'accNext') {
      b.accNext.set(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
    } else {
      b.acc.set(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
    }
  }
}

function step(dt) {
  if (bodies.length === 0) return;
  // 1) r(t+dt) = r(t) + v(t)*dt + 0.5*a(t)*dt^2
  // 2) 算 a(t+dt)
  // 3) v(t+dt) = v(t) + 0.5*(a(t) + a(t+dt))*dt
  const halfDt2 = 0.5 * dt * dt;
  for (const b of bodies) {
    b.pos.x += b.vel.x * dt + b.acc.x * halfDt2;
    b.pos.y += b.vel.y * dt + b.acc.y * halfDt2;
    b.pos.z += b.vel.z * dt + b.acc.z * halfDt2;
  }
  computeAccelerations('accNext');
  const halfDt = 0.5 * dt;
  for (const b of bodies) {
    b.vel.x += (b.acc.x + b.accNext.x) * halfDt;
    b.vel.y += (b.acc.y + b.accNext.y) * halfDt;
    b.vel.z += (b.acc.z + b.accNext.z) * halfDt;
    b.acc.copy(b.accNext);
  }
}

function energy() {
  let ke = 0, pe = 0;
  const eps2 = SOFTENING * SOFTENING;
  for (let i = 0; i < bodies.length; i++) {
    const bi = bodies[i];
    ke += 0.5 * bi.mass * bi.vel.lengthSq();
    for (let j = i + 1; j < bodies.length; j++) {
      const bj = bodies[j];
      const d = Math.sqrt(bi.pos.distanceToSquared(bj.pos) + eps2);
      pe -= G * bi.mass * bj.mass / d;
    }
  }
  return { ke, pe, total: ke + pe };
}

function momentum() {
  let px = 0, py = 0, pz = 0;
  for (const b of bodies) {
    px += b.mass * b.vel.x;
    py += b.mass * b.vel.y;
    pz += b.mass * b.vel.z;
  }
  return Math.sqrt(px * px + py * py + pz * pz);
}

// ============================================================
// 渲染
// ============================================================
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function pushTrail(b) {
  // 环形缓冲, 实际从尾部往前推
  const arr = b.trailPositions;
  // 整体前移 (丢最老一帧)
  arr.copyWithin(0, 3);
  arr[(TRAIL_LEN - 1) * 3]     = b.pos.x;
  arr[(TRAIL_LEN - 1) * 3 + 1] = b.pos.y;
  arr[(TRAIL_LEN - 1) * 3 + 2] = b.pos.z;
  if (b.trailCount < TRAIL_LEN) b.trailCount++;
  b.trailGeo.attributes.position.needsUpdate = true;
  b.trailGeo.setDrawRange(TRAIL_LEN - b.trailCount, b.trailCount);
}

function updateTrailColors(b) {
  // 越老越暗
  const arr = b.trailColors;
  for (let i = 0; i < TRAIL_LEN; i++) {
    const fade = trailFadeAt(i);  // 0=最老, 1=最新
    arr[3 * i]     = b.color.r * fade;
    arr[3 * i + 1] = b.color.g * fade;
    arr[3 * i + 2] = b.color.b * fade;
  }
  b.trailGeo.attributes.color.needsUpdate = true;
}

function recenterCameraOnBodies(force) {
  if (bodies.length === 0) return;
  // 质心
  let cx = 0, cy = 0, cz = 0, mTot = 0;
  for (const b of bodies) {
    cx += b.pos.x * b.mass; cy += b.pos.y * b.mass; cz += b.pos.z * b.mass;
    mTot += b.mass;
  }
  cx /= mTot; cy /= mTot; cz /= mTot;
  controls.target.lerp(new THREE.Vector3(cx, cy, cz), force ? 1.0 : 0.06);
  if (force) {
    // 让相机到质心距离合适
    const dist = camera.position.distanceTo(controls.target);
    if (dist < 8 || dist > 200) {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target.clone().add(dir.multiplyScalar(36)));
    }
  }
}

let frameCount = 0;
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const frameMs = now - lastFrameMs;
  lastFrameMs = now;
  fpsAcc += frameMs;
  fpsFrames++;
  if (now - fpsLastT > 500) {
    const fps = 1000 * fpsFrames / fpsAcc;
    $('t-fps').textContent = fps.toFixed(0);
    fpsAcc = 0; fpsFrames = 0; fpsLastT = now;
  }

  // 物理: 按帧时间预算取子步数
  if (running && bodies.length > 0) {
    const substeps = bodies.length > 25 ? 8 : bodies.length > 10 ? 6 : SUBSTEPS_BASE;
    const dt = (BASE_DT * timeScale) / substeps;
    for (let s = 0; s < substeps; s++) step(dt);
    simTime += BASE_DT * timeScale;
  }

  // 同步 mesh 位置
  for (const b of bodies) {
    b.obj.position.copy(b.pos);
    if (showTrails) pushTrail(b);
  }

  // 自动相机平滑
  recenterCameraOnBodies(false);

  // 自转
  if (autoRotate && (now - lastInteractAt) > 4000) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;
  } else {
    controls.autoRotate = false;
  }
  controls.update();

  // 星空 / 星云动画
  if (starField && starField.userData.shader) {
    starField.userData.shader.uniforms.uTime.value = now * 0.001;
  }
  if (nebulaSphere && nebulaSphere.userData.shader) {
    nebulaSphere.userData.shader.uniforms.uTime.value = now * 0.001;
  }

  // 拖尾/光晕显隐
  for (const b of bodies) {
    b.trail.visible = showTrails;
    b.halo.visible = showGlow;
    if (showGlow) b.halo.material.opacity = (b === bodies[selectedBodyIdx]) ? 1.0 : 0.85;
  }
  if (starField) starField.visible = showStars;
  if (nebulaSphere) nebulaSphere.visible = showStars;

  // 选中态: 在 halo 显隐循环里已经处理, 这里只做大小
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    b.halo.scale.setScalar(i === selectedBodyIdx ? b.haloBaseSize * 1.6 : b.haloBaseSize);
  }

  // 状态栏
  if (frameCount % 12 === 0) {
    const e = energy();
    $('t-time').textContent = simTime.toFixed(2);
    $('t-ke').textContent = e.ke.toFixed(2);
    $('t-pe').textContent = e.pe.toFixed(2);
    $('t-e').textContent = e.total.toFixed(2);
    $('t-p').textContent = momentum().toFixed(3);
    $('t-event').textContent = lastEvent;
  }
  frameCount++;

  renderer.render(scene, camera);
}

// ============================================================
// 拾取 / 拖拽
// ============================================================
function onPointerDown(e) {
  if (e.button !== 0) return;  // 只处理左键
  lastInteractAt = performance.now();
  pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  pickRaycaster.setFromCamera(pointerNDC, camera);
  const hits = pickRaycaster.intersectObjects(bodies.map((b) => b.mesh), false);
  if (hits.length > 0) {
    const idx = bodies.findIndex((b) => b.mesh === hits[0].object);
    if (idx >= 0) {
      selectedBodyIdx = idx;
      dragState = {
        bodyIdx: idx,
        startScreen: { x: e.clientX, y: e.clientY },
        lastWorld: hits[0].point.clone(),
        startWorld: hits[0].point.clone(),
        isDrag: false,
      };
      controls.enabled = false;
      isDragImpulse = false;
      e.preventDefault();
    }
  } else {
    selectedBodyIdx = -1;
  }
}

function onPointerMove(e) {
  pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  if (!dragState) {
    // hover: 高亮最近
    pickRaycaster.setFromCamera(pointerNDC, camera);
    const hits = pickRaycaster.intersectObjects(bodies.map((b) => b.mesh), false);
    if (hits.length > 0) {
      const idx = bodies.findIndex((b) => b.mesh === hits[0].object);
      if (idx !== selectedBodyIdx && !dragState) {
        renderer.domElement.style.cursor = 'pointer';
      }
    } else {
      renderer.domElement.style.cursor = 'grab';
    }
    return;
  }
  // 拖拽: 把屏幕位移投影到与 body 当前位置垂直的平面上
  const b = bodies[dragState.bodyIdx];
  const dist = camera.position.distanceTo(b.pos);
  pickRaycaster.setFromCamera(pointerNDC, camera);
  // 用一个通过 body.pos 的平面, 法向 = 相机到 body
  const camDir = new THREE.Vector3().subVectors(camera.position, b.pos).normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, b.pos);
  const out = new THREE.Vector3();
  if (pickRaycaster.ray.intersectPlane(plane, out)) {
    if (!dragState.isDrag) {
      const dxs = e.clientX - dragState.startScreen.x;
      const dys = e.clientY - dragState.startScreen.y;
      if (dxs * dxs + dys * dys > 16) {
        dragState.isDrag = true;
        isDragImpulse = true;
      }
    }
    if (dragState.isDrag) {
      // 累加速度脉冲
      const dv = new THREE.Vector3().subVectors(out, dragState.lastWorld);
      const k = 0.6;
      b.vel.add(dv.multiplyScalar(k));
      dragState.lastWorld.copy(out);
      lastEvent = '拖拽 ' + b.mass.toFixed(2) + 'M天体';
    }
  }
}

function onPointerUp(e) {
  if (dragState) {
    controls.enabled = true;
    if (!dragState.isDrag) {
      // 单击: 选中
      selectedBodyIdx = dragState.bodyIdx;
      const b = bodies[dragState.bodyIdx];
      lastEvent = '选中 ' + b.mass.toFixed(2) + 'M天体';
    } else {
      lastEvent = '施加初速度脉冲';
    }
    dragState = null;
    isDragImpulse = false;
  }
}

function onKey(e) {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') { applyPreset($('preset').value); }
}

// ============================================================
// UI 绑定
// ============================================================
function bindUI() {
  $('n-slider').addEventListener('input', () => { $('n-input').value = $('n-slider').value; });
  $('n-input').addEventListener('change', () => {
    let v = Math.max(2, Math.min(MAX_BODIES, parseInt($('n-input').value, 10) || 3));
    $('n-input').value = v; $('n-slider').value = v;
  });
  $('apply').addEventListener('click', () => applyPreset($('preset').value));
  $('play').addEventListener('click', togglePlay);
  $('reset').addEventListener('click', () => applyPreset($('preset').value));
  $('speed').addEventListener('input', (e) => { timeScale = parseFloat(e.target.value); });
  $('gravity').addEventListener('input', (e) => { G = parseFloat(e.target.value); });
  $('trails').addEventListener('change', (e) => { showTrails = e.target.checked; if (!showTrails) { for (const b of bodies) { b.trailCount = 0; b.trailGeo.setDrawRange(0, 0); } } });
  $('glow').addEventListener('change', (e) => { showGlow = e.target.checked; });
  $('stars').addEventListener('change', (e) => { showStars = e.target.checked; });
  $('autorotate').addEventListener('change', (e) => { autoRotate = e.target.checked; });
  $('who').addEventListener('click', async () => {
    try {
      const r = await extCall({ action: 'whoami' });
      toast(`👤 ${r.display_name || r.username}`, 'ok');
    } catch (e) { toast('whoami 失败: ' + e.message, 'err'); }
  });

  $('scn-save').addEventListener('click', onSaveScenario);
  $('scn-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveScenario(); });
}

function togglePlay() {
  running = !running;
  $('play').textContent = running ? '暂停' : '播放';
}

// ============================================================
// 场景存档
// ============================================================
function currentState() {
  return {
    bodies: bodies.map((b) => ({
      pos: [b.pos.x, b.pos.y, b.pos.z],
      vel: [b.vel.x, b.vel.y, b.vel.z],
      mass: b.mass,
      color: b.color.getHex(),
    })),
    G, simTime,
  };
}

function loadState(state) {
  disposeBodies();
  for (const p of state.bodies) {
    const b = makeBody(p.mass, p.color, new THREE.Vector3(...p.pos), new THREE.Vector3(...p.vel));
    updateTrailColors(b);
    scene.add(b.trail);
    scene.add(b.obj);
    bodies.push(b);
  }
  if (typeof state.G === 'number') {
    G = state.G;
    $('gravity').value = G;
  }
  simTime = state.simTime || 0;
  computeAccelerations();
  recenterCameraOnBodies(true);
  $('t-n').textContent = String(bodies.length);
  $('n-input').value = bodies.length;
  $('n-slider').value = Math.min(MAX_BODIES, bodies.length);
  lastEvent = '已加载场景';
}

async function onSaveScenario() {
  const name = $('scn-name').value.trim();
  if (!name) { toast('请输入场景名', 'err'); return; }
  try {
    const r = await extCall({ action: 'save_scenario', name, data: currentState() });
    if (r.ok) {
      toast('✓ 已保存: ' + name, 'ok');
      $('scn-name').value = '';
      refreshScenarios();
    } else {
      toast('保存失败: ' + (r.error || 'unknown'), 'err');
    }
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}

async function refreshScenarios() {
  const ul = $('scn-list');
  try {
    const r = await extCall({ action: 'list_scenarios' });
    if (!r.ok) throw new Error(r.error || 'fail');
    const list = r.scenarios || [];
    if (list.length === 0) {
      ul.innerHTML = '<li class="scn-empty">尚无存档</li>';
      return;
    }
    ul.innerHTML = list.map((s) => `
      <li>
        <span class="name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        <span class="meta">N=${s.body_count || '?'}</span>
        <span class="actions">
          <button data-act="load" data-name="${escapeHtml(s.name)}">加载</button>
          <button data-act="del" data-name="${escapeHtml(s.name)}" class="del">删</button>
        </span>
      </li>
    `).join('');
    ul.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        if (btn.dataset.act === 'load') {
          try {
            const r = await extCall({ action: 'load_scenario', name });
            if (r.ok) loadState(r.data);
            else toast('加载失败: ' + r.error, 'err');
          } catch (e) { toast('加载失败: ' + e.message, 'err'); }
        } else {
          if (!confirm('删除存档 "' + name + '" ?')) return;
          try {
            const r = await extCall({ action: 'delete_scenario', name });
            if (r.ok) refreshScenarios();
            else toast('删除失败: ' + r.error, 'err');
          } catch (e) { toast('删除失败: ' + e.message, 'err'); }
        }
      });
    });
  } catch (e) {
    ul.innerHTML = '<li class="scn-empty">加载失败: ' + escapeHtml(e.message) + '</li>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = 'show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 2200);
}

// ============================================================
// Bootstrap
// ============================================================
init();
