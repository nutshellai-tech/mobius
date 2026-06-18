// game/UI.js — DOM / HUD / 菜单 / 浮层控制器
import { POWERUP_META } from './Config.js';

export class UI {
  constructor() {
    this.el = {
      stage: document.getElementById('stage'),
      hud: document.getElementById('hud'),
      score: document.getElementById('scoreVal'),
      best: document.getElementById('bestVal'),
      speed: document.getElementById('speedVal'),
      pauseBtn: document.getElementById('pauseBtn'),
      powerups: document.getElementById('powerups'),
      menu: document.getElementById('menu'),
      pauseOverlay: document.getElementById('pauseOverlay'),
      gameOver: document.getElementById('gameOver'),
      finalScore: document.getElementById('finalScore'),
      finalBest: document.getElementById('finalBest'),
      finalRank: document.getElementById('finalRank'),
      newBestBadge: document.getElementById('newBestBadge'),
      leaderboard: document.getElementById('leaderboard'),
      finalLeaderboard: document.getElementById('finalLeaderboard'),
      loader: document.getElementById('loader'),
    };

    this._bind();
  }

  hideLoader() { this.el.loader.classList.add('hidden'); }
  showHud() { this.el.hud.classList.remove('hidden'); this.el.powerups.classList.remove('hidden'); }

  hideAllOverlays() {
    this.el.menu.classList.add('hidden');
    this.el.pauseOverlay.classList.add('hidden');
    this.el.gameOver.classList.add('hidden');
  }

  showMenu() {
    this.hideAllOverlays();
    this.el.menu.classList.remove('hidden');
    this.el.hud.classList.add('hidden');
    this.el.powerups.classList.add('hidden');
  }

  showPause() {
    this.el.pauseOverlay.classList.remove('hidden');
  }

  hidePause() {
    this.el.pauseOverlay.classList.add('hidden');
  }

  showGameOver({ score, best, rank, isBest, leaderboard }) {
    this.hideAllOverlays();
    this.el.gameOver.classList.remove('hidden');
    this.el.finalScore.textContent = score;
    this.el.finalBest.textContent = best;
    this.el.finalRank.textContent = rank ? '#' + rank : '-';
    this.el.newBestBadge.classList.toggle('hidden', !isBest);
    this.renderLeaderboard('finalLeaderboard', leaderboard);
    this.el.hud.classList.add('hidden');
    this.el.powerups.classList.add('hidden');
  }

  setScore(s) { this.el.score.textContent = s; }
  setBest(b) { this.el.best.textContent = b; }
  setSpeed(mult) {
    this.el.speed.textContent = mult.toFixed(1) + 'x';
  }

  renderPowerups(snapshot) {
    const wrap = this.el.powerups;
    wrap.innerHTML = '';
    for (const item of snapshot) {
      const meta = item.meta;
      const chip = document.createElement('div');
      chip.className = 'pu-chip pu-' + item.type;
      const time = item.infinite ? '∞' : Math.max(0, item.remaining).toFixed(1) + 's';
      const pct = item.infinite ? 100 : Math.max(0, Math.min(100, (item.remaining / item.total) * 100));
      chip.innerHTML = `
        <span class="pu-icon">${meta.icon}</span>
        <span class="pu-time">${time}</span>
        <span class="pu-bar" style="width: ${pct}%"></span>
      `;
      wrap.appendChild(chip);
    }
    wrap.classList.toggle('hidden', snapshot.length === 0);
  }

  renderLeaderboard(target, list) {
    const node = typeof target === 'string' ? this.el[target] : target;
    if (!node) return;
    if (!list || list.length === 0) {
      node.innerHTML = '<li class="lb-empty">暂无数据</li>';
      return;
    }
    const me = (window.__EXT_USER__ || '').toLowerCase();
    node.innerHTML = list.map((r, i) => {
      const isMe = r.username && r.username.toLowerCase() === me;
      return `<li class="${isMe ? 'me' : ''}">
        <span class="lb-rank">#${i + 1}</span>
        <span class="lb-name">${escapeHtml(r.display_name || r.username || 'anon')}</span>
        <span class="lb-score">${r.score}</span>
      </li>`;
    }).join('');
  }

  flashPickup(type) {
    // 简易: 屏幕边缘扫光
    const meta = POWERUP_META[type];
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 25;
      background: radial-gradient(ellipse at center, transparent 40%, ${meta.hex}44 100%);
      animation: pickupFlash 0.5s ease-out forwards;
    `;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 500);
    if (!document.getElementById('pickupFlashStyle')) {
      const style = document.createElement('style');
      style.id = 'pickupFlashStyle';
      style.textContent = `
        @keyframes pickupFlash {
          0%   { opacity: 0; }
          30%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  flashDeath() {
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 25;
      background: radial-gradient(ellipse at center, transparent 30%, #ff2bd6aa 100%);
      animation: pickupFlash 0.6s ease-out forwards;
    `;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 600);
  }

  _bind() {
    // 按钮事件分发由 Game 注册
    this._cb = {};
    this.el.pauseBtn?.addEventListener('click', () => this._fire('pause'));
    document.getElementById('startBtn')?.addEventListener('click', () => this._fire('start'));
    document.getElementById('resumeBtn')?.addEventListener('click', () => this._fire('resume'));
    document.getElementById('restartFromPauseBtn')?.addEventListener('click', () => this._fire('restartFromPause'));
    document.getElementById('retryBtn')?.addEventListener('click', () => this._fire('retry'));
    document.getElementById('backMenuBtn')?.addEventListener('click', () => this._fire('backMenu'));
  }

  onStart(fn)    { this._cb.start = fn; }
  onPause(fn)    { this._cb.pause = fn; }
  onResume(fn)   { this._cb.resume = fn; }
  onRestartFromPause(fn) { this._cb.restartFromPause = fn; }
  onRetry(fn)    { this._cb.retry = fn; }
  onBackMenu(fn) { this._cb.backMenu = fn; }

  _fire(name) { if (this._cb[name]) this._cb[name](); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
