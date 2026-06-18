const newsSeed = [
  {
    id: 'us-jobs-fed-path',
    title: '美国就业数据强于预期，交易员重新评估美联储降息节奏',
    summary: '非农和薪资信号显示劳动力市场仍有韧性，短端美债收益率上行，市场把年内降息定价向后推迟。',
    source: 'Kiplinger',
    url: 'https://www.kiplinger.com/investing/economy/jobs-report-may-2026-what-to-expect',
    publishedAt: '2026-06-05T12:35:00Z',
    market: ['美股', '全球宏观'],
    theme: ['央行'],
    assets: ['美债2Y', '美元指数', '标普500'],
    importance: '高',
    status: '未读',
    sentiment: '偏鹰',
    topics: ['美联储政策'],
    why: '就业强劲会削弱快速降息的必要性，对成长股估值、美元和新兴市场资金流都有传导影响。',
  },
  {
    id: 'fed-december-cut',
    title: '美联储年末降息预期降温，利率路径分歧扩大',
    summary: '市场对 12 月降息概率的判断出现摇摆，核心通胀、就业和财政供给成为接下来几个数据窗口的关键变量。',
    source: 'Axios',
    url: 'https://www.axios.com/2026/06/08/december-interest-rate-cute-fed',
    publishedAt: '2026-06-08T14:20:00Z',
    market: ['美股', '全球宏观'],
    theme: ['央行'],
    assets: ['纳斯达克100', '美元指数', '美债10Y'],
    importance: '高',
    status: '待跟进',
    sentiment: '中性偏鹰',
    topics: ['美联储政策'],
    why: '利率终点和降息时点影响权益估值、美元流动性和黄金定价，是当日宏观主线。',
  },
  {
    id: 'ecb-hike-pricing',
    title: '欧洲央行加息押注升温，油价和通胀成为欧股新压力',
    summary: '部分交易员开始定价欧洲央行可能重新偏鹰，但若通胀回落或增长放缓，当前押注可能面临反转。',
    source: 'MarketWatch',
    url: 'https://www.marketwatch.com/story/markets-are-pricing-in-a-rate-hike-by-the-european-central-bank-and-that-could-be-a-mistake-in-the-making-b99771ca',
    publishedAt: '2026-06-09T09:30:00Z',
    market: ['全球宏观', '外汇', '商品'],
    theme: ['央行'],
    assets: ['欧元', '德国国债', '布伦特原油'],
    importance: '中',
    status: '未读',
    sentiment: '偏鹰',
    topics: ['美联储政策'],
    why: '欧元区利率预期变化会影响欧元、欧洲银行股以及全球债券期限溢价。',
  },
  {
    id: 'bitcoin-etf-inflows',
    title: '比特币反弹至 63,000 美元附近，ETF 资金流重新成为焦点',
    summary: '现货 ETF 资金回流和大户买盘改善短线情绪，但杠杆清算和监管消息仍可能放大波动。',
    source: 'Economic Times',
    url: 'https://m.economictimes.com/markets/cryptocurrency/crypto-news/bitcoin-rebounds-above-63000-as-etf-inflows-return-and-large-investors-step-in/articleshow/131603472.cms',
    publishedAt: '2026-06-09T07:15:00Z',
    market: ['加密', '美股'],
    theme: ['监管'],
    assets: ['BTC', 'ETH', '加密 ETF'],
    importance: '中',
    status: '已读',
    sentiment: '风险偏好回升',
    topics: ['加密 ETF'],
    why: 'ETF 净流入是加密资产和相关美股矿企、交易平台的重要资金变量。',
  },
  {
    id: 'nvidia-gpu-supply',
    title: 'Nvidia 新一代 GPU 供应和价格预期扰动 AI 算力链',
    summary: '市场继续关注 RTX 50 Super 系列传闻和显存配置，投资者把供应节奏映射到 AI 服务器、光模块和数据中心资本开支。',
    source: "Tom's Hardware",
    url: 'https://www.tomshardware.com/pc-components/gpus/nvidia-is-reportedly-still-planning-fabled-rtx-50-super-series-for-2026-leak-claims-lineup-could-now-include-a-potential-rtx-5060-super-with-12gb-of-vram',
    publishedAt: '2026-06-07T16:45:00Z',
    market: ['美股', 'A股'],
    theme: ['科技', '财报'],
    assets: ['NVDA', '半导体', '光模块'],
    importance: '高',
    status: '待跟进',
    sentiment: '利好产业链',
    topics: ['AI 算力链'],
    why: 'GPU 产品节奏会影响 AI 服务器订单、上游存储和高速互联需求，也会牵动 A 股算力链情绪。',
  },
  {
    id: 'pboc-liquidity',
    title: '央行公开市场操作维持流动性合理充裕，人民币中间价受关注',
    summary: '短端资金利率保持平稳，交易员关注逆回购投放、税期扰动和人民币中间价对离岸汇率的牵引。',
    source: '中国人民银行 / 公开市场公告',
    url: 'https://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125431/index.html',
    publishedAt: '2026-06-10T01:30:00Z',
    market: ['A股', '外汇', '港股'],
    theme: ['央行', '银行'],
    assets: ['USDCNH', '银行间资金', '沪深300'],
    importance: '中',
    status: '未读',
    sentiment: '流动性中性',
    topics: ['人民币汇率', '港股流动性'],
    why: '人民币和短端资金面直接影响外资风险偏好、港股估值折现率和 A 股金融地产链。',
  },
  {
    id: 'hongkong-liquidity',
    title: '港股科技成交回暖，南向资金继续偏好高股息和互联网龙头',
    summary: '恒生科技权重股成交占比抬升，资金在互联网平台、运营商和高分红金融之间切换。',
    source: '港交所 / 市场成交数据',
    url: 'https://www.hkex.com.hk/Market-Data?sc_lang=zh-HK',
    publishedAt: '2026-06-10T03:05:00Z',
    market: ['港股'],
    theme: ['科技', '银行'],
    assets: ['恒生科技', '腾讯', '阿里巴巴', '南向资金'],
    importance: '中',
    status: '未读',
    sentiment: '结构性修复',
    topics: ['港股流动性', 'AI 算力链'],
    why: '南向资金风格切换会影响港股流动性折价，也会反馈到中概 ADR 和 A 股平台经济情绪。',
  },
  {
    id: 'china-policy-innovation',
    title: '政策继续强调科技创新和内需修复，A 股主题轮动加快',
    summary: '投资者把政策表述映射到先进制造、数字经济和消费修复，短线主题热度上升但持续性仍需成交确认。',
    source: '中国政府网',
    url: 'https://www.gov.cn/yaowen/',
    publishedAt: '2026-06-09T10:00:00Z',
    market: ['A股'],
    theme: ['科技', '监管'],
    assets: ['创业板指', '机器人', '消费电子'],
    importance: '中',
    status: '已读',
    sentiment: '政策托底',
    topics: ['AI 算力链'],
    why: '政策表述会带动主题资金风险偏好，但需要观察成交、产业订单和业绩兑现。',
  },
  {
    id: 'oil-geopolitics',
    title: '油价受供给扰动支撑，通胀交易重新压制长久期资产',
    summary: '原油供给不确定性抬升能源价格弹性，若油价持续上行，央行通胀容忍度和企业成本端将重新受压。',
    source: 'Reuters 市场综述',
    url: 'https://www.reuters.com/markets/',
    publishedAt: '2026-06-09T21:10:00Z',
    market: ['商品', '全球宏观'],
    theme: ['地缘政治', '央行'],
    assets: ['WTI 原油', '布伦特原油', '黄金'],
    importance: '高',
    status: '未读',
    sentiment: '通胀压力',
    topics: ['美联储政策'],
    why: '能源价格会影响通胀预期、航运成本和风险偏好，是跨资产高频变量。',
  },
  {
    id: 'bank-credit-watch',
    title: '银行和地产信用利差小幅走阔，市场关注融资链条压力',
    summary: '信用债成交分化，高等级金融债稳定，地产链民企和低评级主体继续承压。',
    source: 'Wind 风格样例',
    url: 'https://www.wind.com.cn/',
    publishedAt: '2026-06-10T02:20:00Z',
    market: ['A股', '港股'],
    theme: ['地产', '银行'],
    assets: ['银行股', '地产债', '城投债'],
    importance: '中',
    status: '待跟进',
    sentiment: '风险偏好下降',
    topics: ['港股流动性'],
    why: '信用利差变化会影响金融地产估值、银行资产质量预期和高股息交易拥挤度。',
  },
  {
    id: 'sec-ai-disclosure',
    title: '监管继续关注 AI 叙事披露，美股软件股估值分化',
    summary: '投资者开始区分真实 AI 收入、概念性披露和资本开支压力，软件板块内部强弱差扩大。',
    source: 'SEC 新闻与披露样例',
    url: 'https://www.sec.gov/newsroom',
    publishedAt: '2026-06-08T18:40:00Z',
    market: ['美股'],
    theme: ['监管', '科技'],
    assets: ['软件股', 'AI 应用', '纳斯达克100'],
    importance: '低',
    status: '已归档',
    sentiment: '分化',
    topics: ['AI 算力链'],
    why: '监管口径会影响 AI 概念估值质量，尤其是收入确认和风险披露。',
  },
  {
    id: 'brokerage-ma',
    title: '券商并购预期升温，资本市场改革主题带动板块活跃',
    summary: '市场讨论头部券商整合和投行业务修复，板块弹性来自成交额、政策预期与估值修复共振。',
    source: '交易所公告 / 财经媒体样例',
    url: 'https://www.sse.com.cn/',
    publishedAt: '2026-06-10T04:10:00Z',
    market: ['A股', '港股'],
    theme: ['券商', '并购', '监管'],
    assets: ['券商指数', '港股中资券商', '成交额'],
    importance: '低',
    status: '未读',
    sentiment: '主题活跃',
    topics: ['港股流动性'],
    why: '券商股往往是市场风险偏好和成交额的弹性表达，但需要政策和盈利改善确认。',
  },
];

