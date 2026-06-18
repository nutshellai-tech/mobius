module.exports = async function ({ username, display_name }) {
  return {
    ok: true,
    report: {
      title: '莫比系统漏洞自查报告',
      generated_at: '2026-06-18',
      viewer: {
        username,
        display_name: display_name || username,
      },
    },
  };
};
