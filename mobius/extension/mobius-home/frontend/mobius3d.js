// 莫比乌斯宣传页 3D 动画
// 视觉基底仿照 dot-logo-3d：Gerono ∞ 中心线 + 莫比乌斯半扭 + 呼吸光点。
import * as THREE from 'three';

const PALETTE_MAX = 6;
const BRAND = ['#22d3ee', '#7dd3fc', '#8b5cf6', '#a78bfa', '#ec4899', '#f472b6'];
const MUTED = ['#64748b', '#94a3b8', '#cbd5e1', '#7dd3fc', '#a78bfa', '#f472b6'];

const LOGO_VERTEX = /* glsl */`
attribute float aU;
attribute float aV;
attribute float aPhase;
attribute float aBreathRate;
attribute float aSize;
attribute float aColorT;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uTwist;
uniform float uZScale;
uniform float uDotSize;
uniform float uFlowSpeed;
uniform float uBreathSpeed;
uniform float uBreathStrength;
uniform float uFigureScale;
uniform vec3  uColors[${PALETTE_MAX}];
uniform int   uColorCount;

varying vec3  vColor;
varying float vBrightness;

vec3 infinityCenter(float u) {
  float x = uRadius * sin(u);
  float y = 0.52 * uRadius * sin(2.0 * u);
  float z = 0.22 * uRadius * uZScale * cos(u);
  return vec3(x, y, z);
}

vec3 infinityTangent(float u) {
  float dx = uRadius * cos(u);
  float dy = 1.04 * uRadius * cos(2.0 * u);
  float dz = -0.22 * uRadius * uZScale * sin(u);
  return normalize(vec3(dx, dy, dz));
}

vec3 mobiusPos(float u, float v) {
  float phi = uTwist * u * 0.5;
  vec3 center = infinityCenter(u);
  vec3 tangent = infinityTangent(u);
  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));
  float crossingPinch = mix(0.78, 1.0, smoothstep(0.18, 0.62, abs(sin(u))));
  vec3 ribbonDir = cos(phi) * side + sin(phi) * lift * uZScale;
  return (center + v * uWidth * crossingPinch * ribbonDir) * uFigureScale;
}

vec3 samplePalette(float t) {
  float scaled = clamp(t, 0.0, 0.999) * float(uColorCount - 1);
  int idx = int(floor(scaled));
  float f = fract(scaled);
  if (idx <= 0) return mix(uColors[0], uColors[1], f);
  if (idx == 1) return mix(uColors[1], uColors[2], f);
  if (idx == 2) return mix(uColors[2], uColors[3], f);
  if (idx == 3) return mix(uColors[3], uColors[4], f);
  return mix(uColors[4], uColors[5], f);
}

void main() {
  float u = aU + uTime * uFlowSpeed;
  vec3 pos = mobiusPos(u, aV);
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  float breath = sin(uTime * uBreathSpeed * aBreathRate + aPhase);
  float bright = (1.0 - uBreathStrength) + uBreathStrength * (0.5 + 0.5 * breath);
  vBrightness = bright;
  vColor = samplePalette(fract(aColorT + u * 0.035));

  float dist = max(0.1, -mvPos.z);
  float distScale = 380.0 / dist;
  gl_PointSize = aSize * uDotSize * distScale * (0.72 + 0.3 * bright);
}
`;

const LOGO_FRAGMENT = /* glsl */`
precision highp float;
varying vec3  vColor;
varying float vBrightness;
uniform float uGlow;
uniform float uAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  float core = smoothstep(0.5, 0.18, d);
  float halo = pow(max(0.0, 1.0 - d * 2.0), 2.45);
  vec3 col = vColor * vBrightness * (core * 0.86 + uGlow * halo * 0.58);
  float alpha = (core + uGlow * halo * 0.62) * uAlpha;
  gl_FragColor = vec4(col, alpha);
}
`;

