const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_FILE = 'self-cognition.db';
const MAX_LIMIT = 200;
const DEFAULT_SCAN_QUERY = 'all:"Gödel Agent" OR all:"self-improving agents" OR all:"recursive self-improvement"';

const SOURCE_TYPES = new Set(['paper', 'framework', 'method', 'note', 'scan']);
const STATUSES = new Set(['new', 'candidate', 'triaged', 'planned', 'applied', 'archived']);
const DIRECTIVE_STATUSES = new Set(['open', 'planned', 'done', 'archived']);
const PRIORITIES = new Set(['low', 'medium', 'high']);

const SEED_IDEAS = [
  {
    id: 'seed-goedel-machine',
    title: 'Gödel Machines: Fully Self-Referential Optimal Universal Self-Improvers',
    source_url: 'https://people.idsia.ch/~juergen/goedelmachine.html',
    source_id: 'cs.LO/0309048',
    source_type: 'paper',
    status: 'triaged',
    relevance: 5,
    authors: 'Jürgen Schmidhuber',
    published_at: '2003-09-24',
    tags: ['哥德尔机', '证明式改进', '元规则', '安全边界'],
    abstract: '哥德尔机把自身程序、效用函数、硬件与初始证明搜索器都纳入形式系统, 只有当系统找到“修改有用”的证明时才允许改写自身。理论吸引力很强, 但现实系统很难为复杂修改给出可执行的全局证明。',
    key_inspiration: '莫比乌斯不能直接追求“任意自改写”, 应该先把自我修改拆成可证明或可检验的小变更: 变更目标、影响面、验证命令、回滚条件必须被显式记录。哥德尔机的价值不是立刻落地证明器, 而是提醒我们把“为什么这次改动值得保留”作为一等对象。',
    mobius_use: '建立“改动证明包”: 每次自迭代生成候选 patch 时, 同步写入预期收益、适用范围、验证证据和失败回滚路径。短期用测试与人工 review 替代理论证明, 长期再引入更强的规格检查。',
    limitations: '理论要求过高, 对真实大型代码库几乎不可直接满足; 需要用经验验证、沙箱和分级权限作为工程替代。',
  },
  {
    id: 'seed-godel-agent',
    title: 'Gödel Agent: A Self-Referential Agent Framework for Recursive Self-Improvement',
    source_url: 'https://arxiv.org/abs/2410.04444',
    source_id: '2410.04444',
    source_type: 'framework',
    status: 'triaged',
    relevance: 5,
    authors: 'Xunjian Yin; Xinyi Wang; Liangming Pan; Li Lin; Xiaojun Wan; William Yang Wang',
    published_at: '2024-10-06',
    tags: ['哥德尔智能体', '递归自我改进', '策略更新', '反思'],
    abstract: 'Gödel Agent 让智能体读取并修改自身的执行逻辑和更新规则, 不只优化任务策略, 也把“如何优化策略”的方法纳入优化对象。论文版本显示该工作为 ACL 2025 main。',
    key_inspiration: '莫比乌斯的自迭代不应只停留在“收到 issue 后改代码”, 还要沉淀和改进“如何提出 issue、如何评估改动、如何选择下一轮探索”的元流程。真正重要的是把 π 和 I 都数据化: π 是当前能力与插件, I 是自迭代规则、提示词、测试策略和回滚策略。',
    mobius_use: '本插件先作为外部启发库与元规则草稿箱: 每条研究内容都必须写清楚 key_inspiration 和 mobius_use, 后续再把高相关条目转为自迭代 issue。',
    limitations: '论文系统依赖 LLM 直接改写逻辑并用任务反馈保留修改, 容易受基准过拟合、局部最优和代码生成错误影响; Mobius 需要更强审计和权限分层。',
  },
  {
    id: 'seed-darwin-godel-machine',
    title: 'Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents',
    source_url: 'https://arxiv.org/abs/2505.22954',
    source_id: '2505.22954',
    source_type: 'framework',
    status: 'triaged',
    relevance: 5,
    authors: 'Jenny Zhang; Shengran Hu; Cong Lu; Robert Lange; Jeff Clune',
    published_at: '2025-05-29',
    tags: ['开放式进化', '候选档案', '编码智能体', '沙箱'],
    abstract: 'DGM 维护一个不断增长的智能体档案树, 从历史候选中采样并生成新版本, 再用编码基准经验验证是否保留。论文强调开放式探索、候选多样性、沙箱和人工监督。',
    key_inspiration: '莫比乌斯需要的不只是单一路径的线性自我改进, 而是“候选方案档案”。失败方案也应该被保留为反例和禁忌, 成功方案需要记录血缘、适用场景和验证分数, 这样才能避免每次从零开始。',
    mobius_use: '为后续自迭代增加 lineage: idea -> issue -> session -> patch -> test -> outcome。插件中的 status=applied 条目可作为 lineage 根节点, scan_arxiv 产生的候选条目可作为探索入口。',
    limitations: 'DGM 以编码基准作为适应度, 仍可能过拟合基准; 对真实产品还必须加入用户体验、数据安全、可维护性和运行成本指标。',
  },
  {
    id: 'seed-polaris',
    title: 'Polaris: A Gödel Agent Framework for Small Language Models through Experience-Abstracted Policy Repair',
    source_url: 'https://arxiv.org/abs/2603.23129',
    source_id: '2603.23129',
    source_type: 'method',
    status: 'triaged',
    relevance: 5,
    authors: 'Aditya Kakade; Vivek Srivastava; Shirish Karande',
    published_at: '2026-03-24',
    tags: ['经验抽象', '最小补丁', '小模型', '策略修复'],
    abstract: 'Polaris 面向小语言模型, 将失败经验抽象成可复用策略, 再用最小代码/策略补丁修复政策。arXiv 记录显示其为 ACL 2026 Findings。',
    key_inspiration: '对莫比乌斯最直接的启发是“经验抽象优先于大改”。每次失败不一定马上改系统, 可以先抽象为一条可复用策略或反模式; 只有当相同失败重复出现时, 才生成最小可审计补丁。',
    mobius_use: '在自迭代 Session 结束时沉淀三类资产: failure_pattern、repair_rule、minimal_patch。这个插件先承载人工整理的 experience abstraction, 后续可让 agent 自动从 session log 生成。',
    limitations: '小模型场景的收益不等于大型产品系统收益; “最小补丁”需要配套回归测试, 否则只是看起来更安全。',
  },
  {
    id: 'seed-huxley-godel-machine',
    title: 'Huxley-Gödel Machine: Human-Level Coding Agent Development by an Approximation of the Optimal Self-Improving Machine',
    source_url: 'https://arxiv.org/abs/2510.21614',
    source_id: '2510.21614',
    source_type: 'method',
    status: 'candidate',
    relevance: 4,
    authors: 'Wenyi Wang; Piotr Piekos; Li Nanbo; Firas Laakom; Yimeng Chen; Mateusz Ostaszewski; Mingchen Zhuge; Jürgen Schmidhuber',
    published_at: '2025-10-24',
    tags: ['元生产力', '血缘评估', '编码智能体', '搜索策略'],
    abstract: 'HGM 指出单次编码基准表现不一定代表后续自我改进潜力, 因此提出用后代表现聚合指标估计某个智能体分支的“元生产力”。',
    key_inspiration: '莫比乌斯评估一次改动时, 不能只看当前测试是否通过, 还要看它是否提升了后续迭代能力: 是否让日志更清晰、测试更可复用、错误更可定位、未来 patch 更容易生成。',
    mobius_use: '给自迭代引入“元生产力”指标: 新增测试数量、复用知识条目、减少人工澄清次数、降低回滚概率、提升后续任务成功率。插件可以先记录候选指标, 后续接入真实统计。',
    limitations: 'HGM 的指标仍来自 benchmark 树, 迁移到 Mobius 时需要重新定义产品级收益和安全约束。',
  },
  {
    id: 'seed-harnessfix',
    title: 'From Failed Trajectories to Reliable LLM Agents: Diagnosing and Repairing Harness Flaws',
    source_url: 'https://arxiv.org/abs/2606.06324',
    source_id: '2606.06324',
    source_type: 'method',
    status: 'candidate',
    relevance: 4,
    authors: 'Mengzhuo Chen; Junjie Wang; Zhe Liu; Yawen Wang; Qing Wang',
    published_at: '2026-06-04',
    tags: ['轨迹诊断', '工具层修复', 'harness', '失败归因'],
    abstract: 'HarnessFix 把失败轨迹转成面向执行框架的中间表示, 再定位失败属于工具接口、上下文、生命周期、观测或治理中的哪一层, 最后生成有边界的修复。',
    key_inspiration: '莫比乌斯自迭代失败时不要只说“模型没做好”, 应该把失败归因到环境、工具、上下文、权限、测试、交互或模型推理中的具体层。',
    mobius_use: '为 Session 日志增加 failure_layer 字段和修复模板: 如果是上下文缺失, 修 context; 如果是工具协议不清, 修工具; 如果是模型判断错误, 再修 prompt 或策略。',
    limitations: '需要结构化执行轨迹和可观测性支持; 当前 Mobius 日志还需要进一步标准化。',
  },
  {
    id: 'seed-activegraph',
    title: 'The Log is the Agent: Event-Sourced Reactive Graphs for Auditable, Forkable Agentic Systems',
    source_url: 'https://arxiv.org/abs/2605.21997',
    source_id: '2605.21997',
    source_type: 'framework',
    status: 'candidate',
    relevance: 4,
    authors: 'Yohei Nakajima',
    published_at: '2026-05-21',
    tags: ['事件溯源', '可回放', 'fork', '审计'],
    abstract: 'ActiveGraph 主张把 append-only event log 作为智能体系统的事实源, 工作图只是日志的确定性投影, 从而获得回放、分叉和 lineage。',
    key_inspiration: '莫比乌斯要走向自我认知, 必须让“我为什么变成现在这样”可回放。比起把 memory 当摘要, 更强的方式是保留事件流和可重建状态。',
    mobius_use: '后续把自迭代链路改造成 event-sourced: 研究条目、issue、session、命令、测试、commit、用户反馈都是事件, 页面展示的是投影。',
    limitations: '事件模型会增加存储和 schema 设计成本; 需要决定哪些事件必须稳定、哪些只保留摘要。',
  },
  {
    id: 'seed-skillsmith',
    title: 'SkillSmith: Co-Evolving Skills and Tools for Self-Improving Agent Systems',
    source_url: 'https://arxiv.org/abs/2606.01314',
    source_id: '2606.01314',
    source_type: 'method',
    status: 'candidate',
    relevance: 4,
    authors: 'Yangbo Wei; Zhen Huang; Shaoqiang Lu; Junhong Qian; Qifan Wang; Chen Wu; Lei He',
    published_at: '2026-05-31',
    tags: ['skill', 'tool', '协同进化', '反模式'],
    abstract: 'SkillSmith 把技能与工具放进统一变更空间, 允许同时修复技能逻辑和工具层问题, 并记录失败反模式来阻止重复错误。',
    key_inspiration: '莫比乌斯已有 skills, 但自迭代不能只优化 skill 文案, 也要在必要时修工具协议、权限边界和测试方式。技能和工具应该协同进化。',
    mobius_use: '把每次失败沉淀成 anti-pattern: 触发条件、症状、根因、修复方式、禁止重复的方案。插件可作为反模式库的第一版。',
    limitations: '工具层自动修改风险更高, 必须走白名单、回归测试和人工批准。',
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, max = 1000) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanLongText(value, max = 8000) {
  const s = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，;；\n]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = cleanText(item, 32);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function mustUrl(value) {
  const url = cleanText(value, 800);
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error('source_url 必须是 http(s) URL');
  }
  return url;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16)}`;
}

function rowToIdea(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  return {
    ...row,
    relevance: Number(row.relevance) || 3,
    auto_fetched: !!row.auto_fetched,
    tags,
  };
}

function rowToDirective(row) {
  return row ? { ...row } : null;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'paper',
      status TEXT NOT NULL DEFAULT 'new',
      relevance INTEGER NOT NULL DEFAULT 3,
      authors TEXT NOT NULL DEFAULT '',
      published_at TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      abstract TEXT NOT NULL DEFAULT '',
      key_inspiration TEXT NOT NULL,
      mobius_use TEXT NOT NULL DEFAULT '',
      limitations TEXT NOT NULL DEFAULT '',
      auto_fetched INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_source_id
      ON ideas(source_id)
      WHERE source_id IS NOT NULL AND source_id != '';
    CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
    CREATE INDEX IF NOT EXISTS idx_ideas_source_type ON ideas(source_type);
    CREATE INDEX IF NOT EXISTS idx_ideas_created_at ON ideas(created_at DESC);

    CREATE TABLE IF NOT EXISTS directives (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_directives_status ON directives(status);

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      max_results INTEGER NOT NULL,
      inserted INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function openDb(extDataDir) {
  ensureDir(extDataDir);
  const db = new Database(path.join(extDataDir, DB_FILE));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initDb(db);
  seedIdeas(db);
  return db;
}

function seedIdeas(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ideas (
      id, title, source_url, source_id, source_type, status, relevance,
      authors, published_at, tags, abstract, key_inspiration, mobius_use,
      limitations, auto_fetched, fetched_at, created_by, created_at, updated_at
    ) VALUES (
      @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
      @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
      @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at
    )
  `);
  const ts = '2026-06-21T00:00:00.000Z';
  const tx = db.transaction(() => {
    for (const item of SEED_IDEAS) {
      insert.run({
        ...item,
        tags: JSON.stringify(normalizeTags(item.tags)),
        auto_fetched: 0,
        fetched_at: null,
        created_by: 'system',
        created_at: ts,
        updated_at: ts,
      });
    }
  });
  tx();
}

