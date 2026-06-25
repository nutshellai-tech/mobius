/**
 * mobius-deck/backend/extension_backend_handler.js — Mobius 方案演示 handler.
 *
 * 这是一个纯静态演示型 extension, 前端不需要后端数据. handler 只暴露
 * 一个 meta action 用于健康检查与回显身份, 方便排查 SDK 链路是否打通.
 */
module.exports = async function mobiusDeckHandler({
  username,
  display_name,
  ext_main_payload,
}) {
  const action = ext_main_payload && ext_main_payload.action;

  if (action === 'meta' || action === undefined) {
    return {
      ok: true,
      extension: 'mobius-deck',
      version: '0.1.0',
      username,
      display_name: display_name || username,
      slides: 6,
    };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
