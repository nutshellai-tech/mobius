// 2026 世界杯内容聚合站
// 职责：滚动揭示 / 顶部导航明暗 / 倒计时 / 赛程 tab / 积分榜 12 组 tab /
//       射手榜渲染 / 新闻主区（左大卡 + 右列表）/ 球员 / 球场
//       调用后端 read 拉取真实 RSS 新闻与同步状态
//       所有外部文本一律 escapeHtml，URL 经 safeUrl 白名单，杜绝 XSS

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}
function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function timeAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- 1. 滚动揭示 ---------- */
const reveals = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('is-visible');
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -80px 0px' });
reveals.forEach((el) => io.observe(el));

/* ---------- 2. 顶部导航明暗 ---------- */
const topnav = document.getElementById('topnav');
const lightSections = document.querySelectorAll('.section-light, .hero');
const navObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0.4) {
      const isHero = e.target.classList.contains('hero');
      topnav.classList.toggle('on-light', !isHero && e.target.classList.contains('section-light'));
    }
  }
}, { threshold: [0.4, 0.6] });
lightSections.forEach((s) => navObserver.observe(s));

/* ---------- 3. 倒计时 / 赛事阶段 ---------- */
const KICKOFF_ISO = '2026-06-11T20:00:00-06:00'; // 墨西哥城揭幕战
const FINAL_ISO = '2026-07-19T15:00:00-04:00';   // 纽约大都会决赛
function updateCountdown() {
  const el = document.getElementById('hero-countdown');
  const prefixEl = document.getElementById('hero-title-prefix');
  if (!el) return;
  const now = Date.now();
  const kickoff = Date.parse(KICKOFF_ISO);
  const final = Date.parse(FINAL_ISO);
  if (now < kickoff) {
    const ms = kickoff - now;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    el.textContent = `${d} 天 ${h} 时 ${m} 分`;
    if (prefixEl) prefixEl.textContent = '距离揭幕';
  } else if (now < final) {
    const ms = final - now;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    el.textContent = `${d} 天 ${h} 时`;
    if (prefixEl) prefixEl.textContent = '距离决赛';
  } else {
    el.textContent = '已落幕';
    if (prefixEl) prefixEl.textContent = '本届世界杯';
  }
}
updateCountdown();
setInterval(updateCountdown, 60000);

/* ---------- 4. 静态数据（示意，待真实数据接入） ---------- */
const FIXTURES = {
  today: [
    { stage: 'A 组 · 第 1 轮', home: 'MEX', homeName: '墨西哥', away: 'CAN', awayName: '加拿大', score: '— : —', status: '20:00', kind: 'upcoming' },
    { stage: 'B 组 · 第 1 轮', home: 'FRA', homeName: '法国',   away: 'MAR', awayName: '摩洛哥', score: '1 : 0', status: "67'", kind: 'live' },
    { stage: 'A 组 · 第 1 轮', home: 'USA', homeName: '美国',   away: 'PAN', awayName: '巴拿马', score: '2 : 1', status: 'FT', kind: 'done' },
  ],
  tomorrow: [
    { stage: 'C 组 · 第 1 轮', home: 'ARG', homeName: '阿根廷', away: 'POR', awayName: '葡萄牙', score: '— : —', status: '03:00', kind: 'upcoming' },
    { stage: 'D 组 · 第 1 轮', home: 'ENG', homeName: '英格兰', away: 'NED', awayName: '荷兰',   score: '— : —', status: '06:00', kind: 'upcoming' },
    { stage: 'F 组 · 第 1 轮', home: 'BRA', homeName: '巴西',   away: 'KOR', awayName: '韩国',   score: '— : —', status: '23:00', kind: 'upcoming' },
  ],
  week: [
    { stage: 'A 组 · 第 1 轮', home: 'MEX', homeName: '墨西哥', away: 'CAN', awayName: '加拿大', score: '— : —', status: '周四 20:00', kind: 'upcoming' },
    { stage: 'B 组 · 第 1 轮', home: 'FRA', homeName: '法国',   away: 'MAR', awayName: '摩洛哥', score: '— : —', status: '周五 03:00', kind: 'upcoming' },
    { stage: 'C 组 · 第 1 轮', home: 'ARG', homeName: '阿根廷', away: 'POR', awayName: '葡萄牙', score: '— : —', status: '周六 03:00', kind: 'upcoming' },
    { stage: 'D 组 · 第 1 轮', home: 'ENG', homeName: '英格兰', away: 'NED', awayName: '荷兰',   score: '— : —', status: '周六 06:00', kind: 'upcoming' },
    { stage: 'E 组 · 第 1 轮', home: 'ESP', homeName: '西班牙', away: 'GER', awayName: '德国',   score: '— : —', status: '周日 03:00', kind: 'upcoming' },
    { stage: 'F 组 · 第 1 轮', home: 'BRA', homeName: '巴西',   away: 'KOR', awayName: '韩国',   score: '— : —', status: '周日 23:00', kind: 'upcoming' },
  ],
};

