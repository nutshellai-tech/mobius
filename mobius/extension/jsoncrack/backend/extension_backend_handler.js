module.exports = async function ({ ext_main_payload, extension_name }) {
  const action = ext_main_payload && ext_main_payload.action;

  if (!action || action === 'health') {
    return {
      ok: true,
      extension_name,
      service: 'jsoncrack',
      backend: {
        type: 'external-node',
        default_url: 'http://<mobius-host>:18081',
      },
    };
  }

  return { ok: false, error: 'unsupported action' };
};