const tickerSeed = [
  { symbol: 'DJIA', name: '道指', value: '39,182.24', delta: '+0.38%', tone: 'up' },
  { symbol: 'IXIC', name: '纳指', value: '18,904.71', delta: '+0.91%', tone: 'up' },
  { symbol: 'SPX', name: '标普500', value: '5,621.08', delta: '+0.44%', tone: 'up' },
  { symbol: 'HSI', name: '恒指', value: '18,472.66', delta: '-0.27%', tone: 'down' },
  { symbol: 'CSI300', name: '沪深300', value: '3,884.15', delta: '+0.16%', tone: 'up' },
  { symbol: 'DXY', name: '美元指数', value: '104.32', delta: '+0.12%', tone: 'neutral' },
  { symbol: 'XAU', name: '黄金', value: '2,368.50', delta: '+0.54%', tone: 'up' },
  { symbol: 'BTC', name: '比特币', value: '63,420', delta: '+2.18%', tone: 'up' },
];

const metricSeed = [
  { label: '全球风险脉冲', value: 78.4, suffix: '', delta: '+4.8', tone: 'up', precision: 1 },
  { label: '高影响事件', value: 4, suffix: ' 条', delta: '+2', tone: 'hot', precision: 0 },
  { label: '跨资产联动', value: 91.6, suffix: '%', delta: '+7.1%', tone: 'up', precision: 1 },
  { label: '新闻速度', value: 12.8, suffix: '/min', delta: '+1.9', tone: 'neutral', precision: 1 },
];

