// game/Effects.js — 玩家当前激活的道具效果 (state machine)
import { CONFIG, POWERUP_META } from './Config.js';

export class Effects {
  constructor() {
    // { type: { remaining: number, total: number } }
    this.active = Object.create(null);
    this.shieldActive = false;
    this.onChange = null;
  }

  reset() {
    this.active = Object.create(null);
    this.shieldActive = false;
    this._emit();
  }

  activate(type) {
    const duration = CONFIG.effects[type];
    if (type === 'shield') {
      this.shieldActive = true;
    } else if (duration !== undefined) {
      this.active[type] = { remaining: duration, total: duration };
    }
    this._emit();
  }

  has(type) {
    if (type === 'shield') return this.shieldActive;
    return !!this.active[type];
  }

  consumeShield() {
    if (!this.shieldActive) return false;
    this.shieldActive = false;
    this._emit();
    return true;
  }

  update(dt) {
    let changed = false;
    for (const key of Object.keys(this.active)) {
      const entry = this.active[key];
      entry.remaining -= dt;
      if (entry.remaining <= 0) {
        delete this.active[key];
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  get speedFactor() {
    return this.has('slow') ? 0.5 : 1.0;
  }

  get scoreFactor() {
    let f = 1;
    if (this.has('double')) f *= 2;
    if (this.has('magnet')) f *= 2;
    return f;
  }

  get collisionRadiusScale() {
    return this.has('tiny') ? 0.55 : 1.0;
  }

  snapshot() {
    const list = [];
    for (const key of Object.keys(this.active)) {
      const e = this.active[key];
      list.push({
        type: key,
        remaining: e.remaining,
        total: e.total,
        meta: POWERUP_META[key],
      });
    }
    if (this.shieldActive) {
      list.push({ type: 'shield', remaining: 0, total: 0, meta: POWERUP_META.shield, infinite: true });
    }
    return list;
  }

  _emit() {
    if (this.onChange) this.onChange(this.snapshot());
  }
}
