/**
 * threebody-sim/backend/extension_backend_handler.js
 *
 * 入参: { username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }
 * 出参: { ok, ... }
 *
 * Action 路由:
 *   - whoami                       → 当前用户
 *   - list_scenarios               → 列出当前用户的预设 (返回 [{name, body_count, saved_at}])
 *   - save_scenario {name, data}   → 保存一个自定义场景 (按 user+name 覆盖)
 *   - load_scenario {name}         → 读取自定义场景
 *   - delete_scenario {name}       → 删除一个自定义场景
 *
 * 数据布局: ${ext_data_dir}/scenarios.json
 *   { "<username>": { "<name>": { body_count, data, saved_at } } }
 */
const path = require('path');
const fs = require('fs/promises');

const SCENARIO_FILE = 'scenarios.json';
const MAX_SCENARIOS_PER_USER = 50;
const MAX_NAME_LEN = 64;
const MAX_DATA_BYTES = 256 * 1024;  // 256KB per scenario

function isValidName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_NAME_LEN
    && /^[\w一-鿿\-\. ]{1,64}$/u.test(name);
}

async function loadAll(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveAll(p, data) {
  await fs.writeFile(p, JSON.stringify(data, null, 2));
}

function userStore(all, username) {
  if (!all[username]) all[username] = {};
  return all[username];
}

module.exports = async function threebodyHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const file = path.join(ext_data_dir, SCENARIO_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name };
  }

  if (action === 'list_scenarios') {
    const all = await loadAll(file);
    const store = all[username] || {};
    const list = Object.entries(store).map(([name, v]) => ({
      name,
      body_count: v && v.body_count,
      saved_at: v && v.saved_at,
    })).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
    return { ok: true, scenarios: list };
  }

  if (action === 'save_scenario') {
    const name = ext_main_payload && ext_main_payload.name;
    const data = ext_main_payload && ext_main_payload.data;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    if (!data || typeof data !== 'object') return { ok: false, error: 'invalid data' };

    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
      return { ok: false, error: 'scenario too large' };
    }

    const all = await loadAll(file);
    const store = userStore(all, username);

    const keys = Object.keys(store);
    if (!store[name] && keys.length >= MAX_SCENARIOS_PER_USER) {
      return { ok: false, error: `scenario limit reached (${MAX_SCENARIOS_PER_USER})` };
    }

    const bodies = Array.isArray(data.bodies) ? data.bodies : [];
    store[name] = {
      body_count: bodies.length,
      data,
      saved_at: Date.now(),
    };
    await saveAll(file, all);
    logger && logger.info && logger.info('save_scenario', { username, name, body_count: bodies.length });
    return { ok: true };
  }

  if (action === 'load_scenario') {
    const name = ext_main_payload && ext_main_payload.name;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    const all = await loadAll(file);
    const store = all[username] || {};
    const entry = store[name];
    if (!entry) return { ok: false, error: 'not found' };
    return { ok: true, data: entry.data, saved_at: entry.saved_at };
  }

  if (action === 'delete_scenario') {
    const name = ext_main_payload && ext_main_payload.name;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    const all = await loadAll(file);
    const store = all[username] || {};
    if (!store[name]) return { ok: false, error: 'not found' };
    delete store[name];
    await saveAll(file, all);
    logger && logger.info && logger.info('delete_scenario', { username, name });
    return { ok: true };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
