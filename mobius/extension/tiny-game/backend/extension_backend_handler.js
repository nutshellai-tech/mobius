/**
 * tiny-game/backend/extension_backend_handler.js — 霓虹方阵 NEON LEAP.
 *
 * 协议: 由 mobius/backend/services/extension-invoker.js 在 worker_thread 里 require.
 *   入参 { username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }
 *   出参 JSON (≤5MB, 全程 ≤30s).
 *
 * 路由 (ext_main_payload.action):
 *   - whoami                              → 回显身份, 用于前端连通性自检
 *   - get_profile                         → { high_score, max_unlocked_level, last_played }
 *   - save_progress { level, score }      → 更新最高分 + 最大解锁关
 *   - submit_score  { score, level }      → 写排行榜 + 返回 top10 + rank
 *   - get_leaderboard                     → top10
 *
 * 数据:
 *   ${ext_data_dir}/profile.json     用户维度档案 (按 username 索引)
 *   ${ext_data_dir}/leaderboard.json 全局 Top 100
 */
const path = require('path');
const fs = require('fs/promises');

const MAX_SCORE = 10_000_000;
const MAX_LEVEL = 64; // 上限保护, 当前设计 8 关, 留扩展余量
const TOP_N_PERSIST = 100;
const TOP_N_RETURN = 10;

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function clampScore(raw) {
  const n = Number(raw) | 0;
  if (!Number.isFinite(raw) || n < 0 || n > MAX_SCORE) return null;
  return n;
}

function clampLevel(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > MAX_LEVEL) return null;
  return n;
}

module.exports = async function tinyGameHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const profileFile = path.join(ext_data_dir, 'profile.json');
  const leaderboardFile = path.join(ext_data_dir, 'leaderboard.json');

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name: 'tiny-game' };
  }

  if (action === 'get_profile') {
    const profiles = await readJson(profileFile, {});
    const me = profiles[username] || {};
    return {
      ok: true,
      high_score: me.high_score || 0,
      max_unlocked_level: me.max_unlocked_level || 1,
      last_played: me.last_played || 0,
    };
  }

  if (action === 'save_progress') {
    const level = clampLevel(ext_main_payload.level);
    const score = clampScore(ext_main_payload.score);
    if (level === null || score === null) {
      return { ok: false, error: 'invalid level or score' };
    }
    const profiles = await readJson(profileFile, {});
    const prev = profiles[username] || {};
    const next = {
      high_score: Math.max(prev.high_score || 0, score),
      max_unlocked_level: Math.max(prev.max_unlocked_level || 1, level),
      last_played: Date.now(),
    };
    profiles[username] = next;
    await writeJson(profileFile, profiles);
    logger && logger.info && logger.info('save_progress', { username, ...next });
    return { ok: true, profile: next };
  }

  if (action === 'submit_score') {
    const score = clampScore(ext_main_payload.score);
    const level = clampLevel(ext_main_payload.level);
    if (score === null || level === null) {
      return { ok: false, error: 'invalid score or level' };
    }
    const list = await readJson(leaderboardFile, []);
    const entry = {
      username,
      display_name: display_name || username,
      score,
      level,
      ts: Date.now(),
    };
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const trimmed = list.slice(0, TOP_N_PERSIST);
    await writeJson(leaderboardFile, trimmed);
    const rank = trimmed.findIndex((r) => r === entry) + 1;
    logger && logger.info && logger.info('submit_score', { username, score, level, rank });
    return {
      ok: true,
      rank: rank > 0 ? rank : null,
      leaderboard: trimmed.slice(0, TOP_N_RETURN),
    };
  }

  if (action === 'get_leaderboard') {
    const list = await readJson(leaderboardFile, []);
    return {
      ok: true,
      leaderboard: list.slice(0, TOP_N_RETURN),
      total: list.length,
    };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
