// 十字路口交通信号灯 · S7-200 SMART 梯形图仿真
// 在浏览器里以 100ms 时基复刻 PLC 行为：
//   * I0.0 启动, I0.1 停止 (NC), I0.2 急停 (NC)
//   * T50 主计时器 (PV=1300 = 130s), 自循环
//   * 12 段时间区间, 决定 M0.1..M1.4 阶段标志
//   * M 标志 → Q0.0..Q0.7 / Q1.0..Q1.1 灯组
//   * 急停时所有绿/黄熄灭, 仅保留两个方向的红灯

// ----------- 阶段定义 (与梯形图 Network 6-17 一一对应) -----------
// 时间单位 100ms. 例如 P1 起点 0 终点 250 = 25.0s
const PHASES = [
  { id: 'P1',  m: 'M0.1', label: '东西左转 · 绿',  start: 0,    end: 250,  type: 'green',  q: { Q00:1, Q10:1, Q11:1 } },
  { id: 'P1Y', m: 'M0.2', label: '东西左转 · 黄',  start: 250,  end: 280,  type: 'yellow', q: { Q01:1, Q10:1, Q11:1 } },
  { id: 'P1R', m: 'M0.3', label: '全红清空 1',     start: 280,  end: 300,  type: 'red',    q: { Q10:1, Q11:1 } },
  { id: 'P2',  m: 'M0.4', label: '东西直行 · 绿',  start: 300,  end: 600,  type: 'green',  q: { Q02:1, Q10:1, Q11:1 } },
  { id: 'P2Y', m: 'M0.5', label: '东西直行 · 黄',  start: 600,  end: 630,  type: 'yellow', q: { Q03:1, Q10:1, Q11:1 } },
  { id: 'P2R', m: 'M0.6', label: '全红清空 2',     start: 630,  end: 650,  type: 'red',    q: { Q10:1, Q11:1 } },
  { id: 'P3',  m: 'M0.7', label: '南北左转 · 绿',  start: 650,  end: 900,  type: 'green',  q: { Q04:1, Q10:1, Q11:1 } },
  { id: 'P3Y', m: 'M1.0', label: '南北左转 · 黄',  start: 900,  end: 930,  type: 'yellow', q: { Q05:1, Q10:1, Q11:1 } },
  { id: 'P3R', m: 'M1.1', label: '全红清空 3',     start: 930,  end: 950,  type: 'red',    q: { Q10:1, Q11:1 } },
  { id: 'P4',  m: 'M1.2', label: '南北直行 · 绿',  start: 950,  end: 1250, type: 'green',  q: { Q06:1, Q10:1, Q11:1 } },
  { id: 'P4Y', m: 'M1.3', label: '南北直行 · 黄',  start: 1250, end: 1280, type: 'yellow', q: { Q07:1, Q10:1, Q11:1 } },
  { id: 'P4R', m: 'M1.4', label: '全红清空 4',     start: 1280, end: 1300, type: 'red',    q: { Q10:1, Q11:1 } },
];
const CYCLE_TICKS = 1300; // 1300 × 100ms = 130s

// 8 个 Q 输出对应的视觉信号 (按 HTML 中的 [data-arm][data-dir] 索引)
const Q_TO_SIGNAL = {
  Q00: ['east-left',  'west-left'],     // 东西左转 绿
  Q01: ['east-left',  'west-left'],     // 东西左转 黄
  Q02: ['east-straight','west-straight'],// 东西直行 绿
  Q03: ['east-straight','west-straight'],// 东西直行 黄
  Q04: ['north-left', 'south-left'],    // 南北左转 绿
  Q05: ['north-left', 'south-left'],    // 南北左转 黄
  Q06: ['north-straight','south-straight'],// 南北直行 绿
  Q07: ['north-straight','south-straight'],// 南北直行 黄
};

// ----------- 状态 -----------
const state = {
  // I 区 (输入): true = 触点吸合
  i00: false, // 启动 SB1 (NO)
  i01: true,  // 停止 SB2 (NC, 未按时吸合)
  i02: true,  // 急停 SB3 (NC, 未按时吸合)
  // M 区 (内部标志)
  m00: false, // RUN
  m15: false, // EMG 急停
  // T50 当前值 (ticks)
  t50: 0,
  // Q 区 (输出): 0=灭, 1=红, 2=黄, 3=绿
  q: { Q00:0, Q01:0, Q02:0, Q03:0, Q04:0, Q05:0, Q06:0, Q07:0, Q10:0, Q11:0 },
  // 当前阶段 id
  phaseId: null,
  // 仿真速度
  speed: 1,
};