const AURA_VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURA_FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uStrength;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float wave = 0.5 + 0.5 * sin(angle * 3.0 + uTime * 0.25);
  vec3 a = vec3(0.03, 0.75, 0.88);
  vec3 b = vec3(0.58, 0.36, 0.94);
  vec3 c = vec3(0.93, 0.28, 0.68);
  vec3 col = mix(mix(a, b, wave), c, smoothstep(0.25, 0.9, p.x + 0.5));
  float alpha = smoothstep(0.72, 0.05, r) * uStrength;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

function colorVec(hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

function padColors(colors) {
  const src = colors.map(colorVec);
  const out = [];
  for (let i = 0; i < PALETTE_MAX; i++) out.push(src[Math.min(i, src.length - 1)]);
  return out;
}

function makeLogoPointCloud(count, opts = {}) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aV = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aBreathRate = new Float32Array(count);
  const aSize = new Float32Array(count);
  const aColorT = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = (i + Math.random() * 0.65) / count;
    const s = Math.random() * 2 - 1;
    const edge = Math.random() < (opts.edgeBias ?? 0.18);
    aU[i] = t * Math.PI * 2;
    aV[i] = edge
      ? Math.sign(s || 1) * (0.72 + Math.random() * 0.28)
      : Math.sign(s || 1) * Math.pow(Math.abs(s), opts.vPower ?? 0.72);
    aPhase[i] = Math.random() * Math.PI * 2;
    aBreathRate[i] = 0.72 + Math.random() * 0.7;
    aSize[i] = (opts.minSize ?? 0.72) + Math.random() * (opts.sizeRange ?? 0.7);
    aColorT[i] = Math.random();
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  geometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aBreathRate', new THREE.BufferAttribute(aBreathRate, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aColorT', new THREE.BufferAttribute(aColorT, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

  const colors = opts.colors || BRAND;
  const material = new THREE.ShaderMaterial({
    vertexShader: LOGO_VERTEX,
    fragmentShader: LOGO_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: opts.radius ?? 1.45 },
      uWidth: { value: opts.width ?? 0.34 },
      uTwist: { value: opts.twist ?? 1 },
      uZScale: { value: opts.zScale ?? 1 },
      uDotSize: { value: opts.dotSize ?? 0.065 },
      uFlowSpeed: { value: opts.flowSpeed ?? 0.14 },
      uBreathSpeed: { value: opts.breathSpeed ?? 1.0 },
      uBreathStrength: { value: opts.breathStrength ?? 0.62 },
      uFigureScale: { value: opts.figureScale ?? 1 },
      uGlow: { value: opts.glow ?? 0.86 },
      uAlpha: { value: opts.alpha ?? 0.95 },
      uColors: { value: padColors(colors) },
      uColorCount: { value: Math.min(PALETTE_MAX, colors.length) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms: material.uniforms };
}

function infinityPoint(u, v, opts = {}) {
  const radius = opts.radius ?? 1.45;
  const width = opts.width ?? 0.34;
  const twist = opts.twist ?? 1;
  const zScale = opts.zScale ?? 1;
  const figureScale = opts.figureScale ?? 1;

  const center = new THREE.Vector3(
    radius * Math.sin(u),
    0.52 * radius * Math.sin(2 * u),
    0.22 * radius * zScale * Math.cos(u)
  );
  const tangent = new THREE.Vector3(
    radius * Math.cos(u),
    1.04 * radius * Math.cos(2 * u),
    -0.22 * radius * zScale * Math.sin(u)
  ).normalize();
  let side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), tangent);
  if (side.lengthSq() < 0.0001) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(tangent, side).normalize();
  const phi = twist * u * 0.5;
  const crossingPinch = THREE.MathUtils.lerp(0.78, 1.0, smoothstep(0.18, 0.62, Math.abs(Math.sin(u))));
  const ribbonDir = side.multiplyScalar(Math.cos(phi)).add(lift.multiplyScalar(Math.sin(phi) * zScale));
  return center.add(ribbonDir.multiplyScalar(v * width * crossingPinch)).multiplyScalar(figureScale);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function makeLine(count, color, opacity = 0.7) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Line(geometry, material);
}

