/**
 * 存档层. 两路持久化:
 *  - localStorage: 客户端瞬时状态 (静音, 上次会话, 用于刷新后继续)
 *  - 后端 extCall: 用户档案 (最高分, 最大解锁关) + 全局排行榜
 *
 * 任意一路失败都不应阻塞游戏循环.
 */
import { extCall } from '/extension/_sdk/ext.js';

const LS_KEY = 'tiny-game/v1';

function readLS() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLS(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* localStorage 不可用 (隐私模式等) — 静默降级 */
  }
}

export function getLocalPrefs() {
  const ls = readLS();
  return {
    muted: !!ls.muted,
    session: ls.session || null, // { level, score, lives }
  };
}

export function setMuted(muted) {
  const ls = readLS();
  ls.muted = !!muted;
  writeLS(ls);
}

export function saveSession(session) {
  const ls = readLS();
  ls.session = session;
  writeLS(ls);
}

export function clearSession() {
  const ls = readLS();
  delete ls.session;
  writeLS(ls);
}

export async function fetchProfile() {
  const r = await extCall({ action: 'get_profile' });
  if (!r || r.ok === false) throw new Error(r?.error || '加载档案失败');
  return {
    highScore: r.high_score || 0,
    maxUnlocked: r.max_unlocked_level || 1,
    lastPlayed: r.last_played || 0,
  };
}

export async function saveProgress(level, score) {
  const r = await extCall({ action: 'save_progress', level, score });
  if (!r || r.ok === false) throw new Error(r?.error || '保存进度失败');
  return r.profile;
}

export async function submitScore(score, level) {
  const r = await extCall({ action: 'submit_score', score, level });
  if (!r || r.ok === false) throw new Error(r?.error || '提交分数失败');
  return { rank: r.rank, leaderboard: r.leaderboard || [] };
}

export async function fetchLeaderboard() {
  const r = await extCall({ action: 'get_leaderboard' });
  if (!r || r.ok === false) throw new Error(r?.error || '加载排行榜失败');
  return r.leaderboard || [];
}

export async function whoami() {
  const r = await extCall({ action: 'whoami' });
  return r;
}
