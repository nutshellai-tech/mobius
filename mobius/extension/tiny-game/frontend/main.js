/**
 * 霓虹方阵 NEON LEAP — 主入口.
 *
 * 模块组织:
 *   - 状态机: IDLE / PLAYING / PAUSED / LEVEL_CLEAR / GAME_OVER / VICTORY
 *   - 游戏循环: requestAnimationFrame + 固定步长 (dt 上限 50ms 防卡顿穿模)
 *   - 实体: 玩家 / 落体障碍 / 能量核心 / 激光行 / 分裂体
 *   - 输入: ← → A D 移动, P / Esc 暂停, 鼠标/触摸点击 canvas 也可左右
 *   - 持久化: storage.js → localStorage(瞬时) + 后端(档案/排行榜)
 */
import {
  LEVELS, TOTAL_LEVELS, getLevel,
  scorePerSecond, scorePerOrb, scoreLevelClear, VICTORY_BONUS,
} from './game/levels.js';
import {
  getLocalPrefs, setMuted, saveSession, clearSession,
  fetchProfile, saveProgress, submitScore, fetchLeaderboard, whoami,
} from './game/storage.js';

// ───────────────────────── 常量 ─────────────────────────
const CANVAS_W = 480, CANVAS_H = 600;
const PLAYER_W = 30, PLAYER_H = 30;
const PLAYER_Y = CANVAS_H - 60;
const PLAYER_SPEED = 5.2;
const ORB_R = 8;
const ORB_CHANCE = 0.35; // 与障碍一同刷出的概率
const INVULN_MS = 1500;
const START_LIVES = 3;
const LASER_TELEGRAPH_MS = 1100;
const LASER_ACTIVE_MS = 550;
const LASER_INTERVAL_MS = 5200;

// ───────────────────────── 状态机 ─────────────────────────
const State = Object.freeze({
  IDLE: 'IDLE',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  LEVEL_CLEAR: 'LEVEL_CLEAR',
  GAME_OVER: 'GAME_OVER',
  VICTORY: 'VICTORY',
});

// ───────────────────────── DOM 引用 ─────────────────────────
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const els = {
  hudLevel: document.getElementById('hudLevel'),
  hudScore: document.getElementById('hudScore'),
  hudLives: document.getElementById('hudLives'),
  hudTime: document.getElementById('hudTime'),
  hudHigh: document.getElementById('hudHigh'),
  overlayIdle: document.getElementById('overlayIdle'),
  overlayPause: document.getElementById('overlayPause'),
  overlayLevelClear: document.getElementById('overlayLevelClear'),
  overlayGameOver: document.getElementById('overlayGameOver'),
  overlayVictory: document.getElementById('overlayVictory'),
  btnStart: document.getElementById('btnStart'),
  btnContinue: document.getElementById('btnContinue'),
  continueLevel: document.getElementById('continueLevel'),
  btnResume: document.getElementById('btnResume'),
  btnRestart: document.getElementById('btnRestart'),
  btnRetry: document.getElementById('btnRetry'),
  btnAgain: document.getElementById('btnAgain'),
  btnHome: document.getElementById('btnHome'),
  btnHome2: document.getElementById('btnHome2'),
  btnPause: document.getElementById('btnPause'),
  btnMute: document.getElementById('btnMute'),
  btnRefreshLb: document.getElementById('btnRefreshLb'),
  lbBody: document.getElementById('lbBody'),
  status: document.getElementById('status'),
  finalScore: document.getElementById('finalScore'),
  finalLevel: document.getElementById('finalLevel'),
  finalHigh: document.getElementById('finalHigh'),
  finalNote: document.getElementById('finalNote'),
  vicScore: document.getElementById('vicScore'),
  vicLives: document.getElementById('vicLives'),
  vicHigh: document.getElementById('vicHigh'),
  levelClearTitle: document.getElementById('levelClearTitle'),
  levelClearDetail: document.getElementById('levelClearDetail'),
};