function validateIdeaInput(input, mode) {
  const isCreate = mode === 'create';
  const title = cleanText(input.title, 260);
  const sourceUrl = input.source_url == null && !isCreate ? undefined : mustUrl(input.source_url);
  const keyInspiration = input.key_inspiration == null && !isCreate
    ? undefined
    : cleanLongText(input.key_inspiration, 5000);
  if (isCreate && !title) throw new Error('title 不能为空');
  if (title === '' && input.title != null) throw new Error('title 不能为空');
  if (isCreate && !keyInspiration) throw new Error('key_inspiration 不能为空');
  if (keyInspiration === '' && input.key_inspiration != null) throw new Error('key_inspiration 不能为空');

  const sourceType = input.source_type == null
    ? undefined
    : cleanText(input.source_type, 32);
  if (sourceType != null && !SOURCE_TYPES.has(sourceType)) throw new Error('source_type 非法');
  const status = input.status == null
    ? undefined
    : cleanText(input.status, 32);
  if (status != null && !STATUSES.has(status)) throw new Error('status 非法');

  const out = {};
  if (input.title != null) out.title = title;
  if (sourceUrl !== undefined) out.source_url = sourceUrl;
  if (input.source_id != null) out.source_id = cleanText(input.source_id, 120);
  if (sourceType != null) out.source_type = sourceType;
  if (status != null) out.status = status;
  if (input.relevance != null) out.relevance = clampInt(input.relevance, 3, 1, 5);
  if (input.authors != null) out.authors = cleanText(input.authors, 500);
  if (input.published_at != null) out.published_at = cleanText(input.published_at, 32) || null;
  if (input.tags != null) out.tags = JSON.stringify(normalizeTags(input.tags));
  if (input.abstract != null) out.abstract = cleanLongText(input.abstract, 6000);
  if (keyInspiration !== undefined) out.key_inspiration = keyInspiration;
  if (input.mobius_use != null) out.mobius_use = cleanLongText(input.mobius_use, 5000);
  if (input.limitations != null) out.limitations = cleanLongText(input.limitations, 3000);
  return out;
}

