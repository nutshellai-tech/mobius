// game/Input.js — 键盘 / 鼠标 / 触摸输入分发
export class Input {
  constructor(target = window) {
    this.target = target;
    this.handlers = { flap: [], pause: [], restart: [], menu: [] };
    this._init();
  }

  on(event, fn) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
  }

  _emit(event, payload) {
    for (const fn of (this.handlers[event] || [])) {
      try { fn(payload); } catch (e) { console.error('input handler err', e); }
    }
  }

  flap() { this._emit('flap'); }
  pause() { this._emit('pause'); }
  restart() { this._emit('restart'); }
  menu() { this._emit('menu'); }

  _init() {
    const keyDown = (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'Space':
        case 'ArrowUp':
        case 'KeyW':
          e.preventDefault();
          this._emit('flap');
          break;
        case 'KeyP':
        case 'Escape':
          this._emit('pause');
          break;
        case 'KeyR':
          this._emit('restart');
          break;
        case 'KeyM':
          this._emit('menu');
          break;
      }
    };

    const mouseDown = (e) => {
      // 忽略 UI 上的点击 (按钮等)
      if (e.target && e.target.closest && e.target.closest('button, .overlay, .hud, .powerups')) return;
      this._emit('flap');
    };

    const touchStart = (e) => {
      if (e.target && e.target.closest && e.target.closest('button, .overlay, .hud, .powerups')) return;
      e.preventDefault();
      this._emit('flap');
    };

    this.target.addEventListener('keydown', keyDown);
    window.addEventListener('mousedown', mouseDown);
    window.addEventListener('touchstart', touchStart, { passive: false });

    this._cleanup = () => {
      this.target.removeEventListener('keydown', keyDown);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('touchstart', touchStart);
    };
  }

  destroy() {
    if (this._cleanup) this._cleanup();
  }
}
