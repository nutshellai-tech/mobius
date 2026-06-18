// game/Backend.js — 排行榜 API 调用封装
import { extCall, extName } from '/extension/_sdk/ext.js';

export class Backend {
  async whoami() {
    try {
      const r = await extCall({ action: 'whoami' });
      return r && r.ok ? r : null;
    } catch { return null; }
  }

  async getLeaderboard() {
    try {
      const r = await extCall({ action: 'get_leaderboard' });
      return r && r.ok ? (r.leaderboard || []) : [];
    } catch { return []; }
  }

  async submitScore(score) {
    return await extCall({ action: 'submit_score', score });
  }

  name() { return extName(); }
}
