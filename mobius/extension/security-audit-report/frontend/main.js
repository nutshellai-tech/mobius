const exposures = [
  ['端口', '后端监听 0.0.0.0:45614，部署配置另有 47714', 'mobius/server.js:212；.env:2；deploy/.env:6-7', '取决于网络边界', '静态配置确认'],
  ['端口', '前端/Vite/code-server 配置端口 45616/45617，部署配置 47716/47717', '.env:3-4；deploy/.env:8-11', '未验证', '静态配置确认'],
  ['认证配置', '/api/auth/config 返回是否需要密码', 'mobius/backend/routes/auth.js:11', '无需认证', '静态确认'],
  ['登录入口', 'ENABLE_PASSWORD_LOGIN=false 时，/api/auth/login 只校验用户名', 'mobius/backend/routes/auth.js:15-31；.env:12', '无需认证', '静态确认，未 POST 验证'],
  ['本地账户', '本地 DB 存在活跃 system 用户，角色 admin', 'protected_data/mobuis.db 只读查询', '登录后为管理员', '本地只读确认'],
  ['健康信息', '/api/v2/health 暴露版本、commit、启动时间、env、port', 'mobius/server.js:135-150', '无需认证', '静态确认'],
  ['DB 计数', '/api/v2/db-check 暴露多张表计数', 'mobius/server.js:157-177', '无需认证', '静态确认'],
  ['健康接口', '/api/health、/memory、/disk 暴露服务状态、内存、磁盘信息', 'mobius/backend/routes/health.js:9,63,152', '无需认证', '静态确认'],
  ['Research 黑板', '/api/research-blackboard/:researchId GET/POST 无鉴权', 'mobius/backend/routes/researches.js:319-336', '无需认证', '静态确认，未请求'],
  ['Research 图谱', '/api/research-graph/:researchId GET 无鉴权', 'mobius/backend/routes/researches.js:338-349', '无需认证', '静态确认'],
  ['扩展前端', '/extension/_sdk/ext.js、/extension/:name/* 公开访问', 'mobius/backend/routes/ext.js:327,416', '无需认证', '静态确认'],
  ['敏感配置位置', 'JWT、模型、ASR/TTS、assistant key 等环境变量，只报告键名不展示值', '.env；.env.default；deploy/.env；deploy/claude/settings.api.json；deploy/codex/mobiusdefault.config.toml', '文件系统权限', '只列位置'],
];

