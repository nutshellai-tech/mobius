# Issue 用户收藏 + 侧栏可拖拽 设计

## 背景

两个独立但相关的 UI 改进:

1. **Issue 用户收藏置顶**: 项目级已有用户绑定的星标 (`project_user_stars`),但 issue 级只有项目级全局 `pinned` (manager 权限设置)。需要给每个用户在项目内增加自己的 issue 收藏,且不影响现有 `pinned` 语义。
2. **侧栏可拖拽调整大小**: 4 个主左栏 + 2 个次级面板目前都是固定宽度,需要支持拖拽,且带合理上下限与持久化。

## 范围

### Part 1 — Issue 用户收藏
- 新增 `issue_user_stars` 表 (issue_id + user_id)
- 后端 list / shape / 路由 / repository 全套接入
- 前端在 IssueCard / ProjectSidebar 列表项 / IssuePage 顶部 三处显示星标按钮 (所有项目读者可点)
- ProjectPage 排序: 我的收藏 → 管理员 pinned → 最近活跃
- 保留现有 `pinned` 字段不动 (manager 全局置顶)

### Part 2 — 可拖拽侧栏
6 处面板:

| 面板 | 位置 | 默认 | 最小 | 最大 |
|---|---|---|---|---|
| UserPage 项目列表 | 主左栏 | 288px (w-72) | 200px | 480px |
| ProjectPage Issue 列表 | 主左栏 | 288px | 200px | 480px |
| IssuePage Session 列表 | 主左栏 | 288px | 200px | 480px |
| ResearchPage | 主左栏 | 288px | 200px | 480px |
| UserPage 个人 Skill 栏 | 主区右侧 | 340px | 260px | 520px |
| AssistantChat 会话列表 | 浮窗内左栏 | 176px | 140px | 280px |

## 设计

### Part 1: Issue 用户收藏

#### 数据库

新表 `issue_user_stars` (schema.sql):

```sql
CREATE TABLE IF NOT EXISTS issue_user_stars (
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_user_stars_user ON issue_user_stars(user_id);
```

幂等迁移由 `mobius/db.js` 在启动时执行 (与 `project_user_stars` 同模式)。

#### 后端

**`mobius/backend/repositories/issues.js`:**
- `Issues.listForProject(projectId, statusFilter, userId)` 增加可选 `userId` 参数,LEFT JOIN `issue_user_stars` 计算 `starred` 字段 (0/1)
- 新增 `Issues.setStarred(issueId, userId, starred)` — INSERT / DELETE 风格同 `Projects.setStarred`
- `Issues.findById` 不动 (单条查询走 shape 时另外处理)

**`mobius/backend/routes/issues.js`:**
- `shapeIssueForUser` 不变 (issue row 上已带 `starred` 字段,直接 spread)
- `GET /api/projects/:projectId/issues` 路由把 `req.user.id` 传给 `listForProject`
- 新增 `PATCH /api/issues/:id/star`:
  - 仅需 `canReadIssue` (读者即可收藏自己的; manager 权限不要求)
  - body `{ starred: boolean }`
  - 返回 `shapeIssueForUser(Issues.findById(id))` (确保 starred 字段返回 — findById 也要 LEFT JOIN user_id)
- `Issues.findById(id, userId)` 增加 `userId` 可选参数,LEFT JOIN 返回 `starred`
- `GET /api/issues/:id` 路由传 `req.user.id`

#### 前端

**`ProjectPage.tsx` 排序逻辑** (line 209):
```ts
return [...arr].sort((a, b) => {
  const s = Number(!!b.starred) - Number(!!a.starred)
  if (s) return s
  return Number(!!b.pinned) - Number(!!a.pinned)
})
```
- 我的收藏优先,然后是管理员 pinned,然后保持原 last_active 顺序 (上一步已按 last_active 排)。
- Researches 排序暂不动 (research 表无 user stars 表,超出范围)。

**`IssueCard.tsx`:**
- 新增金色星标按钮 (所有用户可见,不止 canManage),位置放在现有管理按钮组的最左侧
- 点击调用 `PATCH /api/issues/:id/star` body `{ starred: !issue.starred }`
- 现有 pinned 按钮保留在管理组内 (canManage 可见)
- 卡片标题左侧的 `!!issue.pinned` 黄星图标 → 改成 `!!issue.starred || !!issue.pinned` 都显示,但视觉上区分 (starred 实心 + 轮廓, pinned 仅描边 — 或保持简单, 都用一个星)
- 删除原 "pin/unpin" 的小黄色置顶图标在标题左侧的显示 (避免与收藏冲突), 改成: starred 时显示星,pinned 时显示锁定/图钉 (待定 — 简化方案: starred 用星图标显示在标题左侧, pinned 通过 tab 上的 small dot 表示)

