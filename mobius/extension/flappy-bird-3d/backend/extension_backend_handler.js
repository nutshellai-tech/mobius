/**
 * flappy-bird-3d/backend/extension_backend_handler.js
 *
 * 协议: 由 mobius/backend/services/extension-invoker.js 在 worker_thread 里 require.
 *   入参 { username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }
 *   出参 (resolve) JSON, 序列化后 ≤ 5MB, 全程 ≤ 30s.
 *
 * 路由 (按 ext_main_payload.action 分发):
 *   - whoami                       → 返回用户身份
 *   - get_leaderboard              → top 10
 *   - submit_score { score, ... }  → 写排行榜, 返回排名
 *
 * 数据: ${ext_data_dir}/leaderboard.json (TOP 100)
 */
const path = require('path');
const fs = require('fs/promises');

const MAX_SCORE = 1_000_000;
const TOP_N_PERSIST = 100;
const TOP_N_RETURN = 10;

async function loadList(lbPath) {
  try {
    const raw = await fs.readFile(lbPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = async function flappyBird3dHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const lbPath = path.join(ext_data_dir, 'leaderboard.json');

  if (action === 'whoami') {
    return { ok: true, username, display_name };
  }

  if (action === 'get_leaderboard') {
    const list = await loadList(lbPath);
    return {
      ok: true,
      leaderboard: list.slice(0, TOP_N_RETURN),
      total: list.length,
    };
  }

  if (action === 'submit_score') {
    const rawScore = ext_main_payload.score;
    const score = Number(rawScore) | 0;
    if (!Number.isFinite(rawScore) || score < 0 || score > MAX_SCORE) {
      return { ok: false, error: 'invalid score' };
    }
    const list = await loadList(lbPath);

    const prev = list.find((r) => r.username === username);
    const prevBest = prev ? prev.score : -1;
    const isBest = score > prevBest;

    const entry = {
      username,
      display_name: display_name || username,
      score,
      ts: Date.now(),
    };

    if (prev) {
      if (isBest) {
        prev.score = score;
        prev.ts = entry.ts;
        prev.display_name = entry.display_name;
      }
    } else {
      list.push(entry);
    }

    list.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const trimmed = list.slice(0, TOP_N_PERSIST);
    await fs.writeFile(lbPath, JSON.stringify(trimmed, null, 2));

    const rank = trimmed.findIndex((r) => r.username === username) + 1;
    logger && logger.info && logger.info('submit_score', { username, score, rank, isBest });

    return {
      ok: true,
      rank: rank > 0 ? rank : null,
      is_best: isBest,
      previous_best: prevBest >= 0 ? prevBest : null,
      leaderboard: trimmed.slice(0, TOP_N_RETURN),
    };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
