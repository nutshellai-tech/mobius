// pacman/frontend/main.js — 极简吃豆人 (10x10 grid).
//
// 与 mobius 后端通信: 通过 /extension/_sdk/ext.js 的 extCall(payload).
// 后端 handler: mobius/extension/pacman/backend/extension_backend_handler.js
//
// 注意: ESM 模块, 浏览器原生 import. 因为是新 tab, 与主前端 JS 完全隔离.

import { extCall } from '/extension/_sdk/ext.js';

// ===== 配置 =====
const COLS = 14, ROWS = 14;
const CELL = 30;
const FPS = 8;

// 1=墙 0=空 2=豆 (豆默认全填, 墙的位置由 wallMap 决定)
const wallMap = [
  '11111111111111',
  '10000000000001',
  '10110011001101',
  '10110011001101',
  '10000000000001',
  '10011001100101',
  '10011001100101',
  '10000110000001',
  '10110000110001',
  '10110000110001',
  '10000110000001',
  '10110011001101',
  '10000000000001',
  '11111111111111',
];

function newGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const ch = wallMap[r][c];
      if (ch === '1') row.push(1);
      else row.push(2);
    }
    g.push(row);
  }
  return g;
}

let grid;
let pac = { c: 1, r: 1, dx: 0, dy: 0 };
let ghosts = [];
let score = 0;
let lives = 3;
let running = false;
let gameOver = false;
let dotsLeft = 0;
let level = 1;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = COLS * CELL;
canvas.height = ROWS * CELL;

const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const statusEl = document.getElementById('status');
const msgEl = document.getElementById('msg');
const lbBody = document.getElementById('lb-body');

function setMsg(text, cls) {
  msgEl.textContent = text || '';
  msgEl.className = 'msg ' + (cls || '');
}

function isWall(c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
  return grid[r][c] === 1;
}

function countDots() {
  let n = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === 2) n++;
  return n;
}

function reset(full) {
  grid = newGrid();
  pac = { c: 1, r: 1, dx: 0, dy: 0 };
  ghosts = [
    { c: COLS - 2, r: 1, dx: -1, dy: 0, color: '#ef4444' },
    { c: 1, r: ROWS - 2, dx: 1, dy: 0, color: '#22c55e' },
    { c: COLS - 2, r: ROWS - 2, dx: 0, dy: -1, color: '#a855f7' },
  ];
  // 把 pacman 和 ghost 起点的豆清掉
  grid[pac.r][pac.c] = 0;
  for (const g of ghosts) grid[g.r][g.c] = 0;
  dotsLeft = countDots();
  if (full) {
    score = 0;
    lives = 3;
    level = 1;
    gameOver = false;
  }
  scoreEl.textContent = String(score);
  livesEl.textContent = String(lives);
}

function tryMove(actor, dx, dy) {
  const nc = actor.c + dx, nr = actor.r + dy;
  if (!isWall(nc, nr)) {
    actor.c = nc; actor.r = nr;
    return true;
  }
  return false;
}