function updateInfinityLine(line, opts = {}) {
  const attr = line.geometry.attributes.position;
  const count = attr.count;
  const start = opts.start ?? 0;
  const span = opts.span ?? Math.PI * 2;
  const v = opts.v ?? 0.55;
  for (let i = 0; i < count; i++) {
    const u = start + (i / Math.max(1, count - 1)) * span;
    const p = infinityPoint(u, v, opts);
    attr.setXYZ(i, p.x, p.y, p.z);
  }
  attr.needsUpdate = true;
}

function makeTraveler(color = 0xfde047, radius = 0.055) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
}

function createStarField(count, spread = 8, colors = BRAND) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = Math.pow(Math.random(), 0.45) * spread;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.58;
    pos[i * 3 + 2] = r * Math.cos(phi) - spread * 0.12;
    const c = new THREE.Color(colors[(Math.random() * colors.length) | 0]);
    const dim = 0.45 + Math.random() * 0.55;
    col[i * 3] = c.r * dim;
    col[i * 3 + 1] = c.g * dim;
    col[i * 3 + 2] = c.b * dim;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.018,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

function addAura(scene, scale = 4.5, strength = 0.22) {
  const aura = new THREE.Mesh(
    new THREE.PlaneGeometry(scale, scale * 0.68),
    new THREE.ShaderMaterial({
      vertexShader: AURA_VERTEX,
      fragmentShader: AURA_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: strength },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  aura.position.z = -0.9;
  scene.add(aura);
  return aura;
}

export class MiniScene {
  constructor(container, opts = {}) {
    this.container = container;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(opts.fog ?? 0x05030f, opts.fogDensity ?? 0.05);
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 42, width / height, 0.1, 100);
    this.camera.position.set(...(opts.cameraPos ?? [0, 0.2, 5.2]));
    this.camera.lookAt(...(opts.lookAt ?? [0, 0, 0]));

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? 1.15;
    container.appendChild(this.renderer.domElement);

    this.callbacks = [];
    this.running = false;
    this.clock = new THREE.Clock();
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.tick = this.tick.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  add(callback) {
    this.callbacks.push(callback);
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    if (!this.reduced) requestAnimationFrame(this.tick);
    else this.renderOnce();
  }

  pause() {
    this.running = false;
  }

  tick() {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    const t = this.clock.getElapsedTime();
    for (const callback of this.callbacks) callback(t);
    this.renderer.render(this.scene, this.camera);
  }

  renderOnce() {
    const t = this.clock.getElapsedTime();
    for (const callback of this.callbacks) callback(t);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose() {
    this.running = false;
    try { this.resizeObserver.disconnect(); } catch {}
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

export function initLogoBackdrop(canvas, variant = 'hero') {
  if (!canvas) return null;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02010a, 0.035);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 2.6, variant === 'finale' ? 18 : 17);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const aura = addAura(scene, 16, variant === 'finale' ? 0.16 : 0.2);
  const stars = createStarField(variant === 'finale' ? 1400 : 1800, 16, BRAND);
  scene.add(stars);
  const cloud = makeLogoPointCloud(variant === 'finale' ? 3600 : 4200, {
    radius: 5.2,
    width: 0.78,
    dotSize: variant === 'finale' ? 0.42 : 0.46,
    flowSpeed: variant === 'finale' ? 0.08 : 0.1,
    breathSpeed: 0.9,
    breathStrength: 0.7,
    glow: 0.95,
    alpha: 0.78,
    edgeBias: 0.24,
    figureScale: 1,
    colors: BRAND,
  });
  cloud.points.rotation.x = -0.16;
  cloud.points.rotation.z = -0.04;
  scene.add(cloud.points);

  const lineA = makeLine(180, 0x7dd3fc, 0.28);
  const lineB = makeLine(180, 0xf472b6, 0.18);
  scene.add(lineA, lineB);

  let width = 1;
  let height = 1;
  let running = false;
  let raf = 0;
  const clock = new THREE.Clock();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    canvas.width = width * Math.min(window.devicePixelRatio || 1, 2);
    canvas.height = height * Math.min(window.devicePixelRatio || 1, 2);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function frame() {
    if (!running) return;
    if (!reduced) raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    cloud.uniforms.uTime.value = t;
    aura.material.uniforms.uTime.value = t;
    cloud.points.rotation.y = Math.sin(t * 0.11) * 0.14;
    stars.rotation.y = t * 0.012;
    stars.rotation.x = Math.sin(t * 0.08) * 0.04;
    updateInfinityLine(lineA, { radius: 5.2, width: 0.78, v: 1, start: t * 0.08, span: Math.PI * 2 });
    updateInfinityLine(lineB, { radius: 5.2, width: 0.78, v: -1, start: -t * 0.06, span: Math.PI * 2 });
    renderer.render(scene, camera);
    if (reduced) running = false;
  }

  resize();
  window.addEventListener('resize', resize);

  const api = {
    start() {
      if (running) return;
      running = true;
      clock.getDelta();
      frame();
    },
    pause() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    },
  };
  api.start();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) api.pause();
    else api.start();
  });
  return api;
}