// ----------- DOM 引用 -----------
const $ = (id) => document.getElementById(id);
const runPill = $('runPill');
const phasePill = $('phasePill');
const timePill = $('timePill');
const phaseTableEl = $('phaseTable');
const timelineEl = $('timeline');
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const btnEmg = $('btnEmg');
const speedSel = $('speedSel');

// 阶段表 (静态构建一次)
function buildPhaseTable() {
  const html = ['<div class="h">M 标志</div><div class="h">阶段描述</div><div class="h">时长</div>'];
  for (const p of PHASES) {
    const dur = ((p.end - p.start) / 10).toFixed(1) + 's';
    html.push(`<div class="row" data-pid="${p.id}"><div class="cell lbl">${p.m}</div><div class="cell desc">${p.label}</div><div class="cell dur">${dur}</div></div>`);
  }
  phaseTableEl.innerHTML = html.join('');
}
buildPhaseTable();

// 时序图 (按比例画 12 段)
function buildTimeline() {
  const html = [];
  for (const p of PHASES) {
    const left = (p.start / CYCLE_TICKS) * 100;
    const width = ((p.end - p.start) / CYCLE_TICKS) * 100;
    const cls = p.type === 'green' ? 'green' : p.type === 'yellow' ? 'yellow' : 'red';
    html.push(`<div class="seg ${cls}" data-pid="${p.id}" style="left:${left}%;width:${width}%">${p.id}</div>`);
  }
  html.push('<div class="cursor" id="cursor"></div>');
  timelineEl.innerHTML = html.join('');
}
buildTimeline();
const cursorEl = $('cursor');

// 工具: 把单个灯的状态翻译成 on-red / on-yellow / on-green class
function colorClass(c) { return c === 1 ? 'on-red' : c === 2 ? 'on-yellow' : c === 3 ? 'on-green' : ''; }

// 更新路口灯色
function renderLights() {
  const arms = document.querySelectorAll('.intersection .arm .signal');
  // 复位全部 class
  for (const el of arms) {
    el.classList.remove('on-red', 'on-yellow', 'on-green');
    el.dataset.color = 'off';
  }
  // 遍历 Q 输出, 标记受控信号
  const colorMap = {}; // signal key -> 颜色
  function setColor(key, c) {
    if (c === 3) colorMap[key] = 3; // 绿优先
    else if (c === 2 && colorMap[key] !== 3) colorMap[key] = 2;
    else if (c === 1 && !colorMap[key]) colorMap[key] = 1;
  }
  if (state.q.Q10) { setColor('east-left', 1); setColor('east-straight', 1); setColor('west-left', 1); setColor('west-straight', 1); }
  if (state.q.Q11) { setColor('north-left', 1); setColor('north-straight', 1); setColor('south-left', 1); setColor('south-straight', 1); }
  for (const [k, v] of Object.entries(state.q)) {
    if (!v || !Q_TO_SIGNAL[k]) continue;
    // 颜色: 1=红, 2=黄, 3=绿
    for (const sig of Q_TO_SIGNAL[k]) {
      const c = v; // 1/2/3
      if (c === 3) colorMap[sig] = 3;
      else if (c === 2 && colorMap[sig] !== 3) colorMap[sig] = 2;
      else if (c === 1 && !colorMap[sig]) colorMap[sig] = 1;
    }
  }
  // 写入 DOM
  for (const el of arms) {
    const arm = el.parentElement.dataset.arm;
    const dir = el.dataset.dir;
    const key = `${arm}-${dir}`;
    const c = colorMap[key] || 0;
    const cls = colorClass(c);
    if (cls) el.classList.add(cls);
    el.dataset.color = c === 1 ? 'red' : c === 2 ? 'yellow' : c === 3 ? 'green' : 'off';
  }
}

function renderStatus() {
  if (!state.m00 && !state.m15) {
    runPill.textContent = '未启动';
    runPill.className = 'pill stop';
  } else if (state.m15) {
    runPill.textContent = '急停中';
    runPill.className = 'pill stop';
  } else {
    runPill.textContent = '运行中';
    runPill.className = 'pill run';
  }
  const cur = PHASES.find(p => p.id === state.phaseId);
  phasePill.textContent = cur ? `${cur.m}  ${cur.label}` : (state.m15 ? 'EMG 紧急全红' : '—');
  // 当前 T50 时间 (秒, 0.1 精度)
  timePill.textContent = (state.t50 / 10).toFixed(1) + ' s';
  // 阶段表高亮
  for (const r of phaseTableEl.querySelectorAll('.row')) {
    r.classList.toggle('active', r.dataset.pid === state.phaseId);
  }
  // 时序图游标
  const left = (state.t50 / CYCLE_TICKS) * 100;
  cursorEl.style.left = left + '%';
}