function moveGhost(g) {
  // 优先继续当前方向; 撞墙时随机换向
  const opts = [
    [g.dx, g.dy],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  // 加点对玩家方向的偏好 (60% 几率追)
  if (Math.random() < 0.6) {
    const sx = Math.sign(pac.c - g.c), sy = Math.sign(pac.r - g.r);
    opts.unshift([sx, 0], [0, sy]);
  }
  for (const [dx, dy] of opts) {
    if (dx === 0 && dy === 0) continue;
    if (!isWall(g.c + dx, g.r + dy)) {
      g.dx = dx; g.dy = dy;
      g.c += dx; g.r += dy;
      return;
    }
  }
}

function checkCollision() {
  for (const g of ghosts) {
    if (g.c === pac.c && g.r === pac.r) {
      lives -= 1;
      livesEl.textContent = String(lives);
      if (lives <= 0) {
        endGame();
      } else {
        // 重置位置但保留分数
        pac.c = 1; pac.r = 1; pac.dx = 0; pac.dy = 0;
        setMsg(`被抓住! 剩余 ${lives} 命`, 'err');
      }
      return;
    }
  }
}

function endGame() {
  running = false;
  gameOver = true;
  statusEl.textContent = '游戏结束';
  setMsg(`游戏结束! 最终得分 ${score}, 正在上传到排行榜...`, '');
  submit();
}

async function submit() {
  try {
    const data = await extCall({ action: 'submit_score', score });
    if (data.ok) {
      setMsg(`已上榜! 排名 #${data.rank || '?'} (总得分 ${score})`, 'ok');
      renderLb(data.leaderboard || []);
    } else {
      setMsg('上榜失败: ' + (data.error || 'unknown'), 'err');
    }
  } catch (e) {
    setMsg('上榜失败: ' + e.message, 'err');
  }
}

async function loadLb() {
  try {
    const data = await extCall({ action: 'get_leaderboard' });
    renderLb(data.leaderboard || []);
  } catch (e) {
    lbBody.innerHTML = `<tr><td colspan="3" class="err">加载失败: ${e.message}</td></tr>`;
  }
}

function renderLb(list) {
  if (!list.length) {
    lbBody.innerHTML = '<tr><td colspan="3" style="color:#64748b;">暂无记录, 你将是第一个!</td></tr>';
    return;
  }
  lbBody.innerHTML = list.map((row, i) => {
    const rank = i + 1;
    const cls = `rank-${rank}`;
    return `<tr class="${cls}"><td>${rank}</td><td>${escapeHtml(row.display_name || row.username || '?')}</td><td style="text-align:right;">${row.score}</td></tr>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function step() {
  if (!running) return;
  // pac 持续按当前方向
  if (pac.dx || pac.dy) tryMove(pac, pac.dx, pac.dy);
  // 吃豆
  if (grid[pac.r][pac.c] === 2) {
    grid[pac.r][pac.c] = 0;
    score += 10;
    scoreEl.textContent = String(score);
    dotsLeft -= 1;
    if (dotsLeft <= 0) {
      score += 500;
      level += 1;
      reset(false);
      setMsg(`第 ${level} 关! +500`, 'ok');
    }
  }
  for (const g of ghosts) moveGhost(g);
  checkCollision();
  render();
}

function render() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = grid[r][c];
      const x = c * CELL, y = r * CELL;
      if (v === 1) {
        ctx.fillStyle = '#1e3a8a';
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = '#3b82f6';
        ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
      } else if (v === 2) {
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(x + CELL / 2, y + CELL / 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // ghosts
  for (const g of ghosts) {
    ctx.fillStyle = g.color;
    const x = g.c * CELL + CELL / 2, y = g.r * CELL + CELL / 2;
    ctx.beginPath();
    ctx.arc(x, y, CELL / 2 - 4, Math.PI, 0);
    ctx.lineTo(x + CELL / 2 - 4, y + CELL / 2 - 4);
    ctx.lineTo(x - CELL / 2 + 4, y + CELL / 2 - 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 6, y - 4, 4, 4);
    ctx.fillRect(x + 2, y - 4, 4, 4);
  }
  // pacman
  ctx.fillStyle = '#fde047';
  const px = pac.c * CELL + CELL / 2, py = pac.r * CELL + CELL / 2;
  const facing = (pac.dx === -1) ? Math.PI : (pac.dx === 1) ? 0 : (pac.dy === -1) ? -Math.PI / 2 : Math.PI / 2;
  const mouth = 0.3 + 0.2 * Math.sin(Date.now() / 100);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.arc(px, py, CELL / 2 - 3, facing + mouth, facing - mouth + Math.PI * 2);
  ctx.closePath();
  ctx.fill();
}

// ===== controls =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { document.getElementById('start').click(); return; }
  const map = {
    ArrowUp:   [0, -1], w: [0, -1], W: [0, -1],
    ArrowDown: [0,  1], s: [0,  1], S: [0,  1],
    ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
    ArrowRight:[ 1, 0], d: [ 1, 0], D: [ 1, 0],
  };
  const m = map[e.key];
  if (m) {
    pac.dx = m[0]; pac.dy = m[1];
    e.preventDefault();
  }
});

document.getElementById('start').addEventListener('click', () => {
  reset(true);
  running = true;
  gameOver = false;
  statusEl.textContent = '进行中';
  setMsg('开始!', 'ok');
});

document.getElementById('refresh').addEventListener('click', loadLb);

document.getElementById('who').addEventListener('click', async () => {
  try {
    const data = await extCall({ action: 'whoami' });
    setMsg(`你是: ${data.display_name} (${data.username})`, 'ok');
  } catch (e) {
    setMsg('whoami 失败: ' + e.message, 'err');
  }
});

// game loop
setInterval(step, 1000 / FPS);

// 初次进入立即加载排行榜
loadLb();
render();