export function initTorusOnly(container) {
  const mini = new MiniScene(container, { cameraPos: [0, 0.25, 4.25], exposure: 1.12 });
  const group = new THREE.Group();
  group.rotation.x = -0.34;
  group.scale.setScalar(1.18);
  mini.scene.add(group);

  const ringGeometry = new THREE.BufferGeometry();
  const count = 900;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = (i / count) * Math.PI * 2;
    const lane = i % 2 === 0 ? 1.02 : 1.42;
    positions[i * 3] = Math.cos(u) * lane;
    positions[i * 3 + 1] = Math.sin(u) * lane * 0.36;
    positions[i * 3 + 2] = Math.sin(u) * 0.38;
    const c = new THREE.Color(i % 2 === 0 ? '#94a3b8' : '#64748b');
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  ringGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  ringGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const ring = new THREE.Points(
    ringGeometry,
    new THREE.PointsMaterial({
      size: 0.046,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    })
  );
  group.add(ring);

  const outerLine = makeLine(180, 0x22d3ee, 0.72);
  const innerLine = makeLine(180, 0xf472b6, 0.42);
  const traveler = makeTraveler(0xfde047, 0.09);
  const reset = new THREE.Mesh(
    new THREE.RingGeometry(1.28, 1.32, 96),
    new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0, side: THREE.DoubleSide })
  );
  group.add(outerLine, innerLine, traveler, reset);

  function updateCircle(line, radius, z, offset = 0) {
    const attr = line.geometry.attributes.position;
    for (let i = 0; i < attr.count; i++) {
      const u = offset + (i / Math.max(1, attr.count - 1)) * Math.PI * 2;
      attr.setXYZ(i, Math.cos(u) * radius, Math.sin(u) * radius * 0.36, Math.sin(u) * z);
    }
    attr.needsUpdate = true;
  }
  updateCircle(outerLine, 1.42, 0.38);
  updateCircle(innerLine, 1.02, 0.38);

  mini.add((t) => {
    group.rotation.y = t * 0.22;
    ring.rotation.z = t * 0.08;
    const phase = (t * 0.2) % 1;
    const u = phase * Math.PI * 2;
    traveler.position.set(Math.cos(u) * 1.42, Math.sin(u) * 1.42 * 0.36, Math.sin(u) * 0.38);
    const pulse = Math.max(0, 1 - phase * 10);
    reset.material.opacity = pulse * 0.32;
    reset.scale.setScalar(1 + pulse * 0.16);
  });
  return mini;
}

export function initMobiusOnly(container) {
  const mini = new MiniScene(container, { cameraPos: [0, 0.35, 5.25], exposure: 1.18 });
  const group = new THREE.Group();
  group.rotation.x = -0.18;
  mini.scene.add(group);
  const aura = addAura(mini.scene, 4.6, 0.16);
  const cloud = makeLogoPointCloud(2400, {
    radius: 1.45,
    width: 0.34,
    dotSize: 0.075,
    flowSpeed: 0.2,
    breathSpeed: 1.15,
    breathStrength: 0.72,
    glow: 1.05,
    edgeBias: 0.3,
    colors: BRAND,
  });
  group.add(cloud.points);
  const edge = makeLine(220, 0x7dd3fc, 0.55);
  const path = makeLine(86, 0xfde047, 0.75);
  const traveler = makeTraveler(0xfde047, 0.058);
  group.add(edge, path, traveler);
  updateInfinityLine(edge, { radius: 1.45, width: 0.34, v: 1, span: Math.PI * 2 });

  mini.add((t) => {
    cloud.uniforms.uTime.value = t;
    aura.material.uniforms.uTime.value = t;
    group.rotation.y = Math.sin(t * 0.18) * 0.18;
    const u = (t * 0.88) % (Math.PI * 2);
    traveler.position.copy(infinityPoint(u, 0.72, { radius: 1.45, width: 0.34 }));
    updateInfinityLine(path, { radius: 1.45, width: 0.34, v: 0.72, start: u - 0.72, span: 0.72 });
  });
  return mini;
}