// ───────────────────────── 运行时状态 ─────────────────────────
const game = {
  state: State.IDLE,
  level: 1,
  score: 0,
  lives: START_LIVES,
  levelTimeLeft: 0, // 秒
  player: { x: CANVAS_W / 2, y: PLAYER_Y, vx: 0, invulnUntil: 0 },
  obstacles: [],
  orbs: [],
  lasers: [],
  particles: [],
  spawnAcc: 0,
  laserAcc: 0,
  scoreAcc: 0, // 累积秒以加生存分
  highScore: 0,
  maxUnlocked: 1,
  rafId: 0,
  lastTs: 0,
  sessionSavedAt: 0,
  currentUsername: null,
};

const input = { left: false, right: false };
const prefs = getLocalPrefs();
let audioCtx = null;

// ───────────────────────── 音效 (合成) ─────────────────────────
function ensureAudio() {
  if (prefs.muted) return null;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { audioCtx = null; }
  }
  return audioCtx;
}
function beep(freq, durMs, type = 'sine', gain = 0.06) {
  const ac = ensureAudio();
  if (!ac) return;
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + durMs / 1000 + 0.02);
}
const sfx = {
  collect: () => beep(880, 110, 'triangle', 0.05),
  hit:     () => { beep(180, 200, 'sawtooth', 0.09); },
  clear:   () => { beep(660, 90, 'triangle', 0.06); setTimeout(() => beep(990, 130, 'triangle', 0.06), 100); },
  victory: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 180, 'triangle', 0.07), i * 140)); },
  start:   () => beep(520, 80, 'square', 0.04),
};

// ───────────────────────── 工具 ─────────────────────────
function setStatus(text, kind = '') {
  els.status.textContent = text || '';
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

// ───────────────────────── 实体生成 ─────────────────────────
function spawnObstacle(lv) {
  const size = lv.size + rand(-2, 4);
  const isSplitter = lv.splitter && Math.random() < 0.18;
  game.obstacles.push({
    x: rand(size, CANVAS_W - size),
    y: -size,
    w: size,
    h: size,
    vy: lv.speed * rand(0.85, 1.15),
    vx: 0,
    splitter: isSplitter,
    splitAt: isSplitter ? CANVAS_H * 0.45 : -1,
    rot: rand(0, Math.PI),
    vr: rand(-0.04, 0.04),
  });
}
function spawnOrb() {
  game.orbs.push({
    x: rand(ORB_R + 4, CANVAS_W - ORB_R - 4),
    y: -ORB_R,
    vy: rand(1.2, 1.9),
    pulse: 0,
  });
}
function maybeSpawnLaser(lv) {
  if (!lv.lasers) return;
  const y = rand(CANVAS_H * 0.25, CANVAS_H * 0.7);
  game.lasers.push({
    y,
    state: 'telegraph',
    age: 0,
  });
}

// ───────────────────────── 粒子 ─────────────────────────
function burst(x, y, color, n = 12) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(0.6, 2.4);
    game.particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: rand(280, 520),
      max: 520,
      color,
    });
  }
}

// ───────────────────────── 关卡控制 ─────────────────────────
function startLevel(n) {
  const lv = getLevel(n);
  game.level = n;
  game.levelTimeLeft = lv.duration;
  game.obstacles.length = 0;
  game.orbs.length = 0;
  game.lasers.length = 0;
  game.particles.length = 0;
  game.spawnAcc = 0;
  game.laserAcc = 0;
  game.scoreAcc = 0;
  game.player.x = CANVAS_W / 2;
  game.player.vx = 0;
  game.player.invulnUntil = performance.now() + 600; // 关卡入场短暂无敌
  game.state = State.PLAYING;
  hideAllOverlays();
  syncHud();
  game.lastTs = performance.now();
  game.rafId = requestAnimationFrame(tick);
  sfx.start();
}