const risks = [
  {
    level: '高',
    title: '当前配置下免密码登录可获得管理员权限',
    evidence: 'auth.js:15-31；config.js:81-83；.env:12；deploy/.env:20；protected_data/mobuis.db 只读查询 system=admin',
    attack: '服务可访问时，攻击者知道或猜到账户名 system，即可登录获取管理员 JWT。',
    impact: '管理员接口、模型接入、用户管理、扩展 reload/rebuild、所有管理员可读项目与 Session。',
    fix: '生产强制 ENABLE_PASSWORD_LOGIN=true；禁止 system 走普通登录；强制管理员强密码、限速、失败锁定、审计；移除固定 JWT fallback。',
  },
  {
    level: '高',
    title: 'bindPathManual 可绑定任意系统路径',
    evidence: 'projects.js:208-216,1417-1419；modals.tsx:176,302；workspace.js:45-117；code-server-pool.js:301-309',
    attack: '已登录用户创建项目时传 bindPathManual=true 和任意绝对路径，再用项目文件页、code-server 或 Session 智能体访问该目录。',
    impact: '突破用户工作目录边界，读取/修改服务进程可访问目录，或让智能体在敏感路径执行命令。',
    fix: '普通用户禁用手动绑定；管理员 allowlist 审批；后端 realpath 校验必须位于授权根；code-server 和 agent 再做二次校验。',
  },
  {
    level: '高',
    title: 'Research Blackboard 未鉴权写入可向智能体注入内容',
    evidence: 'researches.js:319-336；research-blackboard.js:162-184,253-275',
    attack: '无需登录向已存在 Research 写入伪造内容，扫描器会把内容拼入提醒 prompt 并投递给活跃 Research Session。',
    impact: '研究数据污染、提示注入、任务结论污染，严重时可能间接诱导智能体执行危险操作。',
    fix: 'GET/POST 加 auth 与 canReadResearch/canManageResearch；写入者使用 req.user.id；外部内容加不可执行边界、限速和审计。',
  },
  {
    level: '中',
    title: 'Research Graph 未鉴权读取可能泄露研究结构和路径',
    evidence: 'researches.js:340-349；research-graph.js:98-125',
    attack: '知道 research id 后无需登录读取图谱节点、边、责任人、附件和内部文件路径。',
    impact: '研究计划、任务结构、文件路径泄露。',
    fix: '与 Research 详情接口一致，加 auth 与 canReadResearch；返回内容去除内部绝对路径。',
  },
  {
    level: '中',
    title: '公开扩展前端 GET 可触发构建/拷贝',
    evidence: 'ext.js:416,435-440；extension-build-pipeline.js:90-147',
    attack: '未登录访问未构建扩展，触发 copy、npm install 或 npm run build，占用 CPU、网络和磁盘。',
    impact: '资源消耗、构建日志暴露、供应链安装风险。',
    fix: '构建触发改为管理员鉴权；公开入口只服务已构建 dist；部署时预构建；失败冷却和全局队列限速。',
  },
  {
    level: '中',
    title: 'JWT 放入 URL query 存在泄露风险',
    evidence: 'auth.js:30-55；sessions.js:515；code-server-proxy.js:138-144；project-files.tsx:95；jsonl-view.tsx:1279',
    attack: 'token 或 _jwt 可能进入代理日志、浏览器历史、Referer、错误日志或截图。',
    impact: '泄露后可冒用对应用户访问项目、Session、文件下载或 code-server。',
    fix: '改用 HttpOnly Secure SameSite cookie；SSE 和下载使用短期一次性 ticket；过滤日志中的 token 参数。',
  },
  {
    level: '中',
    title: '扩展后端执行缺少强制文件/网络沙箱',
    evidence: 'extension-invoker.js:12-13；extension-invoker-worker.js:32；ext.js:242；config.js:121-124',
    attack: '若某扩展 handler 存在业务漏洞，平台层不会强制阻断越界 fs、网络或 child_process 行为。',
    impact: '扩展数据越界、服务端文件读取、内部网络访问、外部 API 配额消耗。',
    fix: '在 worker 层限制 fs/net/child_process 或改用进程/容器沙箱；扩展级权限、配额和审计。',
  },
  {
    level: '低',
    title: '未鉴权健康/版本/DB 计数接口泄露环境信息',
    evidence: 'server.js:135-177；health.js:9,63,152',
    attack: '收集版本、commit、启动时间、env、端口、表规模、内存磁盘情况，用于指纹识别。',
    impact: '信息泄露，不直接导致控制权。',
    fix: '公网只保留最小 healthz；详细健康与 DB 计数改为管理员接口。',
  },
  {
    level: '低',
    title: '默认 CORS 过宽',
    evidence: 'server.js:46',
    attack: '任意 Origin 可读取 API 响应；与免密码登录或 token 泄露叠加时扩大攻击面。',
    impact: '扩大已有认证问题影响范围。',
    fix: '生产配置 Origin 白名单；敏感接口收紧 CORS。',
  },
];

const pending = [
  '未对线上或本机运行服务发起任何 HTTP 探测，网络可达性需要人工确认。',
  '未扫描防火墙、反向代理、域名、TLS、Nginx/PM2 实际暴露面。',
  '未执行 /api/auth/login，免密码登录为代码、配置、本地 DB 证据确认。',
  '未触发 /extension/:name/，扩展构建风险为静态确认。',
  '未逐个审计所有扩展 handler 的业务参数校验。',
  '未读取或展示任何密码哈希、令牌、密钥明文值。',
  '本地 DB 当前只有 system 用户、10 个扩展项目、0 个 Issue/Research/Session；生产库是否不同未验证。',
];