export function initTrinityMobius(container, mode) {
  const mini = new MiniScene(container, { cameraPos: [0, 0.32, 4.9], exposure: 1.16 });
  const group = new THREE.Group();
  group.rotation.x = -0.16;
  mini.scene.add(group);

  const isStars = mode === 'stars';
  const isDimension = mode === 'dimension';
  const cloud = makeLogoPointCloud(isStars ? 2100 : 1550, {
    radius: 1.32,
    width: isStars ? 0.3 : 0.32,
    dotSize: isStars ? 0.06 : 0.065,
    flowSpeed: mode === 'loop' ? 0.25 : 0.12,
    breathSpeed: isStars ? 1.75 : 1.05,
    breathStrength: isStars ? 0.88 : 0.68,
    glow: isStars ? 1.18 : 0.95,
    edgeBias: mode === 'loop' ? 0.34 : 0.2,
    colors: BRAND,
  });
  group.add(cloud.points);

  const aura = addAura(mini.scene, 3.2, isStars ? 0.1 : 0.12);
  const orbit = makeLine(180, isDimension ? 0xec4899 : 0x7dd3fc, 0.38);
  const trail = makeLine(72, isDimension ? 0xf472b6 : 0xfde047, 0.72);
  const traveler = makeTraveler(isDimension ? 0xf472b6 : 0xfde047, 0.045);
  group.add(orbit, trail, traveler);

  let stars = null;
  if (isStars) {
    stars = createStarField(760, 3.5, BRAND);
    stars.material.size = 0.012;
    stars.material.opacity = 0.42;
    mini.scene.add(stars);
  }

  mini.add((t) => {
    const morph = isDimension ? (0.5 + 0.5 * Math.sin(t * 0.65 - Math.PI / 2)) : 1;
    const twist = isDimension ? THREE.MathUtils.lerp(0.12, 1.18, morph) : 1;
    const zScale = isDimension ? THREE.MathUtils.lerp(0.28, 1.15, morph) : 1;
    cloud.uniforms.uTime.value = t;
    cloud.uniforms.uTwist.value = twist;
    cloud.uniforms.uZScale.value = zScale;
    aura.material.uniforms.uTime.value = t;
    group.rotation.y = t * (mode === 'loop' ? 0.2 : 0.13);
    group.rotation.z = isDimension ? Math.sin(t * 0.45) * 0.08 : 0;
    updateInfinityLine(orbit, { radius: 1.32, width: isStars ? 0.3 : 0.32, twist, zScale, v: 1, span: Math.PI * 2 });

    const u = (t * (mode === 'loop' ? 0.92 : 0.68)) % (Math.PI * 2);
    const v = isDimension ? Math.sin(u * 0.5) * 0.72 : 0.74;
    traveler.position.copy(infinityPoint(u, v, { radius: 1.32, width: isStars ? 0.3 : 0.32, twist, zScale }));
    updateInfinityLine(trail, {
      radius: 1.32,
      width: isStars ? 0.3 : 0.32,
      twist,
      zScale,
      v,
      start: u - 0.62,
      span: 0.62,
    });
    if (stars) {
      stars.rotation.y = t * 0.05;
      stars.rotation.x = Math.sin(t * 0.2) * 0.08;
      stars.material.opacity = 0.34 + 0.14 * Math.sin(t * 0.9);
    }
  });
  return mini;
}