function startRun(fromLevel = 1) {
  game.score = 0;
  game.lives = START_LIVES;
  startLevel(fromLevel);
}

// ───────────────────────── 游戏循环 ─────────────────────────
function tick(ts) {
  if (game.state !== State.PLAYING) return;
  let dt = ts - game.lastTs;
  game.lastTs = ts;
  if (dt > 50) dt = 50; // 防卡顿穿模

  update(dt);
  render();
  syncHud();

  // 每 2 秒落一次本地会话 (刷新可继续)
  if (ts - game.sessionSavedAt > 2000) {
    saveSession({ level: game.level, score: game.score, lives: game.lives, ts: Date.now() });
    game.sessionSavedAt = ts;
  }

  game.rafId = requestAnimationFrame(tick);
}

function update(dt) {
  const lv = getLevel(game.level);
  const dts = dt / 1000;
  const now = performance.now();

  // ── 玩家 ──
  const move = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  game.player.vx = move * PLAYER_SPEED;
  game.player.x = clamp(game.player.x + game.player.vx, PLAYER_W / 2, CANVAS_W - PLAYER_W / 2);

  // ── 时间 / 生存分 ──
  game.levelTimeLeft -= dts;
  game.scoreAcc += dts;
  while (game.scoreAcc >= 1) {
    game.scoreAcc -= 1;
    game.score += scorePerSecond(game.level);
  }
  if (game.levelTimeLeft <= 0) {
    onLevelClear();
    return;
  }

  // ── 生成 ──
  game.spawnAcc += dt;
  while (game.spawnAcc >= lv.spawnMs) {
    game.spawnAcc -= lv.spawnMs;
    spawnObstacle(lv);
    if (Math.random() < ORB_CHANCE) spawnOrb();
  }
  game.laserAcc += dt;
  if (lv.lasers && game.laserAcc >= LASER_INTERVAL_MS) {
    game.laserAcc = 0;
    maybeSpawnLaser(lv);
  }

  // ── 障碍 ──
  for (let i = game.obstacles.length - 1; i >= 0; i--) {
    const o = game.obstacles[i];
    o.y += o.vy;
    o.x += o.vx;
    o.rot += o.vr;
    if (o.splitter && o.y >= o.splitAt) {
      // 分裂: 当前体改横向偏移, 再生成一个反向偏移的副本
      o.splitter = false;
      o.splitAt = -1;
      o.vx = -1.6;
      game.obstacles.push({ ...o, x: o.x, y: o.y, vx: 1.6, vr: -o.vr });
    }
    if (o.y - o.h > CANVAS_H) {
      game.obstacles.splice(i, 1);
      continue;
    }
    if (now >= game.player.invulnUntil && rectHitsPlayer(o)) {
      onPlayerHit();
      if (game.state !== State.PLAYING) return;
    }
  }

  // ── 核心 ──
  for (let i = game.orbs.length - 1; i >= 0; i--) {
    const orb = game.orbs[i];
    orb.y += orb.vy;
    orb.pulse += dt;
    if (orb.y - ORB_R > CANVAS_H) { game.orbs.splice(i, 1); continue; }
    const dx = orb.x - game.player.x;
    const dy = orb.y - (PLAYER_Y + (PLAYER_H / 2 - ORB_R));
    if (dx * dx + dy * dy < (ORB_R + PLAYER_W / 2) ** 2) {
      game.orbs.splice(i, 1);
      game.score += scorePerOrb(game.level);
      burst(orb.x, orb.y, '#fbbf24', 10);
      sfx.collect();
    }
  }

  // ── 激光 ──
  for (let i = game.lasers.length - 1; i >= 0; i--) {
    const l = game.lasers[i];
    l.age += dt;
    if (l.state === 'telegraph' && l.age >= LASER_TELEGRAPH_MS) {
      l.state = 'active'; l.age = 0;
    } else if (l.state === 'active') {
      if (now >= game.player.invulnUntil
          && Math.abs(l.y - (PLAYER_Y + PLAYER_H / 2)) < PLAYER_H / 2 + 4) {
        onPlayerHit();
        if (game.state !== State.PLAYING) return;
      }
      if (l.age >= LASER_ACTIVE_MS) game.lasers.splice(i, 1);
    }
  }

  // ── 粒子 ──
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const p = game.particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.05;
    p.life -= dt;
    if (p.life <= 0) game.particles.splice(i, 1);
  }
}