function getIdea(db, id) {
  return rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id));
}

function listIdeas(db, payload) {
  const where = [];
  const params = [];
  const q = cleanText(payload.q, 120);
  if (q) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    where.push(`(
      title LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
      OR abstract LIKE ? ESCAPE '\\' OR key_inspiration LIKE ? ESCAPE '\\'
      OR mobius_use LIKE ? ESCAPE '\\' OR limitations LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const status = cleanText(payload.status, 32);
  if (status && STATUSES.has(status)) {
    where.push('status = ?');
    params.push(status);
  }
  const sourceType = cleanText(payload.source_type, 32);
  if (sourceType && SOURCE_TYPES.has(sourceType)) {
    where.push('source_type = ?');
    params.push(sourceType);
  }
  const tag = cleanText(payload.tag, 32);
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${tag.replace(/"/g, '')}"%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = clampInt(payload.limit, 80, 1, MAX_LIMIT);
  const offset = clampInt(payload.offset, 0, 0, 100000);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ideas ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT * FROM ideas
    ${whereSql}
    ORDER BY
      CASE status
        WHEN 'triaged' THEN 1
        WHEN 'planned' THEN 2
        WHEN 'candidate' THEN 3
        WHEN 'new' THEN 4
        WHEN 'applied' THEN 5
        ELSE 6
      END,
      relevance DESC,
      COALESCE(published_at, created_at) DESC,
      created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { ideas: rows.map(rowToIdea), total };
}

function stats(db) {
  const all = db.prepare('SELECT status, source_type, tags, relevance FROM ideas').all();
  const byStatus = {};
  const bySourceType = {};
  const byTag = {};
  let relevanceSum = 0;
  for (const row of all) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    bySourceType[row.source_type] = (bySourceType[row.source_type] || 0) + 1;
    relevanceSum += Number(row.relevance) || 0;
    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
    for (const tag of tags) byTag[tag] = (byTag[tag] || 0) + 1;
  }
  const directiveOpen = db.prepare("SELECT COUNT(*) AS n FROM directives WHERE status IN ('open', 'planned')").get().n;
  return {
    total: all.length,
    avg_relevance: all.length ? Number((relevanceSum / all.length).toFixed(2)) : 0,
    by_status: byStatus,
    by_source_type: bySourceType,
    by_tag: Object.entries(byTag)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([tag, count]) => ({ tag, count })),
    directive_open: directiveOpen,
  };
}

function createIdea(db, payload, username) {
  const fields = validateIdeaInput(payload, 'create');
  const ts = nowIso();
  const idea = {
    id: newId('i'),
    title: fields.title,
    source_url: fields.source_url,
    source_id: fields.source_id || '',
    source_type: fields.source_type || 'note',
    status: fields.status || 'new',
    relevance: fields.relevance || 3,
    authors: fields.authors || '',
    published_at: fields.published_at || null,
    tags: fields.tags || '[]',
    abstract: fields.abstract || '',
    key_inspiration: fields.key_inspiration,
    mobius_use: fields.mobius_use || '',
    limitations: fields.limitations || '',
    auto_fetched: 0,
    fetched_at: null,
    created_by: username,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(`
    INSERT INTO ideas (
      id, title, source_url, source_id, source_type, status, relevance,
      authors, published_at, tags, abstract, key_inspiration, mobius_use,
      limitations, auto_fetched, fetched_at, created_by, created_at, updated_at
    ) VALUES (
      @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
      @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
      @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at
    )
  `).run(idea);
  return getIdea(db, idea.id);
}

function updateIdea(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  const current = getIdea(db, id);
  if (!current) throw new Error('条目不存在');
  const fields = validateIdeaInput(payload, 'update');
  const entries = Object.entries(fields);
  if (!entries.length) return current;
  entries.push(['updated_at', nowIso()]);
  const sql = `UPDATE ideas SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), id);
  return getIdea(db, id);
}

