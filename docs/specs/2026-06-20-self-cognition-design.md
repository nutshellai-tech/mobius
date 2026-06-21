# 莫比乌斯的自我认知与迭代 — 设计文档

**日期**: 2026-06-20
**作者**: 扈天翼 + Mobius 协作
**状态**: Implemented v0.1（2026-06-21 已落地插件）

---

## 1. 背景与动机

莫比乌斯已有自迭代骨架（issue → session → `mobius-self-iter` skill → commit → `python3 start.py`），但是一个**"半人工 + 单线 + 无 fitness 闭环 + 元规则固定"**的循环：用户提 issue，agent 改代码，没有沉淀"我从外部学到了什么"。

调研哥德尔智能体（[arXiv 2410.04444](https://arxiv.org/abs/2410.04444)）及后续工作（Darwin Gödel Machine [2505.22954](https://arxiv.org/abs/2505.22954)、Huxley-Gödel Machine [2510.21614](https://arxiv.org/abs/2510.21614)、Polaris ICLR'26 RSI Workshop）后，识别出对莫比乌斯最有价值的三件事：

1. **经验抽象与复用**（Polaris）— 把每次外部调研到的"启发"沉淀成可检索条目
2. **`key_inspiration` 字段**（本设计的核心差异点）— 不只存论文摘要，更要存"这条内容能教莫比乌斯什么"
3. **自动抓取接口 MVP**（Darwin Gödel Machine）— 已提供 `scan_arxiv` 动作, 先把候选论文入库为待评估启发

本扩展就是承载这三件事的"启发库"。本期目标是**把"人工录入 + 存储 + 展示 + arXiv 候选扫描"做透**，反向作用到莫比乌斯本体是后续阶段。

---

## 2. 目标与非目标

### 目标（本期）
- 用户（人 / 莫比乌斯 agent）能在网页里**新增 / 编辑 / 删除**一条"启发"记录
- 每条记录的核心字段是 `key_inspiration`（这条内容能教莫比乌斯什么）
- 能按 `tags` / `status` / `source_type` 筛选与检索
- 表结构为自动抓取预留字段，并实现 arXiv 扫描 MVP
- 兼容开发人员指示, 支持记录优先级和状态
- UI 风格采用苹果设计语言（参考 `apple-product-page` skill）

### 非目标（本期不做，明确留口）
- 不做 cron / 定时抓取
- 不做 web search 调用
- 不做"自动生成 issue 推动莫比乌斯自迭代"的反向闭环
- 不做多用户协作 / 评论 / 评分系统

---

## 3. 架构

### 3.1 目录结构

```
mobius/extension/self-cognition/
├── extension.json
├── backend/
│   └── extension_backend_handler.js     # stateless handler 入口, SQLite + arXiv scan
└── frontend/
    ├── index.html                       # 入口，零编译，原生 ESM
    ├── styles.css
    ├── favicon.svg
    └── main.js                          # 应用入口, extCall + view/state
```

### 3.2 数据落盘

严格遵循协议：所有 IO 限制在 `ext_data_dir` 下。

- DB 文件：`APP_DIR/protected_data/extension/self-cognition/self-cognition.db`
- Handler 日志：`APP_DIR/protected_data/extension/self-cognition/_handler.log`
- 构建（零编译模式不需要，但 fallback 日志位置同上）

### 3.3 通信

- 前端 → 后端：只用 SDK，`import { extCall } from '/extension/_sdk/ext.js'`
- 后端：CommonJS handler，每次新 worker_thread，30s 内返回
- 每次调用结束关闭 DB 连接，严格 stateless

---

## 4. 数据模型

### 4.1 表结构（SQLite）

```sql
CREATE TABLE ideas (
  id              TEXT PRIMARY KEY,          -- 'i_' + 12 hex
  title           TEXT NOT NULL,
  source_url      TEXT NOT NULL,             -- 必填，arxiv/博客/评论 URL
  key_inspiration TEXT NOT NULL,             -- 核心字段：教莫比乌斯什么
  tags            TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  authors         TEXT NOT NULL DEFAULT '',
  published_at    TEXT,                       -- ISO date, nullable
  abstract        TEXT NOT NULL DEFAULT '',
  source_type     TEXT NOT NULL DEFAULT 'paper',  -- paper|framework|method|note|scan
  relevance       INTEGER NOT NULL DEFAULT 3,     -- 1-5
  status          TEXT NOT NULL DEFAULT 'new',    -- new|candidate|triaged|planned|applied|archived
  source_id       TEXT,                       -- arxiv_id 等
  auto_fetched    INTEGER NOT NULL DEFAULT 0,
  fetched_at      TEXT,
  -- 元数据
  created_by      TEXT NOT NULL,              -- username
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_ideas_status ON ideas(status);
CREATE INDEX idx_ideas_source_type ON ideas(source_type);
CREATE INDEX idx_ideas_created_at ON ideas(created_at DESC);
```

另有两张表:

```sql
CREATE TABLE directives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_runs (
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
```

### 4.2 字段决策与理由

| 字段 | 决策 | 理由 |
|---|---|---|
| `key_inspiration` | **核心必填** | 与 arxiv 订阅器的本质区别——订阅器存"论文是什么"，本库存"对莫比乌斯有什么用" |
| `tags` (JSON 数组) | 必填默认空 | 轻量分类，无需独立 tags 表 |
| `status` 六态机 | 含 `candidate` / `planned` / `applied` | 标记从扫描候选到已落地的状态，是后续反向闭环的关键钩子 |
| `relevance` 1–5 | 默认 3 | 用户主观评分，便于排序 |
| `source_id` / `auto_fetched` / `fetched_at` | `scan_arxiv` 会写 | 为 Darwin Godel Machine 风格的自动抓取留接口 |
| `created_by` | 必填 | 区分人工录入 vs 未来 agent 自动录入 |

---

## 5. 后端 Actions

handler 按如下 action 分发：

| Action | 入参 | 返回 | 说明 |
|---|---|---|---|
| `bootstrap` | `tags?`, `status?`, `source_type?`, `q?` | `{ ok, ideas[], total, stats, directives, scan_runs }` | 前端首屏 |
| `list` | `tags?`, `status?`, `source_type?`, `q?`, `limit?`, `offset?` | `{ ok, ideas[], total }` | 支持多条件筛选 + 全文 LIKE |
| `get` | `id` | `{ ok, idea }` | 单条详情 |
| `create` | `title, source_url, key_inspiration, tags?, ...` | `{ ok, idea }` | 新增，服务端填 id/ts/created_by |
| `update` | `id, ...fields` | `{ ok, idea }` | 编辑，自动刷 updated_at |
| `delete` | `id` | `{ ok }` | 硬删 |
| `set_status` | `id, status` | `{ ok, idea }` | 状态快捷切换（列表页 inline 用） |
| `stats` | — | `{ ok, by_status, by_source_type, by_tag, total }` | 顶部看板 |
| `scan_arxiv` | `query`, `max_results?` | `{ ok, scan, ideas, stats, scan_runs }` | arXiv 候选扫描 MVP, 新条目标为 `candidate` |
| `create_directive` / `update_directive` / `delete_directive` / `list_directives` | 指示字段 | `{ ok, directives }` | 开发者指示 |
| `export_json` | — | `{ ok, data }` | 导出当前研究库快照 |

### 5.1 输入校验

- `title` / `source_url` / `key_inspiration` 非空，截断到 500 / 2000 / 5000 字
- `source_url` 必须以 `http://` 或 `https://` 开头
- `tags` 数组单项 ≤ 32 字符，最多 10 个
- `source_type` ∈ {paper, framework, method, note, scan}
- `status` ∈ {new, candidate, triaged, planned, applied, archived}
- `relevance` ∈ [1, 5]
- 一律不信任 `ext_main_payload`，所有字段 type + 边界校验

### 5.2 错误处理

- 任何校验失败返回 `{ ok: false, error: '<简短中文>' }`，**不回显 stack trace**
- DB 异常通过 `logger.error` 落盘，对外只返回 `{ ok:false, error:'db error' }`

---

## 6. 前端设计

### 6.1 布局（B1：双栏 + 工作区 tabs）

```
┌──────────────────────────────────────────────────────────┐
│  莫比乌斯的自我认知和迭代                                  │
│  [研究库] [借鉴路径] [网络扫描] [开发者指示]  [+ 新增]     │
├─────────────────────┬────────────────────────────────────┤
│                     │  详情区                              │
│  列表                │                                     │
│  ┌─────────────┐    │  标题                                │
│  │ 条目 A       │    │  作者 / 发布时间 / 类型 / 相关度     │
│  │ 标签 状态    │    │                                     │
│  ├─────────────┤    │  ─── 关键启发 ───                    │
│  │ 条目 B       │    │  <key_inspiration 内容>             │
│  │ ...         │    │                                     │
│  └─────────────┘    │  ─── 摘要 ───                        │
│                     │  <abstract>                          │
│                     │                                     │
│                     │  [原文链接]  [编辑]  [状态切换]       │
└─────────────────────┴────────────────────────────────────┘
```

- 列表项：标题 + 标签 chip + 状态 badge + 相关度小图标
- 详情区：滚动容器，强调 `key_inspiration`（视觉权重最高，比摘要大、加重点色边框）
- 新增/编辑：modal 形式，必填字段高亮
- 空状态：友好引导文案 + "新增第一条启发"按钮

### 6.2 视觉风格

调用 `apple-product-page` skill 提供：
- 字体：SF Pro Display / -apple-system / PingFang SC
- 配色：克制的中性色（#f5f5f7 背景，#1d1d1f 文字），状态/标签用淡彩
- 留白：列表项 padding 16/20，section 间距 32
- 圆角：8/12
- 动效：列表项 hover 微提升、modal 淡入淡出、状态切换 200ms

### 6.3 状态管理

零依赖，自写极简 store：单例状态 + subscribe 模式，够用即可。不引 React/Vue。

### 6.4 零编译策略

- 不写 `package.json`
- `frontend/index.html` 直接 `<script type="module" src="main.js">`
- 浏览器原生 ESM，当前实现为单文件前端入口
- 首次访问由后端把 `frontend/*` 拷到 `dist/`
- 改完调 `POST /api/admin/extensions/self-cognition/rebuild`

---

## 7. 实现路径

按依赖关系排序：

1. `extension.json` + 目录骨架：已完成
2. `backend/extension_backend_handler.js`（建表 + seed + action + arXiv scan）：已完成
3. `frontend/index.html` + `main.js` + `styles.css`：已完成
4. 后端验证：直接调用 handler + 临时 DB
5. `POST /api/admin/extensions/reload` 或 `python3 start.py` 后在 Mobius UI 打开扩展 tab
6. `commit` + `python3 start.py`，删除 running.flag

---

## 8. 测试与验收

由于本期无自动化测试基建，采用**手动验收清单**：

- [x] DB 表自动创建（handler 启动）
- [x] seed 数据自动注入
- [x] `create` 写入 + `get` 读出字段一致
- [x] `list` 多条件筛选与分页正确
- [x] `update` / `set_status` / `delete` 行为正确
- [x] 输入校验：非法 URL / 非法 status 拒绝
- [x] `scan_arxiv` 可拉取候选论文并去重入库
- [x] 前端列表 → 详情 → 编辑闭环具备完整 UI
- [x] 视觉验收：克制、留白、字体、动效
- [x] 用真实记录（哥德尔智能体调研）作为 seed 数据

---

## 9. 风险与边界

| 风险 | 缓解 |
|---|---|
| 前端零编译模式兼容性 | 仅支持现代浏览器（Chrome 89+ / Safari 15+），与 pacman/arxiv 一致 |
| `key_inspiration` 用户填得敷衍 | UI 用占位提示+视觉强调；后续可由 agent 自动生成 |
| `scan_arxiv` 过度抓取 | 限制单次 1-20 条, 默认 8 条, 不设定时任务 |
| DB schema 演化 | 本期无 migration 需求；后续加字段用 `CREATE TABLE IF NOT EXISTS` + ALTER 兜底 |
| handler 超时（30s） | 当前 action 都是本地 SQLite 操作，远低于 30s |

---

## 10. 后续阶段（非本期）

明确记录，避免设计漂移：

- **Phase 2 — 自动抓取增强**：复用 `arxiv` 扩展的 scheduler 模式，按"莫比乌斯相关主题"订阅论文/博客
- **Phase 3 — 经验抽象**：抓取后用 LLM 自动生成 `key_inspiration`（Polaris 风格）
- **Phase 4 — 反向闭环**：`status=triaged` 的条目定期生成候选 issue 推到自迭代项目，`applied` 状态由 issue 完成后回写
- **Phase 5 — lineage 评估**（Huxley）：记录"哪条启发最终被莫比乌斯落地，效果如何"

---

## 11. 开放问题（用户 review 时可一并答复）

1. 字段集是否要增减？（默认接受当前提案）
2. `auto_fetch` 占位是否要直接在 UI 上显示"敬请期待"按钮，还是完全隐藏？（默认：隐藏）
3. 列表默认排序：按 `created_at DESC` 还是 `relevance DESC`？（默认：created_at DESC）
4. 是否需要导出 JSON 功能？（默认：本期不做，留口）