// ----------- 模拟 PLC 扫描周期 -----------
// 1. 读输入 (state.i0x)
// 2. 执行逻辑 (Network 1..28)
// 3. 写输出 / 更新 DOM
function plcScan() {
  // Net 1: 启停自锁  I0.0 & !I0.1 -> (M0.0); M0.0 & !I0.1 自锁
  if (state.m00) {
    // 自锁中, 由 I0.1 (NC, 默认吸合) 决定断电
    if (!state.i01) state.m00 = false; // 停止按钮按下
  } else {
    if (state.i00 && state.i01) state.m00 = true; // 启动
  }
  // 急停时强制 M_RUN = false (并锁)
  if (!state.i02) { state.m00 = false; state.m15 = true; }
  else { state.m15 = false; }

  // Net 3: 停止时复位 (M_RUN = false 时清空 M/Q/T)
  if (!state.m00) {
    state.t50 = 0;
    for (const k of Object.keys(state.q)) state.q[k] = 0;
  }

  // Net 4/5: 主计时器 T50 (100ms 时基)
  if (state.m00) {
    state.t50 += 1; // 100ms
    if (state.t50 >= CYCLE_TICKS) state.t50 = 0; // 周期完成 -> 自复位
  }

  // Net 6-17: 阶段判定 -> 同时只设一个
  let activePhase = null;
  if (state.m00) {
    for (const p of PHASES) {
      if (state.t50 >= p.start && state.t50 < p.end) { activePhase = p; break; }
    }
  }
  state.phaseId = activePhase ? activePhase.id : null;

  // Net 18-27: 输出赋值
  // 先清空 Q00-Q07 / Q10-Q11, 然后按阶段 + M_RUN 写入
  for (const k of Object.keys(state.q)) state.q[k] = 0;
  if (state.m00) {
    if (activePhase) {
      // 把 q 对象的键名 Q00/Q01/... 映射到 Q0.0/Q0.1/...
      for (const [k, v] of Object.entries(activePhase.q)) {
        state.q[k] = v === 1 ? 1 : 0;
      }
    }
    // Q1.0 / Q1.1 红灯在 M_RUN 期间常亮 (Network 18-19)
    state.q.Q10 = 1;
    state.q.Q11 = 1;
  }

  // Net 28: 急停覆盖 -> 绿/黄熄灭, 红灯亮
  if (state.m15) {
    for (const k of Object.keys(state.q)) {
      if (k === 'Q10' || k === 'Q11') state.q[k] = 1;
      else state.q[k] = 0;
    }
  }
}

// ----------- 仿真主循环 -----------
let lastTs = 0;
let acc = 0;
const TICK_MS = 100; // 一个 PLC 扫描 = 100ms
function tick(ts) {
  if (!lastTs) lastTs = ts;
  const dt = ts - lastTs;
  lastTs = ts;
  acc += dt * state.speed;
  while (acc >= TICK_MS) {
    plcScan();
    acc -= TICK_MS;
  }
  renderLights();
  renderStatus();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ----------- 输入按钮 -----------
function flash(btn) {
  btn.classList.remove('pressed');
  // 重置 animation
  void btn.offsetWidth;
  btn.classList.add('pressed');
}

btnStart.addEventListener('click', () => {
  flash(btnStart);
  state.i00 = true;
  // 人机输入立即触发一次 PLC 扫描，避免短脉冲落在两个动画扫描周期之间。
  plcScan();
  // 模拟真实按钮的弹起: 50ms 后释放
  setTimeout(() => { state.i00 = false; }, 80);
});
btnStop.addEventListener('click', () => {
  flash(btnStop);
  state.i01 = false; // NC, 按下 = 断开
  setTimeout(() => { state.i01 = true; }, 80);
});
btnEmg.addEventListener('click', () => {
  flash(btnEmg);
  // 急停 = 长按 NC 触点断开 (长闭)
  state.i02 = false;
});
// 鼠标松开恢复急停 (模拟 NC 按钮回弹)
btnEmg.addEventListener('mouseup', () => { state.i02 = true; });
btnEmg.addEventListener('mouseleave', () => { state.i02 = true; });

// 键盘
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (e.code === 'Space') { e.preventDefault(); btnStart.click(); }
  else if (e.key === 's' || e.key === 'S') { btnStop.click(); }
  else if (e.key === 'e' || e.key === 'E') {
    state.i02 = false;
    btnEmg.classList.add('pressed');
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'e' || e.key === 'E') { state.i02 = true; btnEmg.classList.remove('pressed'); }
});

// 速度
speedSel.addEventListener('change', () => {
  state.speed = parseFloat(speedSel.value) || 1;
});