function setStatus(db, payload) {
  const id = cleanText(payload.id, 120);
  const status = cleanText(payload.status, 32);
  if (!id) throw new Error('id 必填');
  if (!STATUSES.has(status)) throw new Error('status 非法');
  const res = db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  if (!res.changes) throw new Error('条目不存在');
  return getIdea(db, id);
}

function deleteIdea(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
  return { id };
}

function listDirectives(db) {
  return db.prepare(`
    SELECT * FROM directives
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      CASE status WHEN 'open' THEN 1 WHEN 'planned' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      created_at DESC
  `).all().map(rowToDirective);
}

function validateDirectiveInput(input, mode) {
  const isCreate = mode === 'create';
  const title = cleanText(input.title, 180);
  const body = cleanLongText(input.body, 4000);
  if (isCreate && !title) throw new Error('指示标题不能为空');
  if (input.title != null && !title) throw new Error('指示标题不能为空');
  if (isCreate && !body) throw new Error('指示内容不能为空');
  if (input.body != null && !body) throw new Error('指示内容不能为空');
  const priority = input.priority == null ? undefined : cleanText(input.priority, 32);
  const status = input.status == null ? undefined : cleanText(input.status, 32);
  if (priority != null && !PRIORITIES.has(priority)) throw new Error('priority 非法');
  if (status != null && !DIRECTIVE_STATUSES.has(status)) throw new Error('directive status 非法');
  const out = {};
  if (input.title != null) out.title = title;
  if (input.body != null) out.body = body;
  if (priority != null) out.priority = priority;
  if (status != null) out.status = status;
  return out;
}

