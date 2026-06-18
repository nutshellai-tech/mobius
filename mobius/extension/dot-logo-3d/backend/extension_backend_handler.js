/**
 * dot-logo-3d/backend/extension_backend_handler.js
 *
 * 入参: { username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }
 * 出参: { ok, ... }
 *
 * Action 路由:
 *   - whoami                  → 当前用户
 *   - list_presets            → 列出当前用户的预设 (返回 [{name, saved_at, point_count}])
 *   - save_preset {name, data}→ 保存一个用户自定义预设 (按 user+name 覆盖)
 *   - load_preset {name}      → 读取自定义预设
 *   - delete_preset {name}    → 删除一个自定义预设
 *
 * 数据布局: ${ext_data_dir}/presets.json
 *   { "<username>": { "<name>": { data, point_count, saved_at } } }
 */
const path = require('path');
const fs = require('fs/promises');

const PRESET_FILE = 'presets.json';
const MAX_PRESETS_PER_USER = 50;
const MAX_NAME_LEN = 64;
const MAX_DATA_BYTES = 256 * 1024; // 256KB per preset

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

module.exports = async function dotLogoHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const file = path.join(ext_data_dir, PRESET_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name };
  }

  if (action === 'list_presets') {
    const all = await loadAll(file);
    const store = all[username] || {};
    const list = Object.entries(store).map(([name, v]) => ({
      name,
      point_count: v && v.point_count,
      saved_at: v && v.saved_at,
    })).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
    return { ok: true, presets: list };
  }

  if (action === 'save_preset') {
    const name = ext_main_payload && ext_main_payload.name;
    const data = ext_main_payload && ext_main_payload.data;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    if (!data || typeof data !== 'object') return { ok: false, error: 'invalid data' };

    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
      return { ok: false, error: 'preset too large' };
    }

    const all = await loadAll(file);
    const store = userStore(all, username);

    const keys = Object.keys(store);
    if (!store[name] && keys.length >= MAX_PRESETS_PER_USER) {
      return { ok: false, error: `preset limit reached (${MAX_PRESETS_PER_USER})` };
    }

    const pointCount = Number.isFinite(Number(data.pointCount)) ? Number(data.pointCount) : 0;
    store[name] = {
      data,
      point_count: pointCount,
      saved_at: Date.now(),
    };
    await saveAll(file, all);
    logger && logger.info && logger.info('save_preset', { username, name, point_count: pointCount });
    return { ok: true };
  }

  if (action === 'load_preset') {
    const name = ext_main_payload && ext_main_payload.name;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    const all = await loadAll(file);
    const store = all[username] || {};
    const entry = store[name];
    if (!entry) return { ok: false, error: 'not found' };
    return { ok: true, data: entry.data, saved_at: entry.saved_at };
  }

  if (action === 'delete_preset') {
    const name = ext_main_payload && ext_main_payload.name;
    if (!isValidName(name)) return { ok: false, error: 'invalid name' };
    const all = await loadAll(file);
    const store = all[username] || {};
    if (!store[name]) return { ok: false, error: 'not found' };
    delete store[name];
    await saveAll(file, all);
    logger && logger.info && logger.info('delete_preset', { username, name });
    return { ok: true };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