**`ProjectSidebar.tsx` 列表项:**
- 每个 issue 行加一个 hover 显示的星标 toggle (类似 IssueCard)
- 已 starred 的 issue 持续显示星
- 现有 `!!iss.pinned` 星图标逻辑保留

**`IssuePage.tsx` 顶部元数据:**
- 标题旁加一个星标 toggle

**类型:**
- `issue.starred: boolean` 已由后端 shape 注入,前端无需新类型

### Part 2: 可拖拽侧栏

#### 通用工具

**`mobius/frontend/src/components/resizable-panel.tsx`** — 新组件:

```tsx
type ResizablePanelProps = {
  storageKey: string         // localStorage key
  defaultWidth: number
  minWidth: number
  maxWidth: number
  side: 'left' | 'right'     // 拖拽手柄放哪一侧
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
  'data-tour'?: string
}
```

行为:
- 内部用 `useState` 持 width,初始值从 `localStorage.getItem(storageKey)` 读取 (fallback 到 defaultWidth),读取时 clamp 到 [minWidth, maxWidth]
- 渲染 `<aside style={{width}}>` + 拖拽手柄 `<div className="resize-handle">` 绝对定位在 side 那一侧
- `onMouseDown` 进入拖拽:document 上挂 `mousemove` / `mouseup` listener,计算 newWidth = e.clientX - rect.left (左栏) 或 rect.right - e.clientX (右栏),clamp 后 setState 并 debounce 写 localStorage (50ms)
- 拖拽中给 body 加 `cursor: col-resize` + `user-select: none`
- 双击手柄 reset 到 defaultWidth
- 手柄 CSS: 2px 宽贴边, hover 时变 4px 蓝色

#### 接入

每个面板把现有 `<aside className="w-72 ...">` 替换为 `<ResizablePanel storageKey="..." defaultWidth={288} minWidth={200} maxWidth={480} side="left" className="border-r flex flex-col" style={...}>`。

storageKey 一览:
- `mobius:ui:sidebar:user-projects` — UserPage 项目列表
- `mobius:ui:sidebar:project-issues` — ProjectPage Issue 列表
- `mobius:ui:sidebar:issue-sessions` — IssuePage Session 列表
- `mobius:ui:sidebar:research` — ResearchPage
- `mobius:ui:sidebar:user-skills` — UserPage 右侧 Skill 栏 (side='right', default=340, min=260, max=520)
- `mobius:ui:sidebar:assistant-sessions` — AssistantChat 会话列表 (side='left', default=176, min=140, max=280)

注意:
- ProjectSidebar 组件目前自己渲染 `<aside>`,需要把 aside 提到 ProjectPage 中 (或给 ProjectSidebar 传一个 `renderAsResizable` 选项) — 选简单方案: ProjectSidebar 改成不再渲染 `<aside>`, 只渲染内容, 由 ProjectPage 用 ResizablePanel 包裹它
- AssistantChat 的 `.assistant-session-sidebar` CSS 写死了 `width: 176px; min-width: 176px`,需要改 CSS 让外部 inline style 接管 (去掉 width / min-width, 保留 flex direction 等)
- collapsed 状态 (--collapsed 类) 不受影响,仍走原本 50px 路径

#### 持久化

localStorage 全局持久化 (不绑定用户),key 如上。理由:不同用户偏好通常一致;绑定用户会让每次切换用户都 reset。

## 测试

- 后端: `curl` 跑 PATCH /star 流程,确认 INSERT/DELETE 正确
- 前端:
  - 手动测试每个面板的拖拽,确认上下限 clamp 正确
  - 切换页面再回来,确认宽度恢复
  - 双击 reset 正常
  - AssistantChat collapsed 状态不与 resizable 冲突

## 风险与边界

- `Issues.findById(id, userId)` 改签名: 所有调用点需要扫一遍,不传 userId 的地方 starred 字段会缺失 (走默认 0)。可接受 — shapeIssueForUser 会保留这一行为
- 现有 `pinned` 字段的 UI 显示与新增 starred 视觉上要区分,否则用户混淆
- AssistantChat 的 resizable 改动会触及现有 collapsed 逻辑,需要谨慎
- localStorage 在 SSR / 隐私模式下不可用,需要 try/catch