function createDirective(db, payload, username) {
  const fields = validateDirectiveInput(payload, 'create');
  const ts = nowIso();
  const row = {
    id: newId('d'),
    title: fields.title,
    body: fields.body,
    priority: fields.priority || 'medium',
    status: fields.status || 'open',
    created_by: username,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(`
    INSERT INTO directives (id, title, body, priority, status, created_by, created_at, updated_at)
    VALUES (@id, @title, @body, @priority, @status, @created_by, @created_at, @updated_at)
  `).run(row);
  return rowToDirective(db.prepare('SELECT * FROM directives WHERE id = ?').get(row.id));
}

function updateDirective(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  const fields = validateDirectiveInput(payload, 'update');
  const entries = Object.entries(fields);
  if (!entries.length) return rowToDirective(db.prepare('SELECT * FROM directives WHERE id = ?').get(id));
  entries.push(['updated_at', nowIso()]);
  const res = db.prepare(`UPDATE directives SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
  if (!res.changes) throw new Error('指示不存在');
  return rowToDirective(db.prepare('SELECT * FROM directives WHERE id = ?').get(id));
}

function deleteDirective(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  db.prepare('DELETE FROM directives WHERE id = ?').run(id);
  return { id };
}

function listScanRuns(db) {
  return db.prepare('SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT 30').all();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? decodeXml(m[1]) : '';
}

function allTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'ig');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(decodeXml(m[1]));
  return out;
}

function parseArxivEntries(xml) {
  const entries = [];
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/ig;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const idUrl = firstTag(block, 'id');
    const sourceId = (idUrl.match(/\/abs\/([^/]+)$/) || [])[1] || idUrl;
    const link = (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || [])[1] || idUrl;
    const categories = [...block.matchAll(/<category\b[^>]*term=["']([^"']+)["']/ig)].map((x) => decodeXml(x[1]));
    entries.push({
      title: firstTag(block, 'title'),
      source_url: link.replace(/^http:\/\//, 'https://'),
      source_id: sourceId.replace(/v\d+$/, ''),
      authors: allTag(block, 'name').join('; '),
      published_at: firstTag(block, 'published').slice(0, 10),
      updated_at: firstTag(block, 'updated'),
      abstract: firstTag(block, 'summary'),
      tags: categories,
    });
  }
  return entries.filter((entry) => entry.title && entry.source_url);
}

function inspirationFromEntry(entry) {
  const title = entry.title.toLowerCase();
  if (title.includes('harness') || title.includes('trace')) {
    return '候选启发: 将失败轨迹先结构化归因到工具、上下文、权限、观测或治理层, 再生成有边界的修复方案, 避免把所有失败都归咎于模型。';
  }
  if (title.includes('skill') || title.includes('tool')) {
    return '候选启发: 把 skill 与 tool 作为一个共同演化空间, 记录反模式并阻止重复犯错, 适合莫比乌斯后续的技能库和工具协议迭代。';
  }
  if (title.includes('log') || title.includes('event')) {
    return '候选启发: 把事件日志作为自我认知的事实源, 让每次自迭代都可回放、可分叉、可追踪 lineage。';
  }
  if (title.includes('gödel') || title.includes('godel') || title.includes('self-improv')) {
    return '候选启发: 关注该工作如何定义自我修改、经验验证、回滚和元规则更新, 评估它是否能转化为莫比乌斯的自迭代流程。';
  }
  return '候选启发: 这条内容由自动扫描发现, 需要人工或 agent 进一步提炼 key_inspiration、风险边界和可落地路径。';
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mobius self-cognition extension/0.1 (+https://arxiv.org/help/api)',
      },
    });
    if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function scanArxiv(db, payload, username) {
  const query = cleanText(payload.query, 600) || DEFAULT_SCAN_QUERY;
  const maxResults = clampInt(payload.max_results, 8, 1, 20);
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  const runId = newId('scan');
  const createdAt = nowIso();
  let inserted = 0;
  let skipped = 0;
  try {
    const xml = await fetchText(url);
    const entries = parseArxivEntries(xml);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO ideas (
        id, title, source_url, source_id, source_type, status, relevance,
        authors, published_at, tags, abstract, key_inspiration, mobius_use,
        limitations, auto_fetched, fetched_at, created_by, created_at, updated_at
      ) VALUES (
        @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
        @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
        @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at
      )
    `);
    const ts = nowIso();
    const tx = db.transaction(() => {
      for (const entry of entries) {
        const tags = normalizeTags(['自动扫描', '待评估', ...entry.tags]);
        const row = {
          id: stableId('arxiv', entry.source_id || entry.source_url),
          title: cleanText(entry.title, 260),
          source_url: mustUrl(entry.source_url),
          source_id: cleanText(entry.source_id, 120),
          source_type: 'scan',
          status: 'candidate',
          relevance: 3,
          authors: cleanText(entry.authors, 500),
          published_at: entry.published_at || null,
          tags: JSON.stringify(tags),
          abstract: cleanLongText(entry.abstract, 6000),
          key_inspiration: inspirationFromEntry(entry),
          mobius_use: '自动扫描候选项。下一步: 阅读原文, 把 key_inspiration 改写成对莫比乌斯具体模块、流程或插件的可执行建议。',
          limitations: '尚未人工核验, 不应直接进入自迭代实施。',
          auto_fetched: 1,
          fetched_at: ts,
          created_by: username,
          created_at: ts,
          updated_at: ts,
        };
        const res = insert.run(row);
        if (res.changes) inserted += 1;
        else skipped += 1;
      }
    });
    tx();
    db.prepare(`
      INSERT INTO scan_runs (id, query, max_results, inserted, skipped, status, error, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
    `).run(runId, query, maxResults, inserted, skipped, username, createdAt);
    return { run_id: runId, query, max_results: maxResults, inserted, skipped };
  } catch (e) {
    db.prepare(`
      INSERT INTO scan_runs (id, query, max_results, inserted, skipped, status, error, created_by, created_at)
      VALUES (?, ?, ?, 0, 0, 'error', ?, ?, ?)
    `).run(runId, query, maxResults, cleanText(e.message, 500), username, createdAt);
    throw new Error('arXiv 扫描失败: ' + cleanText(e.message, 160));
  }
}