// 12 组 mock 数据（每组 4 队，前 2 出线）
const STANDINGS = {
  A: [
    { team: '墨西哥', code: 'MEX', p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, pts: 3, qualified: true },
    { team: '美国',   code: 'USA', p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, pts: 3, qualified: true },
    { team: '加拿大', code: 'CAN', p: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, pts: 0 },
    { team: '巴拿马', code: 'PAN', p: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, pts: 0 },
  ],
  B: [
    { team: '法国',   code: 'FRA', p: 1, w: 1, d: 0, l: 0, gf: 1, ga: 0, pts: 3, qualified: true },
    { team: '摩洛哥', code: 'MAR', p: 1, w: 1, d: 0, l: 0, gf: 1, ga: 0, pts: 3, qualified: true },
    { team: '塞内加尔', code: 'SEN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '突尼斯', code: 'TUN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  C: [
    { team: '阿根廷', code: 'ARG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '葡萄牙', code: 'POR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '乌拉圭', code: 'URU', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '厄瓜多尔', code: 'ECU', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  D: [
    { team: '英格兰', code: 'ENG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '荷兰',   code: 'NED', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '丹麦',   code: 'DEN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '日本',   code: 'JPN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  E: [
    { team: '西班牙', code: 'ESP', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '德国',   code: 'GER', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '瑞士',   code: 'SUI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '喀麦隆', code: 'CMR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  F: [
    { team: '巴西',   code: 'BRA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '韩国',   code: 'KOR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '澳大利亚', code: 'AUS', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '塞尔维亚', code: 'SRB', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  G: [
    { team: '意大利', code: 'ITA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '比利时', code: 'BEL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '奥地利', code: 'AUT', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '加纳',   code: 'GHA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  H: [
    { team: '克罗地亚', code: 'CRO', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '波兰',     code: 'POL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '威尔士',   code: 'WAL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '沙特',     code: 'KSA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  I: [
    { team: '哥伦比亚', code: 'COL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '智利',     code: 'CHI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '巴拉圭',   code: 'PAR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '秘鲁',     code: 'PER', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  J: [
    { team: '挪威',   code: 'NOR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '瑞典',   code: 'SWE', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '爱尔兰', code: 'IRL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '冰岛',   code: 'ISL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  K: [
    { team: '埃及',     code: 'EGY', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '尼日利亚', code: 'NGA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '南非',     code: 'RSA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '阿尔及利亚', code: 'ALG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  L: [
    { team: '哥斯达黎加', code: 'CRC', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '洪都拉斯',   code: 'HON', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '萨尔瓦多',   code: 'SLV', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '海地',       code: 'HAI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
};

const SCORERS = [
  { rank: 1, name: 'Kylian Mbappé',  country: '法国 · FRA',     goals: 8, assists: 2, img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Kylian_Mbapp%C3%A9_2022.jpg/320px-Kylian_Mbapp%C3%A9_2022.jpg', license: '© Wikimedia / CC-BY' },
  { rank: 2, name: 'Lionel Messi',   country: '阿根廷 · ARG',   goals: 7, assists: 5, img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/Lionel-Messi-Argentina-2022-FIFA-World-Cup_%28cropped%29.jpg/320px-Lionel-Messi-Argentina-2022-FIFA-World-Cup_%28cropped%29.jpg', license: '© Wikimedia / CC-BY-SA' },
  { rank: 3, name: 'Julián Álvarez', country: '阿根廷 · ARG',   goals: 5, assists: 1, img: '', license: '示意 · 待接入' },
  { rank: 4, name: 'Jude Bellingham', country: '英格兰 · ENG',  goals: 4, assists: 3, img: '', license: '示意 · 待接入' },
  { rank: 5, name: 'Vinícius Jr.',   country: '巴西 · BRA',     goals: 4, assists: 2, img: '', license: '示意 · 待接入' },
  { rank: 6, name: 'Bukayo Saka',    country: '英格兰 · ENG',   goals: 3, assists: 2, img: '', license: '示意 · 待接入' },
  { rank: 7, name: 'Lautaro Martínez', country: '阿根廷 · ARG', goals: 3, assists: 1, img: '', license: '示意 · 待接入' },
  { rank: 8, name: 'Bruno Fernandes', country: '葡萄牙 · POR',  goals: 3, assists: 2, img: '', license: '示意 · 待接入' },
];

const PLAYERS = [
  { name: 'Lionel Messi',   country: '阿根廷 · ARG',  goals: 13, assists: 8, wcapps: 26, img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/Lionel-Messi-Argentina-2022-FIFA-World-Cup_%28cropped%29.jpg/640px-Lionel-Messi-Argentina-2022-FIFA-World-Cup_%28cropped%29.jpg', license: '© Wikimedia / CC-BY-SA' },
  { name: 'Kylian Mbappé',  country: '法国 · FRA',    goals: 12, assists: 4, wcapps: 14, img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Kylian_Mbapp%C3%A9_2022.jpg/640px-Kylian_Mbapp%C3%A9_2022.jpg', license: '© Wikimedia / CC-BY' },
  { name: 'Jude Bellingham', country: '英格兰 · ENG', goals: 1, assists: 2, wcapps: 5,  img: '', license: '示意 · 待接入' },
  { name: 'Vinícius Jr.',    country: '巴西 · BRA',   goals: 1, assists: 2, wcapps: 5,  img: '', license: '示意 · 待接入' },
  { name: 'Erling Haaland',  country: '挪威 · NOR',   goals: 0, assists: 0, wcapps: 0,  img: '', license: '示意 · 待接入' },
  { name: 'Lamine Yamal',    country: '西班牙 · ESP', goals: 0, assists: 0, wcapps: 0,  img: '', license: '示意 · 待接入' },
  { name: 'Julián Álvarez',  country: '阿根廷 · ARG', goals: 4, assists: 1, wcapps: 11, img: '', license: '示意 · 待接入' },
  { name: 'Bukayo Saka',     country: '英格兰 · ENG', goals: 3, assists: 2, wcapps: 8,  img: '', license: '示意 · 待接入' },
];

const STADIUMS = [
  { country: '美国 · USA',   stadium: 'MetLife Stadium',  city: '纽约/新泽西', capacity: '82,500', note: '2026 决赛场地。曾举办 2024 决赛、超级碗，是北美最重量级球场之一。', img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/MetLife_Stadium_%28cropped%29.jpg/1024px-MetLife_Stadium_%28cropped%29.jpg', license: '© Wikimedia / CC-BY-SA' },
  { country: '墨西哥 · MEX', stadium: 'Estadio Azteca',   city: '墨西哥城',   capacity: '87,000', note: '1970 与 1986 两届世界杯决赛场地，2026 将第三次承办揭幕战。',           img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Estadio_Azteca_from_the_air.jpg/1024px-Estadio_Azteca_from_the_air.jpg', license: '© Wikimedia / CC-BY' },
  { country: '加拿大 · CAN', stadium: 'BMO Field',        city: '多伦多',     capacity: '45,000', note: '加拿大首次承办男足世界杯的主场地之一，扩容后达到 4.5 万座。',         img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/BMO_Field_2016.jpg/1024px-BMO_Field_2016.jpg', license: '© Wikimedia / CC-BY-SA' },
  { country: '美国 · USA',   stadium: 'SoFi Stadium',     city: '洛杉矶',     capacity: '70,000', note: '2022 启用，封闭式球场，将承办小组赛与淘汰赛多场焦点战。',             img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/SoFi_2022_%28cropped%29.jpg/1024px-SoFi_2022_%28cropped%29.jpg', license: '© Wikimedia / CC-BY-SA' },
];

/* ---------- 5. 渲染：赛程 ---------- */
function renderFixtures(key) {
  const grid = document.getElementById('fixtures-grid');
  if (!grid) return;
  const list = FIXTURES[key] || [];
  if (list.length === 0) {
    grid.innerHTML = `<p class="empty">暂无该时段的赛程</p>`;
    return;
  }
  grid.innerHTML = list.map((f) => {
    const kindClass = f.kind === 'live' ? 'live' : (f.kind === 'done' ? 'done' : 'upcoming');
    const statusClass = f.kind === 'live' ? 'live' : (f.kind === 'done' ? 'done' : '');
    return `<article class="fixture-card ${kindClass}">
      <div class="fixture-stage">${escapeHtml(f.stage)}</div>
      <div class="fixture-match">
        <div class="fixture-team">
          <span class="fc-code">${escapeHtml(f.home)}</span>
          <span class="fc-name">${escapeHtml(f.homeName)}</span>
        </div>
        <div class="fixture-center">
          <span class="fc-score">${escapeHtml(f.score)}</span>
          <span class="fc-status ${statusClass}">${escapeHtml(f.status)}</span>
        </div>
        <div class="fixture-team">
          <span class="fc-code">${escapeHtml(f.away)}</span>
          <span class="fc-name">${escapeHtml(f.awayName)}</span>
        </div>
      </div>
    </article>`;
  }).join('');
}
// 绑定 tab
document.querySelectorAll('[data-fixture-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-fixture-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderFixtures(btn.dataset.fixtureTab);
  });
});
renderFixtures('today');

/* ---------- 6. 渲染：积分榜 ---------- */
function renderStandingsTabs() {
  const wrap = document.getElementById('standings-tabs');
  if (!wrap) return;
  const groups = Object.keys(STANDINGS);
  wrap.innerHTML = groups.map((g, i) =>
    `<button class="group-tab ${i === 0 ? 'active' : ''}" data-group="${g}" role="tab">${g}</button>`
  ).join('');
  wrap.querySelectorAll('[data-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('[data-group]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderStandings(btn.dataset.group);
    });
  });
}
function renderStandings(group) {
  const tbody = document.getElementById('standings-body');
  if (!tbody) return;
  const rows = STANDINGS[group] || [];
  tbody.innerHTML = rows.map((r, i) => `
    <tr class="${r.qualified ? 'qualified' : ''}">
      <td>${i + 1}</td>
      <td class="team-cell">${escapeHtml(r.team)} <span class="team-code-inline">${escapeHtml(r.code)}</span></td>
      <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
      <td>${r.gf}</td><td>${r.ga}</td>
      <td class="pts">${r.pts}</td>
    </tr>
  `).join('');
}
renderStandingsTabs();
renderStandings('A');

/* ---------- 7. 渲染：射手榜 ---------- */
function renderScorers(list) {
  const wrap = document.getElementById('scorers-list');
  if (!wrap) return;
  const max = Math.max(1, ...list.map((s) => s.goals));
  wrap.innerHTML = list.map((s) => {
    const bg = safeUrl(s.img);
    const photoStyle = bg ? `style="background-image:url('${bg}')"` : '';
    const barPct = Math.round((s.goals / max) * 100);
    return `<article class="scorer-row">
      <div class="scorer-rank">${escapeHtml(String(s.rank))}</div>
      <div class="scorer-photo" ${photoStyle}>${bg ? '' : '<span class="scorer-photo-empty">' + escapeHtml(s.name.slice(0, 1)) + '</span>'}</div>
      <div class="scorer-main">
        <div class="scorer-name">${escapeHtml(s.name)}</div>
        <div class="scorer-country">${escapeHtml(s.country)}</div>
        <div class="scorer-bar"><div class="scorer-bar-fill" style="width:${barPct}%"></div></div>
      </div>
      <div class="scorer-stats">
        <div><span class="big">${escapeHtml(String(s.goals))}</span><span class="label">进球</span></div>
        <div><span class="small">${escapeHtml(String(s.assists))}</span><span class="label">助攻</span></div>
      </div>
    </article>`;
  }).join('');
}
renderScorers(SCORERS);

/* ---------- 8. 渲染：球员 ---------- */
function renderPlayers(list) {
  const grid = document.getElementById('stars-grid');
  if (!grid) return;
  grid.innerHTML = list.map((s) => {
    const bg = safeUrl(s.img);
    const styleAttr = bg ? `style="background-image:url('${bg}')"` : '';
    return `<article class="player-card">
      <div class="player-photo" ${styleAttr}>${bg ? '' : '<span class="player-photo-empty">' + escapeHtml(s.name.slice(0, 1)) + '</span>'}</div>
      <div class="player-body">
        <h4 class="player-name">${escapeHtml(s.name)}</h4>
        <div class="player-team">${escapeHtml(s.country)}</div>
        <div class="player-stats">
          <div><span class="player-stat-label">世界杯进球</span><span class="player-stat-value">${escapeHtml(String(s.goals))}</span></div>
          <div><span class="player-stat-label">助攻</span><span class="player-stat-value">${escapeHtml(String(s.assists))}</span></div>
          <div><span class="player-stat-label">出场</span><span class="player-stat-value">${escapeHtml(String(s.wcapps))}</span></div>
        </div>
        <p class="player-license">${escapeHtml(s.license)}</p>
      </div>
    </article>`;
  }).join('');
}
renderPlayers(PLAYERS);

/* ---------- 9. 渲染：球场 ---------- */
function renderStadiums(list) {
  const grid = document.getElementById('host-grid');
  if (!grid) return;
  grid.innerHTML = list.map((h) => {
    const bg = safeUrl(h.img);
    const styleAttr = bg ? `style="background-image:url('${bg}')"` : '';
    return `<article class="host-card">
      <div class="host-photo" ${styleAttr}></div>
      <div class="host-body">
        <div class="host-country">${escapeHtml(h.country)}</div>
        <h4 class="host-stadium">${escapeHtml(h.stadium)}</h4>
        <div class="host-city">${escapeHtml(h.city)} · 容量 ${escapeHtml(h.capacity)}</div>
        <p class="host-meta">${escapeHtml(h.note)}</p>
        <p class="host-license">${escapeHtml(h.license)}</p>
      </div>
    </article>`;
  }).join('');
}
renderStadiums(STADIUMS);

/* ---------- 10. 渲染：新闻主区 ---------- */
function renderNews(items) {
  const hero = document.getElementById('news-hero');
  const list = document.getElementById('news-list');
  if (!hero || !list) return;

  if (!items || items.length === 0) {
    hero.innerHTML = `<div class="news-hero-empty">
      <p class="news-source">兜底</p>
      <p class="news-title">数据同步中…</p>
      <p class="news-summary">后端正在从公开 RSS 拉取世界杯相关新闻，稍后会自动出现。</p>
    </div>`;
    list.innerHTML = '';
    return;
  }

  const [first, ...rest] = items;
  const firstUrl = safeUrl(first.url);
  const firstImg = safeUrl(first.image);
  const firstSample = first.sample ? '<span class="news-sample">示例</span>' : '';
  const heroInner = `
    ${firstImg ? `<div class="news-hero-img" style="background-image:url('${escapeHtml(firstImg)}')"></div>` : ''}
    <div class="news-hero-body">
      <div class="news-source">${escapeHtml(first.source)}${firstSample}</div>
      <h3 class="news-hero-title">${escapeHtml(truncate(first.title, 120))}</h3>
      ${first.summary ? `<p class="news-hero-summary">${escapeHtml(truncate(first.summary, 200))}</p>` : ''}
      <span class="news-meta">${escapeHtml(timeAgo(first.ts))} · ${escapeHtml(fmtDate(first.fetched_at))}</span>
    </div>
  `;
  hero.innerHTML = firstUrl
    ? `<a class="news-hero-link" href="${escapeHtml(firstUrl)}" target="_blank" rel="noopener noreferrer nofollow">${heroInner}</a>`
    : heroInner;

  list.innerHTML = rest.slice(0, 6).map((n) => {
    const url = safeUrl(n.url);
    const sampleBadge = n.sample ? '<span class="news-sample">示例</span>' : '';
    const a = url
      ? `<a class="news-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">`
      : `<div class="news-item">`;
    const close = url ? '</a>' : '</div>';
    return `${a}
      <span class="news-source">${escapeHtml(n.source)}${sampleBadge}</span>
      <p class="news-title">${escapeHtml(truncate(n.title, 110))}</p>
      <span class="news-meta">${escapeHtml(timeAgo(n.ts))}</span>
    ${close}`;
  }).join('');
}
// 初始空占位
renderNews([]);

/* ---------- 11. 同步状态 ---------- */
function applySyncState(state) {
  const syncEl = document.getElementById('topnav-sync');
  const chipEl = document.getElementById('news-sync-chip');

  let label, cls, chipText;
  if (!state || !state.last_sync_at) {
    label = '尚未同步';
    cls = 'never';
    chipText = '尚未同步';
  } else if (state.degraded) {
    label = `${timeAgo(state.last_sync_at)} · 降级`;
    cls = 'degraded';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.ok_sources}/${state.total_sources} 源`;
  } else if (state.last_sync_status === 'partial') {
    label = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
    cls = '';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.ok_sources}/${state.total_sources} 源 · ${state.cached_items} 条`;
  } else {
    label = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
    cls = '';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
  }
  if (syncEl) {
    syncEl.classList.remove('degraded', 'never');
    if (cls) syncEl.classList.add(cls);
    const labelEl = syncEl.querySelector('.sync-label');
    if (labelEl) labelEl.textContent = label;
  }
  if (chipEl) chipEl.textContent = chipText;
}

/* ---------- 12. 启动：拉真实数据 ---------- */
async function loadFromBackend() {
  try {
    const { extCall } = await import('/extension/_sdk/ext.js');
    const r = await extCall({ action: 'read', limit: 40 });
    if (!r || !r.ok) {
      applySyncState(null);
      return;
    }
    if (r.news && r.news.length) renderNews(r.news);
    if (r.state) applySyncState(r.state);
  } catch (e) {
    console.warn('[world-cup] loadFromBackend failed (likely 401 / network), keeping static demo content:', e.message || e);
    applySyncState(null);
  }
}
loadFromBackend();
