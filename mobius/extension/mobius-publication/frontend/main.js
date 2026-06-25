// 莫比乌斯宣传页交互
// 包含：滚动揭示 / 顶部导航明暗切换 / Hero 与 Finale 的莫比乌斯环粒子背景
//       概念对比与三重特性的 Three.js 3D 场景

import { initLogoBackdrop, initTorusOnly, initMobiusOnly, initTrinityMobius } from './mobius3d.js';

/* ---------- 1. 滚动揭示 ---------- */
const reveals = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('is-visible');
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -80px 0px' });
reveals.forEach((el) => io.observe(el));

/* ---------- 2. 顶部导航根据当前 section 切换明暗 ---------- */
const topnav = document.getElementById('topnav');
const lightSections = document.querySelectorAll(
  '.section-light, .section-light-2, .hero'
);
const navObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0.4) {
      const isHero = e.target.classList.contains('hero');
      topnav.classList.toggle('on-light', !isHero && e.target.classList.contains('section-light'));
    }
  }
}, { threshold: [0.4, 0.6] });
lightSections.forEach((s) => navObserver.observe(s));

/* ---------- 3. dot-logo 风格莫比乌斯光点背景（Hero & Finale） ---------- */
initLogoBackdrop(document.getElementById('hero-canvas'), 'hero');
initLogoBackdrop(document.getElementById('finale-canvas'), 'finale');

/* ---------- 5. 概念对比 + 三重特性的 3D 场景 ---------- */
// 5 个 Three.js 场景：用 IntersectionObserver 仅在可见时 RAF，避免空耗 GPU
const sceneRegistry = [];

function registerScene(el, factory) {
  if (!el) return;
  const scene = factory(el);
  sceneRegistry.push({ el, scene });
  scene.pause();
}

registerScene(document.getElementById('concept-torus'), initTorusOnly);
registerScene(document.getElementById('concept-mobius'), initMobiusOnly);
registerScene(document.getElementById('trinity-1'), (el) => initTrinityMobius(el, 'loop'));
registerScene(document.getElementById('trinity-2'), (el) => initTrinityMobius(el, 'dimension'));
registerScene(document.getElementById('trinity-3'), (el) => initTrinityMobius(el, 'stars'));

const sceneObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const found = sceneRegistry.find((s) => s.el === e.target);
    if (!found) continue;
    if (e.isIntersecting) found.scene.start();
    else found.scene.pause();
  }
}, { threshold: 0.05 });
sceneRegistry.forEach((s) => sceneObserver.observe(s.el));

/* ---------- 6. 7×24 项目运行热力图 ---------- */
// 7 天 × 24 小时 = 168 格，工作时段（9-22）密集，凌晨稀疏；4 个项目循环占用，部分格子空置
(function buildHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;

  // 一个伪随机但稳定的密度函数，让每天的活跃时段略有起伏
  function density(day, hour) {
    if (hour >= 9 && hour <= 22) {
      const peak = 1 - Math.abs(hour - 14) / 10;
      const weekend = day >= 5 ? 0.55 : 1.0;
      return Math.max(0.18, peak * weekend);
    }
    if (hour >= 7 && hour <= 23) return 0.18;
    return 0.06;
  }

  const projects = ['p1', 'p2', 'p3', 'p4'];
  const frag = document.createDocumentFragment();
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const d = density(day, hour);
      const r = Math.random();
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (r < d) {
        const proj = projects[(day * 7 + hour * 3 + Math.floor(r * 13)) % 4];
        cell.classList.add(proj);
        if (Math.random() < 0.12) cell.classList.add('breathe');
      } else {
        cell.classList.add('empty');
      }
      frag.appendChild(cell);
    }
  }
  grid.appendChild(frag);
})();

/* ---------- 7. 视频展示页：等用户给路径后接入 ---------- */
// 用法：window.setShowcaseVideo('json-track', '/path/to/video.mp4')
//      或直接在 index.html 的 <video> 上写 src，并去掉父节点 .placeholder 类。
window.setShowcaseVideo = function (slot, url) {
  const wrap = document.querySelector(`.showcase-video[data-video-slot="${slot}"]`);
  if (!wrap) return false;
  const video = wrap.querySelector('video');
  if (!video) return false;
  video.src = url;
  wrap.classList.remove('placeholder');
  return true;
};