function rectHitsPlayer(o) {
  // AABB vs 玩家中心矩形
  const px = game.player.x - PLAYER_W / 2;
  const py = PLAYER_Y;
  return o.x - o.w / 2 < px + PLAYER_W
      && o.x + o.w / 2 > px
      && o.y - o.h / 2 < py + PLAYER_H
      && o.y + o.h / 2 > py;
}

function onPlayerHit() {
  game.lives -= 1;
  game.player.invulnUntil = performance.now() + INVULN_MS;
  burst(game.player.x, PLAYER_Y + PLAYER_H / 2, '#fb7185', 18);
  sfx.hit();
  if (game.lives <= 0) {
    game.lives = 0;
    endRun(false);
  }
}

function onLevelClear() {
  const bonus = scoreLevelClear(game.level);
  game.score += bonus;
  sfx.clear();
  cancelAnimationFrame(game.rafId);
  game.state = State.LEVEL_CLEAR;

  if (game.level >= TOTAL_LEVELS) {
    // 通关
    game.score += VICTORY_BONUS;
    saveProgress(game.level, game.score).catch(() => {});
    submitScore(game.score, game.level).then(r => refreshLeaderboardFrom(r.leaderboard)).catch(() => {});
    clearSession();
    sfx.victory();
    showVictory();
    return;
  }

  // 中间关过渡: 显示 1.6s 横幅, 然后进入下一关
  els.levelClearTitle.textContent = `第 ${game.level} 关通过`;
  els.levelClearDetail.textContent = `奖励 +${bonus}, 准备第 ${game.level + 1} 关…`;
  showOverlay(els.overlayLevelClear);
  // 存档最大解锁关 = 下一关
  saveProgress(game.level + 1, game.score).catch(() => {});
  setTimeout(() => {
    if (game.state === State.LEVEL_CLEAR) startLevel(game.level + 1);
  }, 1600);
}

function endRun(victory) {
  cancelAnimationFrame(game.rafId);
  // 别让障碍继续刷新
  game.state = State.GAME_OVER;
  saveProgress(game.level, game.score).catch(() => {});
  submitScore(game.score, game.level)
    .then(r => {
      refreshLeaderboardFrom(r.leaderboard);
      const note = r.rank && r.rank <= 10 ? `上榜了! 第 ${r.rank} 名` : '';
      els.finalNote.textContent = note;
    })
    .catch(() => { els.finalNote.textContent = '排行榜提交失败, 已忽略'; });
  clearSession();
  const isNewHigh = game.score > 0 && game.score >= game.highScore;
  els.finalScore.textContent = game.score;
  els.finalLevel.textContent = game.level;
  els.finalHigh.textContent = game.highScore;
  els.finalNote.textContent = isNewHigh ? '🏆 刷新历史最高!' : (els.finalNote.textContent || '');
  showOverlay(els.overlayGameOver);
}

function showVictory() {
  game.state = State.VICTORY;
  const isNewHigh = game.score >= game.highScore;
  els.vicScore.textContent = game.score;
  els.vicLives.textContent = game.lives;
  els.vicHigh.textContent = game.highScore;
  showOverlay(els.overlayVictory);
  if (isNewHigh) setStatus('🏆 新纪录!', 'ok');
}

