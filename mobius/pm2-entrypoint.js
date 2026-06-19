'use strict';
/**
 * pm2-entrypoint.js — PM2 cluster-mode 启动包装器 (MOBIUS_PM2_ENTRYPOINT 指向这里)。
 *
 * 为什么需要它: PM2 cluster 模式下, worker 在 require() 阶段同步抛错时 (典型例子是
 * backend/config.js 的生产环境配置守卫, 例如 JWT_SECRET 仍是 change-me 占位符),
 * 错误往往来不及经 cluster IPC 写进 error_file —— 表现为 error log 0 字节、
 * PM2 面板 status=errored 却没有任何线索, 后端陷入静默崩溃循环, 极难排查。
 *
 * 本包装器在 require('./server.js') 外层兜底: 任何启动期同步错误都会被
 * 同步 (appendFileSync) 追加写进集中日志目录的 mobius-server-error.log, 并打到 stderr。
 * 同步写保证即使 PM2 的 stderr 管道没接好, 文件里也一定留得下根因。
 * 该日志目录默认 /data/logs, 被 docker-compose 挂载到宿主机, 宿主机可直接查看。
 *
 * 运行正常时本包装器对行为无影响: require 成功后 server.js 调用 listen 进入事件循环,
 * 脚本顶层同步执行结束, 进程靠监听的 server 保持存活。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';
const ERROR_LOG = path.join(LOG_DIR, 'mobius-server-error.log');

function recordBootFailure(err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  const msg = `[pm2-entrypoint][${new Date().toISOString()}] BOOT_FAILURE: ${detail}\n`;
  // 同步写: 即使下面 process.exit(1) 之前 PM2 管道没刷新, 文件里也一定有这条。
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, msg);
  } catch (_) {
    // 日志写不动也不能挡住退出; stderr 再兜一次底。
  }
  try {
    process.stderr.write(msg);
  } catch (_) {
    /* ignore */
  }
}

try {
  require('./server.js');
} catch (err) {
  recordBootFailure(err);
  process.exit(1);
}
