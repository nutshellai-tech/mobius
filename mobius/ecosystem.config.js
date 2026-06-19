const path = require('path');

const mobiusDir = __dirname;
const entrypoint = process.env.MOBIUS_PM2_ENTRYPOINT || path.join(mobiusDir, 'server.js');
const instances = process.env.MOBIUS_PM2_INSTANCES || '1';

const envKeys = [
  'APP_DIR',
  'MOBIUS_PORT',
  'VITE_PORT',
  'VITE_HOST',
  'VITE_ALLOWED_HOSTS',
  'VITE_API_TARGET',
  'VITE_HMR_PROTOCOL',
  'VITE_HMR_CLIENT_PORT',
  'CODE_SERVER_PORT',
  'CODE_SERVER_BIND',
  'CODE_SERVER_CWD',
  'VSCODE_WEB_URL',
  'CS_BIN',
  'CODE_SERVER_DATA_ROOT',
  'CS_DATA_ROOT',
  'CS_EXT_ROOT',
  'DB_PATH',
  'MOBIUS_DATA_PATH',
  'MODEL_ACCESS_PATH',
  'CORE_DATA_PATH',
  'JWT_SECRET',
  'ENABLE_PASSWORD_LOGIN',
  'WORKSPACE_ROOT',
  'HOME_WORKSPACE_ROOT',
  'LOCAL_WORKSPACE_ROOT',
  'TURNS_SUMMARY_DIR',
  'ASSISTANT_API_BASE',
  'ASSISTANT_API_KEY',
  'BEST_API_KEY',
  'ASSISTANT_MODEL',
  'CODEX_HOME',
  'IMAC_DEBUG_ENV_FILE',
  'IMAC_SKILLS_PROXY',
  'IMAC_SKILLS_NO_PROXY',
  'IMAC_TMUX_AGENT_INACTIVE_MS',
  'IMAC_TMUX_AGENT_CLEANUP_INTERVAL_MS',
  'IMAC_TMUX_AGENT_CLEANUP_FIRST_DELAY_MS',
  'CS_PORT_BASE',
  'CS_POOL_MAX',
  'CS_IDLE_TIMEOUT_MIN',
  'CS_MAX_PER_USER',
  'CS_MAX_TOTAL',
  'CS_READY_TIMEOUT_MS',
  'IMAC_BOOTSTRAP_USERS',
  'NPM_REGISTRY',
  'MOBIUS_OTHER_VERSION_HASH',
  'MOBIUS_OTHER_VERSION_WORKTREE',
  'AIMUX_BRIDGE_HOST',
  'AIMUX_BRIDGE_PORT',
  'AIMUX_BRIDGE_RUNTIME',
];

const inheritedEnv = {};
for (const key of envKeys) {
  if (process.env[key] !== undefined) inheritedEnv[key] = process.env[key];
}

module.exports = {
  apps: [
    {
      name: 'imac-mobius',
      cwd: mobiusDir,
      script: entrypoint,
      exec_mode: 'cluster',
      instances,
      autorestart: true,
      kill_timeout: 8000,
      listen_timeout: 10000,
      max_memory_restart: process.env.MOBIUS_PM2_MAX_MEMORY || '1G',
      out_file: '/tmp/mobius-server.log',
      error_file: '/tmp/mobius-server-error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...inheritedEnv,
      },
    },
    {
      // aimux bridge broker: 反向 SSE broker, 客户端 (windows/外部机器) 反向连进来,
      // mobius 后端 /aimux_bridge/* 反代到本进程. runtime.json 由它自己写入 AIMUX_BRIDGE_RUNTIME.
      name: 'imac-mobius-bridge',
      cwd: mobiusDir,
      script: path.join(mobiusDir, '.venv-aimux', 'bin', 'aimux'),
      args: `bridge deploy --host ${process.env.AIMUX_BRIDGE_HOST || '127.0.0.1'} --port ${process.env.AIMUX_BRIDGE_PORT || '45615'}`,
      interpreter: 'none',
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 5000,
      max_memory_restart: '256M',
      out_file: '/tmp/mobius-bridge.log',
      error_file: '/tmp/mobius-bridge-error.log',
      merge_logs: true,
      env: {
        ...inheritedEnv,
      },
    },
  ],
};