// ───────────────────────── 渲染 ─────────────────────────
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // 背景网格
  ctx.save();
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= CANVAS_W; x += 30) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_H; y += 30) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }
  ctx.restore();

  // 激光 (画在玩家之下)
  for (const l of game.lasers) {
    if (l.state === 'telegraph') {
      const t = l.age / LASER_TELEGRAPH_MS;
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * Math.PI * 6);
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(0, l.y - 2, CANVAS_W, 4);
      ctx.restore();
    } else {
      ctx.save();
      const grad = ctx.createLinearGradient(0, l.y - 10, 0, l.y + 10);
      grad.addColorStop(0, 'rgba(251, 113, 133, 0)');
      grad.addColorStop(0.5, 'rgba(251, 113, 133, 0.95)');
      grad.addColorStop(1, 'rgba(251, 113, 133, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, l.y - 10, CANVAS_W, 20);
      ctx.restore();
    }
  }

  // 障碍
  for (const o of game.obstacles) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.rot);
    const grad = ctx.createLinearGradient(-o.w / 2, -o.h / 2, o.w / 2, o.h / 2);
    grad.addColorStop(0, '#67e8f9');
    grad.addColorStop(1, '#3b82f6');
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(103,232,249,0.6)';
    ctx.shadowBlur = 12;
    ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
    ctx.restore();
  }

  // 能量核心
  for (const orb of game.orbs) {
    const pulse = 1 + 0.15 * Math.sin(orb.pulse / 120);
    ctx.save();
    ctx.shadowColor = '#fbbf24';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, ORB_R * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 粒子
  for (const p of game.particles) {
    ctx.save();
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    ctx.restore();
  }

  // 玩家
  const blink = performance.now() < game.player.invulnUntil
    && Math.floor(performance.now() / 100) % 2 === 0;
  if (!blink) {
    ctx.save();
    ctx.shadowColor = '#c084fc';
    ctx.shadowBlur = 18;
    const grad = ctx.createLinearGradient(0, PLAYER_Y, 0, PLAYER_Y + PLAYER_H);
    grad.addColorStop(0, '#c084fc');
    grad.addColorStop(1, '#7c3aed');
    ctx.fillStyle = grad;
    roundRect(ctx, game.player.x - PLAYER_W / 2, PLAYER_Y, PLAYER_W, PLAYER_H, 6);
    ctx.fill();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ───────────────────────── HUD / Overlay ─────────────────────────
function syncHud() {
  els.hudLevel.textContent = game.level;
  els.hudScore.textContent = game.score;
  els.hudLives.textContent = '♥'.repeat(Math.max(0, game.lives)) || '0';
  els.hudTime.textContent = Math.max(0, Math.ceil(game.levelTimeLeft)) + 's';
  els.hudHigh.textContent = Math.max(game.highScore, game.score);
}
function hideAllOverlays() {
  [els.overlayIdle, els.overlayPause, els.overlayLevelClear, els.overlayGameOver, els.overlayVictory]
    .forEach(o => o.classList.add('hidden'));
}
function showOverlay(node) {
  hideAllOverlays();
  node.classList.remove('hidden');
}
function showIdle() {
  game.state = State.IDLE;
  cancelAnimationFrame(game.rafId);
  hideAllOverlays();
  // 是否有可继续会话?
  const sess = prefs.session;
  if (sess && sess.level > 1 && sess.lives > 0 && Date.now() - (sess.ts || 0) < 1000 * 60 * 30) {
    els.continueLevel.textContent = sess.level;
    els.btnContinue.hidden = false;
  } else {
    els.btnContinue.hidden = true;
  }
  els.overlayIdle.classList.remove('hidden');
}

// ───────────────────────── 暂停 / 恢复 ─────────────────────────
function pause() {
  if (game.state !== State.PLAYING) return;
  game.state = State.PAUSED;
  cancelAnimationFrame(game.rafId);
  showOverlay(els.overlayPause);
}
function resume() {
  if (game.state !== State.PAUSED) return;
  game.state = State.PLAYING;
  hideAllOverlays();
  game.lastTs = performance.now();
  game.rafId = requestAnimationFrame(tick);
}

// ───────────────────────── 排行榜 ─────────────────────────
function refreshLeaderboardFrom(list) {
  if (!Array.isArray(list)) return;
  if (!list.length) {
    els.lbBody.innerHTML = '<tr><td colspan="4" class="muted">还没有记录 — 成为第一个!</td></tr>';
    return;
  }
  els.lbBody.innerHTML = list.map((row, i) => {
    const rankCls = i < 3 ? `rank-${i + 1}` : '';
    const meCls = row.username === game.currentUsername ? ' me' : '';
    return `<tr class="${rankCls}${meCls}">
      <td>${i + 1}</td>
      <td>${escapeHtml(row.display_name || row.username || '匿名')}</td>
      <td>${row.level || '-'}</td>
      <td style="text-align:right;">${row.score || 0}</td>
    </tr>`;
  }).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadLeaderboard() {
  try {
    const list = await fetchLeaderboard();
    refreshLeaderboardFrom(list);
  } catch (e) {
    els.lbBody.innerHTML = `<tr><td colspan="4" class="muted">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// ───────────────────────── 输入 ─────────────────────────
window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': input.left = true; e.preventDefault(); break;
    case 'ArrowRight': case 'd': case 'D': input.right = true; e.preventDefault(); break;
    case 'p': case 'P': case 'Escape':
      if (game.state === State.PLAYING) pause();
      else if (game.state === State.PAUSED) resume();
      e.preventDefault();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': input.left = false; break;
    case 'ArrowRight': case 'd': case 'D': input.right = false; break;
  }
});
// 触摸 / 鼠标: 点击 canvas 左半 / 右半
canvas.addEventListener('pointerdown', (e) => {
  if (game.state !== State.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * CANVAS_W;
  if (x < CANVAS_W / 2) input.left = true; else input.right = true;
});
canvas.addEventListener('pointerup', () => { input.left = false; input.right = false; });
canvas.addEventListener('pointerleave', () => { input.left = false; input.right = false; });

// 失焦自动暂停
window.addEventListener('blur', () => { if (game.state === State.PLAYING) pause(); });

// ───────────────────────── 按钮绑定 ─────────────────────────
els.btnStart.addEventListener('click', () => startRun(1));
els.btnContinue.addEventListener('click', () => {
  const sess = prefs.session;
  if (!sess) { startRun(1); return; }
  game.score = sess.score || 0;
  game.lives = sess.lives || START_LIVES;
  startLevel(sess.level || 1);
});
els.btnResume.addEventListener('click', resume);
els.btnRestart.addEventListener('click', () => { clearSession(); startRun(1); });
els.btnRetry.addEventListener('click', () => startRun(1));
els.btnAgain.addEventListener('click', () => startRun(1));
els.btnHome.addEventListener('click', () => { syncHud(); showIdle(); });
els.btnHome2.addEventListener('click', () => { syncHud(); showIdle(); });
els.btnPause.addEventListener('click', () => {
  if (game.state === State.PLAYING) pause();
  else if (game.state === State.PAUSED) resume();
});
els.btnMute.addEventListener('click', () => {
  prefs.muted = !prefs.muted;
  setMuted(prefs.muted);
  els.btnMute.textContent = '声音: ' + (prefs.muted ? '关' : '开');
  if (!prefs.muted) ensureAudio();
});
els.btnRefreshLb.addEventListener('click', loadLeaderboard);

// ───────────────────────── 启动 ─────────────────────────
async function bootstrap() {
  els.btnMute.textContent = '声音: ' + (prefs.muted ? '关' : '开');
  try {
    const me = await whoami();
    game.currentUsername = me.username;
  } catch { /* 离线态也能玩 */ }
  try {
    const p = await fetchProfile();
    game.highScore = p.highScore;
    game.maxUnlocked = p.maxUnlocked;
  } catch (e) {
    setStatus('档案加载失败, 仅本地模式', 'err');
  }
  syncHud();
  loadLeaderboard();
  showIdle();
}
bootstrap();