function exportJson(db) {
  return {
    exported_at: nowIso(),
    ideas: db.prepare('SELECT * FROM ideas ORDER BY created_at DESC').all().map(rowToIdea),
    directives: listDirectives(db),
    scan_runs: listScanRuns(db),
  };
}

async function dispatch({ db, payload, username }) {
  const action = cleanText(payload.action || 'bootstrap', 64);
  switch (action) {
    case 'bootstrap': {
      const list = listIdeas(db, payload);
      return {
        ok: true,
        ...list,
        stats: stats(db),
        directives: listDirectives(db),
        scan_runs: listScanRuns(db),
        constants: {
          statuses: [...STATUSES],
          source_types: [...SOURCE_TYPES],
          default_scan_query: DEFAULT_SCAN_QUERY,
        },
      };
    }
    case 'list':
      return { ok: true, ...listIdeas(db, payload), stats: stats(db) };
    case 'get':
      return { ok: true, idea: getIdea(db, cleanText(payload.id, 120)) };
    case 'create':
      return { ok: true, idea: createIdea(db, payload, username), stats: stats(db) };
    case 'update':
      return { ok: true, idea: updateIdea(db, payload), stats: stats(db) };
    case 'delete':
      return { ok: true, removed: deleteIdea(db, payload), stats: stats(db) };
    case 'set_status':
      return { ok: true, idea: setStatus(db, payload), stats: stats(db) };
    case 'stats':
      return { ok: true, stats: stats(db) };
    case 'list_directives':
      return { ok: true, directives: listDirectives(db) };
    case 'create_directive':
      return { ok: true, directive: createDirective(db, payload, username), directives: listDirectives(db), stats: stats(db) };
    case 'update_directive':
      return { ok: true, directive: updateDirective(db, payload), directives: listDirectives(db), stats: stats(db) };
    case 'delete_directive':
      return { ok: true, removed: deleteDirective(db, payload), directives: listDirectives(db), stats: stats(db) };
    case 'scan_arxiv': {
      const result = await scanArxiv(db, payload, username);
      return {
        ok: true,
        scan: result,
        ...listIdeas(db, {}),
        stats: stats(db),
        scan_runs: listScanRuns(db),
      };
    }
    case 'list_scan_runs':
      return { ok: true, scan_runs: listScanRuns(db) };
    case 'export_json':
      return { ok: true, data: exportJson(db) };
    default:
      return { ok: false, error: '未知 action' };
  }
}

module.exports = async function ({ username, ext_main_payload, ext_data_dir, logger }) {
  let db;
  try {
    db = openDb(ext_data_dir);
    const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
    return await dispatch({ db, payload, username: username || 'unknown' });
  } catch (e) {
    if (logger && logger.error) logger.error(e && e.stack ? e.stack : String(e));
    return { ok: false, error: e.message || '处理失败' };
  } finally {
    if (db) {
      try { db.close(); } catch { /* noop */ }
    }
  }
};