const heatSeed = [
  { name: '美联储', value: 92, tone: 'hot' },
  { name: 'AI 算力', value: 88, tone: 'hot' },
  { name: '原油', value: 81, tone: 'warm' },
  { name: '比特币', value: 76, tone: 'warm' },
  { name: '港股科技', value: 72, tone: 'warm' },
  { name: '人民币', value: 64, tone: 'cool' },
  { name: '银行信用', value: 58, tone: 'cool' },
  { name: '地产链', value: 52, tone: 'cold' },
  { name: '券商', value: 49, tone: 'cold' },
  { name: '欧央行', value: 68, tone: 'cool' },
  { name: '黄金', value: 73, tone: 'warm' },
  { name: '软件股', value: 46, tone: 'cold' },
  { name: '南向资金', value: 69, tone: 'cool' },
  { name: '消费电子', value: 62, tone: 'cool' },
  { name: '美债2Y', value: 84, tone: 'hot' },
  { name: '美元', value: 66, tone: 'cool' },
];

const visualPalettes = [
  ['#00e5ff', '#8b5cf6'],
  ['#f43f5e', '#f59e0b'],
  ['#22c55e', '#06b6d4'],
  ['#e879f9', '#38bdf8'],
  ['#f97316', '#14b8a6'],
  ['#60a5fa', '#a78bfa'],
];

