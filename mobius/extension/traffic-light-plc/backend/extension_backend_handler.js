/**
 * traffic-light-plc/backend/extension_backend_handler.js
 *
 * 行为: 仿真类拓展, 无持久化数据. 仅作为莫比乌斯拓展协议样板,
 *       实际行为完全在前端 main.js 中模拟.
 *
 * 路由:
 *   - whoami        → 当前用户
 *   - get_spec      → 阶段表 + I/O 清单 (供前端或调试)
 *   - log_event     → 记录用户在仿真中触发的启停事件 (写到 _events.log)
 */
const path = require('path');
const fs = require('fs/promises');

const PHASES = [
  { id: 'P1',  m: 'M0.1', label: '东西左转·绿', start: 0,    end: 250,  type: 'green' },
  { id: 'P1Y', m: 'M0.2', label: '东西左转·黄', start: 250,  end: 280,  type: 'yellow' },
  { id: 'P1R', m: 'M0.3', label: '全红清空1',   start: 280,  end: 300,  type: 'red' },
  { id: 'P2',  m: 'M0.4', label: '东西直行·绿', start: 300,  end: 600,  type: 'green' },
  { id: 'P2Y', m: 'M0.5', label: '东西直行·黄', start: 600,  end: 630,  type: 'yellow' },
  { id: 'P2R', m: 'M0.6', label: '全红清空2',   start: 630,  end: 650,  type: 'red' },
  { id: 'P3',  m: 'M0.7', label: '南北左转·绿', start: 650,  end: 900,  type: 'green' },
  { id: 'P3Y', m: 'M1.0', label: '南北左转·黄', start: 900,  end: 930,  type: 'yellow' },
  { id: 'P3R', m: 'M1.1', label: '全红清空3',   start: 930,  end: 950,  type: 'red' },
  { id: 'P4',  m: 'M1.2', label: '南北直行·绿', start: 950,  end: 1250, type: 'green' },
  { id: 'P4Y', m: 'M1.3', label: '南北直行·黄', start: 1250, end: 1280, type: 'yellow' },
  { id: 'P4R', m: 'M1.4', label: '全红清空4',   start: 1280, end: 1300, type: 'red' },
];

const IO = {
  inputs: [
    { addr: 'I0.0', symbol: 'SB1', desc: '启动按钮 (NO)' },
    { addr: 'I0.1', symbol: 'SB2', desc: '停止按钮 (NC)' },
    { addr: 'I0.2', symbol: 'SB3', desc: '急停全红 (NC)' },
  ],
  outputs: [
    { addr: 'Q0.0', desc: '东西左转 绿' },
    { addr: 'Q0.1', desc: '东西左转 黄' },
    { addr: 'Q0.2', desc: '东西直行 绿' },
    { addr: 'Q0.3', desc: '东西直行 黄' },
    { addr: 'Q0.4', desc: '南北左转 绿' },
    { addr: 'Q0.5', desc: '南北左转 黄' },
    { addr: 'Q0.6', desc: '南北直行 绿' },
    { addr: 'Q0.7', desc: '南北直行 黄' },
    { addr: 'Q1.0', desc: '东西方向 红灯 (共用)' },
    { addr: 'Q1.1', desc: '南北方向 红灯 (共用)' },
  ],
};

module.exports = async function trafficLightHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;

  if (action === 'whoami') {
    return { ok: true, username, display_name };
  }

  if (action === 'get_spec') {
    return { ok: true, phases: PHASES, io: IO, cycle_ticks: 1300, cycle_seconds: 130 };
  }

  if (action === 'log_event') {
    const evt = String((ext_main_payload && ext_main_payload.event) || '').slice(0, 32);
    if (!/^[a-z_]{1,32}$/i.test(evt)) return { ok: false, error: 'invalid event' };
    const logFile = path.join(ext_data_dir, '_events.log');
    const ts = new Date().toISOString();
    const line = `${ts}\t${username}\t${evt}\n`;
    try {
      await fs.appendFile(logFile, line, 'utf8');
    } catch (err) {
      return { ok: false, error: 'log failed' };
    }
    logger && logger.info && logger.info('log_event', { username, event: evt });
    return { ok: true };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
