module.exports = async function momoMobileHandler({
  username,
  display_name,
  extension_name,
  ext_main_payload,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  if (action === 'whoami') {
    return {
      ok: true,
      username,
      display_name: display_name || username || '',
      extension_name,
    };
  }
  return { ok: false, error: 'unknown action' };
};