function levelClass(level) {
  if (level === '高') return 'high';
  if (level === '中') return 'medium';
  return 'low';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderExposures() {
  const tbody = document.getElementById('exposureRows');
  tbody.innerHTML = exposures.map((row) => `
    <tr>
      <td>${escapeHtml(row[0])}</td>
      <td>${escapeHtml(row[1])}</td>
      <td class="code">${escapeHtml(row[2])}</td>
      <td>${escapeHtml(row[3])}</td>
      <td>${escapeHtml(row[4])}</td>
    </tr>
  `).join('');
}

function renderRisks() {
  const list = document.getElementById('riskList');
  list.innerHTML = risks.map((risk, index) => `
    <details class="risk-card" data-level="${risk.level}" open>
      <summary>
        <span class="badge ${levelClass(risk.level)}">${escapeHtml(risk.level)}危</span>
        <span class="risk-title">${index + 1}. ${escapeHtml(risk.title)}</span>
        <span class="chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="risk-body">
        <section>
          <h3>证据位置</h3>
          <p class="code">${escapeHtml(risk.evidence)}</p>
        </section>
        <section>
          <h3>攻击者可利用的方式</h3>
          <p>${escapeHtml(risk.attack)}</p>
        </section>
        <section>
          <h3>影响范围</h3>
          <p>${escapeHtml(risk.impact)}</p>
        </section>
        <section>
          <h3>修复建议</h3>
          <p>${escapeHtml(risk.fix)}</p>
        </section>
      </div>
    </details>
  `).join('');
}

function renderPending() {
  const list = document.getElementById('pendingList');
  list.innerHTML = pending.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function bindFilters() {
  const buttons = [...document.querySelectorAll('.filter')];
  const cards = [...document.querySelectorAll('.risk-card')];
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.filter;
      buttons.forEach((item) => item.classList.toggle('is-active', item === button));
      buttons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      cards.forEach((card) => {
        card.hidden = value !== 'all' && card.dataset.level !== value;
      });
    });
  });
  buttons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.classList.contains('is-active')));
  });
}

function initHeroCanvas() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const lines = Array.from({ length: 24 }, (_, index) => ({
    phase: index * 0.37,
    speed: 0.22 + (index % 5) * 0.035,
    lift: 0.18 + (index % 6) * 0.08,
    alpha: 0.16 + (index % 4) * 0.035,
  }));
  const nodes = Array.from({ length: 70 }, (_, index) => ({
    x: (index * 37 % 100) / 100,
    y: (index * 61 % 100) / 100,
    phase: index * 0.71,
    radius: 0.8 + (index % 4) * 0.42,
  }));

  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let running = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawMesh(time) {
    const t = time * 0.001;
    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, 'rgba(100, 210, 255, 0.18)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.06)');
    gradient.addColorStop(1, 'rgba(48, 209, 88, 0.13)');
    ctx.strokeStyle = gradient;

    lines.forEach((line, index) => {
      const yBase = height * (0.18 + (index / lines.length) * 0.58);
      const amplitude = height * (0.035 + line.lift * 0.08);
      ctx.beginPath();
      for (let step = 0; step <= 150; step += 1) {
        const x = (step / 150) * width;
        const wave = Math.sin(step * 0.045 + t * line.speed + line.phase);
        const drift = Math.cos(step * 0.018 - t * 0.17 + line.phase) * height * 0.025;
        const y = yBase + wave * amplitude + drift;
        if (step === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = line.alpha;
      ctx.lineWidth = index % 7 === 0 ? 1.2 : 0.65;
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    nodes.forEach((node, index) => {
      const driftX = Math.sin(t * 0.16 + node.phase) * width * 0.018;
      const driftY = Math.cos(t * 0.13 + node.phase) * height * 0.018;
      const x = node.x * width + driftX;
      const y = node.y * height + driftY;
      const pulse = 0.45 + 0.55 * Math.sin(t * 1.4 + node.phase);
      ctx.beginPath();
      ctx.fillStyle = index % 5 === 0
        ? `rgba(48, 209, 88, ${0.24 + pulse * 0.22})`
        : `rgba(100, 210, 255, ${0.18 + pulse * 0.2})`;
      ctx.arc(x, y, node.radius + pulse * 0.7, 0, Math.PI * 2);
      ctx.fill();
    });

    const sweep = (Math.sin(t * 0.35) * 0.5 + 0.5) * width;
    const sweepGradient = ctx.createLinearGradient(sweep - width * 0.22, 0, sweep + width * 0.22, 0);
    sweepGradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    sweepGradient.addColorStop(0.48, 'rgba(255, 255, 255, 0.12)');
    sweepGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sweepGradient;
    ctx.fillRect(0, 0, width, height);

    if (running) raf = window.requestAnimationFrame(drawMesh);
  }

  function start() {
    if (running) return;
    running = true;
    raf = window.requestAnimationFrame(drawMesh);
  }

  function stop() {
    running = false;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
  }

  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  const observer = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (visible) start();
    else stop();
  }, { threshold: 0.05 });
  observer.observe(canvas);
}

renderExposures();
renderRisks();
renderPending();
bindFilters();
initHeroCanvas();