const state = {
  search: '',
  selectedNewsId: '',
  visibleCount: 9,
  flashId: newsSeed[0]?.id || '',
  metricPulse: metricSeed.map((item) => item.value),
  mouse: { x: -1000, y: -1000 },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function relativeTime(iso) {
  const diff = Date.now() - Date.parse(iso);
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function importanceClass(value) {
  return value === '高' ? 'high' : value === '中' ? 'medium' : 'low';
}

function unique(items, max = 8) {
  const out = [];
  const seen = new Set();
  for (const item of items.filter(Boolean)) {
    const text = String(item).trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function impactScore(item) {
  const base = { 高: 86, 中: 68, 低: 48 }[item.importance] || 56;
  const marketBoost = Math.min((item.market?.length || 1) * 3, 9);
  const assetBoost = Math.min((item.assets?.length || 1) * 2, 8);
  const sentimentBoost = /风险|通胀|偏鹰|利好/.test(item.sentiment || '') ? 5 : 0;
  return Math.min(99, base + marketBoost + assetBoost + sentimentBoost);
}

function impactStars(score) {
  const filled = Math.max(1, Math.min(5, Math.round(score / 20)));
  return Array.from({ length: 5 }, (_, index) => index < filled ? '★' : '☆').join('');
}

function filteredNews() {
  const query = state.search.trim().toLowerCase();
  if (!query) return newsSeed;
  return newsSeed.filter((item) => [
    item.title,
    item.summary,
    item.source,
    item.sentiment,
    ...(item.market || []),
    ...(item.theme || []),
    ...(item.assets || []),
    ...(item.topics || []),
  ].join(' ').toLowerCase().includes(query));
}

function visibleNews() {
  return filteredNews().slice(0, state.visibleCount);
}

function selectedNews() {
  return newsSeed.find((item) => item.id === state.selectedNewsId) || null;
}

function paletteFor(index) {
  return visualPalettes[index % visualPalettes.length];
}

function cardStyle(index) {
  const [toneA, toneB] = paletteFor(index);
  return `--delay: ${Math.min(index * 70, 700)}ms; --tone-a: ${toneA}; --tone-b: ${toneB};`;
}

function trendClass(tone) {
  if (tone === 'down') return 'is-down';
  if (tone === 'hot') return 'is-hot';
  return tone === 'neutral' ? 'is-neutral' : 'is-up';
}

function renderTicker() {
  const rows = [...tickerSeed, ...tickerSeed];
  return `
    <section class="ticker-wrap" aria-label="市场指数滚动条">
      <div class="ticker-track">
        ${rows.map((item) => `
          <div class="ticker-item ${trendClass(item.tone)}">
            <span class="ticker-symbol">${escapeHtml(item.symbol)}</span>
            <strong>${escapeHtml(item.value)}</strong>
            <span>${escapeHtml(item.delta)}</span>
            <em>${escapeHtml(item.name)}</em>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderHeroMetrics() {
  return `
    <section class="market-metrics" aria-label="核心市场指标">
      ${metricSeed.map((item, index) => {
        const value = state.metricPulse[index] ?? item.value;
        const formatted = item.precision ? value.toFixed(item.precision) : String(Math.round(value));
        return `
          <article class="metric-card ${trendClass(item.tone)}" style="--delay: ${index * 120}ms">
            <span>${escapeHtml(item.label)}</span>
            <strong class="metric-value">${escapeHtml(formatted)}${escapeHtml(item.suffix)}</strong>
            <em>${escapeHtml(item.delta)}</em>
          </article>
        `;
      }).join('')}
    </section>
  `;
}

function renderHeatmap() {
  return `
    <section class="heatmap-panel">
      <div class="section-head">
        <div>
          <span class="eyebrow">SENTIMENT GRID</span>
          <h2>情绪热力图</h2>
        </div>
        <p>16 个市场主题的模拟热度</p>
      </div>
      <div class="heatmap-grid">
        ${heatSeed.map((item, index) => `
          <button class="heat-cell ${item.tone}" style="--heat: ${item.value}; --delay: ${index * 45}ms" data-heat="${escapeHtml(item.name)}">
            <span>${escapeHtml(item.name)}</span>
            <strong>${item.value}</strong>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderIncoming(rows) {
  const item = rows.find((row) => row.id === state.flashId) || rows[0];
  if (!item) return '';
  const score = impactScore(item);
  return `
    <button class="incoming-card" data-action="open-news" data-news-id="${escapeHtml(item.id)}">
      <span class="live-dot"></span>
      <div>
        <strong>高影响新闻脉冲</strong>
        <p>${escapeHtml(item.title)}</p>
      </div>
      <em>${score}</em>
    </button>
  `;
}

function renderNewsCard(item, index) {
  const score = impactScore(item);
  const critical = item.importance === '高' || score >= 90;
  const isNew = item.id === state.flashId;
  return `
    <article class="news-card ${importanceClass(item.importance)} ${critical ? 'critical' : ''} ${isNew ? 'is-new' : ''}" style="${cardStyle(index)}">
      <button class="card-hit" data-action="open-news" data-news-id="${escapeHtml(item.id)}" aria-label="打开新闻详情：${escapeHtml(item.title)}">
        <div class="news-visual">
          <span class="scan-line"></span>
          <div class="impact-ring"><strong>${score}</strong><span>IMPACT</span></div>
        </div>
        <div class="news-content">
          <div class="card-kicker">
            <span>${escapeHtml(item.source)}</span>
            <span>${escapeHtml(formatDateTime(item.publishedAt))}</span>
            <span>${escapeHtml(item.sentiment)}</span>
          </div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.summary)}</p>
          <div class="impact-stars" aria-label="影响评分 ${score}">
            <span>${impactStars(score)}</span>
            <strong>${score}</strong>
          </div>
          <div class="tag-row">
            ${unique([...(item.market || []), ...(item.theme || []), ...(item.assets || [])], 5).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
          </div>
        </div>
      </button>
    </article>
  `;
}

function renderNewsWall() {
  const rows = filteredNews();
  const shown = rows.slice(0, state.visibleCount);
  return `
    <section class="news-wall">
      <div class="section-head news-wall-head">
        <div>
          <span class="eyebrow">LIVE NEWS WALL</span>
          <h2>实时新闻瀑布</h2>
        </div>
        <p>${shown.length} / ${rows.length} 条事件</p>
      </div>
      ${renderIncoming(rows)}
      <div class="news-masonry">
        ${shown.map(renderNewsCard).join('') || '<div class="empty-state">没有匹配的新闻事件</div>'}
      </div>
      ${shown.length < rows.length ? '<button class="load-more" data-action="load-more">查看更多</button>' : ''}
    </section>
  `;
}

function renderModal() {
  const item = selectedNews();
  if (!item) return '';
  const score = impactScore(item);
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <article class="news-modal" role="dialog" aria-modal="true" aria-label="新闻详情" data-modal-panel>
        <button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>
        <div class="modal-visual" style="${cardStyle(newsSeed.indexOf(item))}">
          <div class="impact-ring large"><strong>${score}</strong><span>IMPACT</span></div>
        </div>
        <div class="modal-body">
          <div class="modal-meta">
            <span>${escapeHtml(item.source)}</span>
            <span>${escapeHtml(relativeTime(item.publishedAt))}</span>
            <span>${escapeHtml(item.importance)}影响</span>
            <span>${escapeHtml(item.sentiment)}</span>
          </div>
          <h2>${escapeHtml(item.title)}</h2>
          <p class="modal-summary">${escapeHtml(item.summary)}</p>
          <div class="modal-grid">
            <section>
              <h3>为什么影响市场</h3>
              <p>${escapeHtml(item.why)}</p>
            </section>
            <section>
              <h3>关联资产</h3>
              <div class="tag-row">${(item.assets || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
            </section>
            <section>
              <h3>市场与主题</h3>
              <div class="tag-row">${unique([...(item.market || []), ...(item.theme || []), ...(item.topics || [])], 8).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
            </section>
          </div>
          ${item.url ? `<a class="source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">打开来源</a>` : ''}
        </div>
      </article>
    </div>
  `;
}

function render() {
  const app = $('#app');
  const highCount = newsSeed.filter((item) => item.importance === '高').length;
  app.innerHTML = `
    <div class="deep-space-page">
      ${renderTicker()}
      <section class="hero">
        <div class="hero-copy">
          <span class="eyebrow">MARKET EVENT RADAR</span>
          <h2>把影响市场的新闻变成一面会发光的雷达墙</h2>
          <p>用演示数据模拟全球宏观、美股、港股、A 股、商品和加密市场的事件流。当前版本只展示前端体验，不抓真实 API。</p>
          <div class="hero-actions">
            <button class="primary-btn" data-action="trigger-pulse">触发新闻脉冲</button>
            <button class="ghost-btn" data-action="focus-high">查看高影响</button>
          </div>
        </div>
        <div class="hero-orbit" aria-hidden="true">
          <div class="radar-core"><strong>${highCount}</strong><span>HIGH IMPACT</span></div>
          <i></i><i></i><i></i>
        </div>
      </section>
      ${renderHeroMetrics()}
      <div class="content-grid">
        ${renderHeatmap()}
        <section class="signal-panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">SIGNAL STACK</span>
              <h2>市场信号</h2>
            </div>
          </div>
          <div class="signal-list">
            <div><span>覆盖市场</span><strong>${unique(newsSeed.flatMap((item) => item.market || []), 20).length}</strong></div>
            <div><span>关联资产</span><strong>${unique(newsSeed.flatMap((item) => item.assets || []), 40).length}</strong></div>
            <div><span>平均影响分</span><strong>${Math.round(newsSeed.reduce((sum, item) => sum + impactScore(item), 0) / newsSeed.length)}</strong></div>
          </div>
        </section>
      </div>
      ${renderNewsWall()}
    </div>
    ${renderModal()}
  `;
}

function flashNews(newsId = '') {
  const highRows = newsSeed.filter((item) => item.importance === '高');
  const pool = highRows.length ? highRows : newsSeed;
  const next = newsId || pool[Math.floor(Math.random() * pool.length)]?.id || newsSeed[0]?.id || '';
  state.flashId = next;
  state.visibleCount = Math.max(state.visibleCount, 6);
  render();
}

function updateMarketPulse() {
  state.metricPulse = metricSeed.map((item, index) => {
    const current = state.metricPulse[index] ?? item.value;
    const drift = item.precision ? (Math.random() - 0.42) * 1.4 : (Math.random() > 0.55 ? 1 : 0);
    const min = item.precision ? item.value - 4 : Math.max(1, item.value - 2);
    const max = item.precision ? item.value + 5 : item.value + 4;
    return Math.max(min, Math.min(max, current + drift));
  });
  if (!state.selectedNewsId) render();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function initParticles() {
  const canvas = $('#particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const particles = [];
  const config = { count: 96, maxDistance: 130 };
  let width = 0;
  let height = 0;
  let raf = 0;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * window.devicePixelRatio);
    canvas.height = Math.floor(height * window.devicePixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    if (!particles.length) {
      for (let index = 0; index < config.count; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: Math.random() * 1.8 + 0.5,
        });
      }
    }
  }

  function tick() {
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      const dx = p.x - state.mouse.x;
      const dy = p.y - state.mouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 150) {
        const force = (150 - dist) / 150;
        p.vx += (dx / Math.max(dist, 1)) * force * 0.018;
        p.vy += (dy / Math.max(dist, 1)) * force * 0.018;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.992;
      p.vy *= 0.992;
      if (p.x < -20) p.x = width + 20;
      if (p.x > width + 20) p.x = -20;
      if (p.y < -20) p.y = height + 20;
      if (p.y > height + 20) p.y = -20;
    }

    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];
      ctx.beginPath();
      ctx.fillStyle = 'rgba(125, 211, 252, 0.58)';
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
      for (let j = i + 1; j < particles.length; j += 1) {
        const b = particles[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > config.maxDistance) continue;
        const alpha = (1 - dist / config.maxDistance) * 0.16;
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  resize();
  tick();
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', () => cancelAnimationFrame(raf));
}

document.addEventListener('click', (event) => {
  const modalPanel = event.target.closest('[data-modal-panel]');
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  if (action === 'open-news') {
    state.selectedNewsId = actionEl.dataset.newsId || '';
    render();
  } else if (action === 'close-modal' && (!modalPanel || actionEl.classList.contains('modal-close'))) {
    state.selectedNewsId = '';
    render();
  } else if (action === 'load-more') {
    state.visibleCount += 6;
    render();
  } else if (action === 'trigger-pulse') {
    flashNews();
    showToast('已触发一条高影响新闻脉冲');
  } else if (action === 'focus-high') {
    const firstHigh = newsSeed.find((item) => item.importance === '高');
    if (firstHigh) {
      flashNews(firstHigh.id);
      state.selectedNewsId = firstHigh.id;
      render();
      showToast('高影响事件已置顶闪烁');
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selectedNewsId) {
    state.selectedNewsId = '';
    render();
  }
});

window.addEventListener('mousemove', (event) => {
  state.mouse.x = event.clientX;
  state.mouse.y = event.clientY;
});

window.addEventListener('mouseleave', () => {
  state.mouse.x = -1000;
  state.mouse.y = -1000;
});

$('#globalSearch').addEventListener('input', (event) => {
  state.search = event.target.value;
  state.visibleCount = 9;
  render();
});

$('#pulseBtn').addEventListener('click', () => {
  flashNews();
  showToast('已触发新闻脉冲');
});

render();
initParticles();
setInterval(updateMarketPulse, 2800);
setInterval(() => {
  if (!state.selectedNewsId) flashNews();
}, 11000);
