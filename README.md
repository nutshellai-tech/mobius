# Mobius AI System

**GLM-5.2 × Mobius — 当前最强开源编程模型，搭配完整 Agent 工作台**

GLM-5.2（Code Arena 全球可用第一 · SWE-Bench Pro 62.1% · 1M Token 真实上下文）是目前最接近 Claude Opus 的开源 Coding 模型。  
Mobius 是第一个通过 Z.AI 兼容接口，让 GLM-5.2 完整驱动 Agent Session 的 Web 工作台——无需 Anthropic 账号，一个 Key，即可在 Project / Issue / Session 闭环中运行媲美 Opus 的编程 Agent。

---

莫比乌斯AI 是一个面向真实项目协作的自进化 Agent 工作台。系统把项目、任务、执行会话和上下文管理放在同一个 Web 应用里，让用户可以直接在平台中提出需求、创建 Issue、启动 Session，并让 Agent 在绑定目录里完成实现、验证和汇报。

## 你能用它做什么

**一人公司 / 独立开发者提效**

一个人，多条线同时推进。用小莫助理自然语言接收需求，自动拆解为项目和任务；多个 Agent Session 在各自独立的工作区里并行执行，你只在关键节点确认启动和验收结果。通过 aimux 远程算力，Agent 可在你的本地机器上运行，无需全程盯屏幕。

**快速开发软件产品，带完整可视化界面**

从需求描述到可运行产品，全程在 Web 界面里完成。平台内置了多个利用 Mobius 自身迭代开发的现成产品示例，包括 PPT 生成器、财经新闻墙、JSON 可视化工具、3D 物理仿真等，可直接作为起点二次开发或参考。Extension 系统允许你在不改动主代码的情况下，快速上线一个带 UI 和后端逻辑的独立应用。

**多 Agent 协作调研**

启用 Research 模式后，可组建 Agent 团队：一名主研究员统筹规划，多名助手并行执行子课题，通过共享黑板异步协作，结果自动汇总到可视化研究图谱。适合技术选型、竞品分析、论文梳理等需要多方信息汇聚的场景。

## 容器中安装和运行（推荐）

- Git clone with command:
   - `git clone https://github.com/nutshellai-tech/mobius.git && cd mobius`
- Edit Configuration:
   - `python3 conf_prepare.py --docker && python3 conf_check.py --docker`
- Build image (stage 1: environment only without code + stage 2: copy code into image):
   - `docker build -t imac-mobius-base:latest -f deploy/Dockerfile . && docker build -t imac-mobius-exe:latest .`
- Run image:
   - `docker compose up`



## 核心工作流

Mobius 的基础结构是 `Project -> Issue -> Session`。

- `Project` 是工作空间和上下文容器，绑定到一个代码目录，也承载项目级 Memory、Skill、Research 设置和上下文白名单。
- `Issue` 是明确的任务单元，用来描述目标、范围、约束和验收标准。
- `Session` 是一次真实 Agent 执行，会固定模型、语言、Skill/Memory 快照、初始指令和运行日志。

新建 Session 时，系统会把当前 Issue、项目上下文、用户选择的 Skill 和 Memory 固化为快照。之后全局 Memory 或 Skill 变化，不会影响已经创建的 Session。

## 当前能力

1. 自举自迭代

   莫比乌斯可以通过自身的 Project / Issue / Session 流程修改自己。用户不需要离开 Web UI 单独写代码；提出任务、确认 Session 执行、等待 Agent 完成后，即可在同一个系统里继续验收和迭代。

2. Agent 执行与状态管理

   后端通过 tmux 系列 Agent backend 托管 Codex / Claude Code 等模型执行。Session 会记录消息、状态、运行标记、完成结果和失败信息。系统还保留了“鞭策”机制，用于发现长时间停滞或疑似偷懒的 Agent 并推动进展。

3. Memory 和 Skill 控制

   `Memory` 用于保存高频、环境相关、私有或易变化的信息，例如项目启动方式、部署注意事项、SSH Host、内部服务地址、账号引用、API key 存放位置等。

   `Skill` 用于保存稳定、可复用的 Agent 技艺，例如 Playwright 调试、图像生成技巧、Mobius 扩展开发规范、Research 图谱生成方法等。

   用户级上下文可以通过项目白名单控制是否进入某个 Project；项目级 Memory 和 Skill 则默认服务该项目。

4. Research 系统

   Project 可以启用 Research 入口。Research 与 Issue 并列管理，适合多阶段调研、资料汇总、研究图谱、Chief Researcher / Research Assistant 分工等场景。启用 Research 时，项目默认不使用 Issue worktree。

5. 扩展项目和特殊应用

   已安装扩展可以在项目页表现为特殊拓展项目。扩展应用的前端位于 `mobius/extension/<extension_name>/frontend`，后端能力通过 Mobius backend 的 `/ext` 统一转发和隔离执行。扩展数据放在 `${CORE_DATA_PATH}/extension/<extension_name>` 下。

## 小莫助理

小莫是全局挂载的浮动项目助理。它不是普通 Project 或 Issue，而是每个用户一个用户级 Agent Session。

首次打开小莫时，用户需要配置小莫使用的模型、Skill 和 Memory。配置完成后，后续所有小莫对话都会进入同一个持久小莫 Agent Session，前端会定时刷新小莫消息和状态。

小莫当前具备这些能力：

- 理解当前页面状态，包括当前路由、当前 Project、当前 Issue、当前 Session，以及页面上可见的项目、Issue、Session。
- 搜索用户可见 Project 和 Issue。
- 在确认信息充分后创建 Project、Issue 和 Session。
- 对含糊请求先给出 2-4 个可点击候选方案，而不是直接猜测执行。
- 通过引导选项帮助用户选择新建项目模式、Issue 类型和 Session 执行方式。
- 创建成功后返回可跳转操作卡片，并刷新前端项目、Issue、Session 列表。
- 支持“自塑”模式：用户描述想改进小莫或 Mobius 的问题后，小莫会在固定自进化项目中创建对应 Issue 和 Session，等待用户打开并确认执行。

小莫仍然遵循一个重要边界：它可以创建 Session，但不会自动启动业务 Agent。执行前仍需要用户进入 Session 并确认启动。

## 引导系统

引导系统基于 Driver.js 和稳定的 `data-tour` 标记实现。前端会根据当前路由、可见弹窗和本地 Demo 状态，把完整流程拆成多个分段引导，跨页面继续运行。

当前代码中已经具备三条具体引导路线的状态模型、表单预填和 Driver.js 分段逻辑：

1. 生日邀请页 Demo

   首次登录默认触发。它带用户完成 Project、Issue、Session 的最小闭环：创建一个静态生日邀请页项目，创建“制作一个静态生日邀请页” Issue，创建“生成生日邀请页文件” Session，并引导用户在确认窗中启动执行，最后清理演示项目。

2. 导入已有项目 Demo

   演示如何把已有代码放进 Mobius 项目。案例使用公开 TodoMVC 仓库，说明两种导入方式：通过 VSCode Web 拖拽上传本地文件，或创建带 Git 地址和约束的 Issue，再让 Agent 在 Session 中执行下载和整理。

3. Memory / Skill / 远程算力配置 Demo

   演示项目级上下文配置。它带用户理解 Memory 与 Skill 的区别，查看用户级上下文白名单，添加项目 Memory，打开 aimux 远程算力授权入口，并创建一个上下文检查 Session 来验证 Skill/Memory 快照。

引导状态保存在浏览器 localStorage 中。关闭、完成或删除演示项目会结束对应 Demo 状态。浅色模式保持 Driver.js 基础高亮效果；深色和紫色模式只添加一条轻量描边，避免过重视觉干扰。

需要注意的是，截至当前代码状态，生日邀请页 Demo 已经通过首次登录流程自动触发；导入已有项目 Demo 和上下文配置 Demo 的启动函数与事件监听已经存在，但显式 UI 入口尚未接到小莫面板或导航按钮上。

## 主要代码位置

- 小莫前端面板：`mobius/frontend/src/components/assistant-chat.tsx`
- 小莫后端接口：`mobius/backend/routes/assistant.js`
- 引导控制器：`mobius/frontend/src/components/tour-controller.tsx`
- Driver.js 分段逻辑：`mobius/frontend/src/services/tour.ts`
- 通用引导 Demo 状态：`mobius/frontend/src/services/guided-demo.ts`
- 生日 Demo 状态：`mobius/frontend/src/services/birthday-demo.ts`
- 导入项目 Demo 状态：`mobius/frontend/src/services/project-import-demo.ts`
- 上下文配置 Demo 状态：`mobius/frontend/src/services/context-setup-demo.ts`
- Project / Issue / Session 表单预填：`mobius/frontend/src/components/modals.tsx`
- Session 完成推进引导：`mobius/frontend/src/pages/IssuePage.tsx`

## 本地开发

常用开发启动方式：

```bash
python3 start.py --detach
```

**首次启动前**，需要先初始化默认用户（对应 `.env` / `.env.default` 中的 `IMAC_BOOTSTRAP_USERS`）：

```bash
cd mobius
IMAC_BOOTSTRAP_USERS="admin:admin:admin:admin" \
  DB_PATH=<your_local_data>/mobius.db \
  WORKSPACE_ROOT=<your_local_data>/workspace \
  node scripts/bootstrap-users.js
```

> 该步骤在容器部署时由 `docker-entrypoint.sh` 自动执行；本地开发需手动运行一次。`IMAC_BOOTSTRAP_USERS` 格式为 `id:password:role:display_name`，多个用户用 `;` 分隔。

调试服务默认监听：

- 后端：`http://localhost:45614`
- 前端：`http://localhost:45616`
- code-server：`http://localhost:45617`

前端构建：

```bash
cd mobius/frontend
npm run build
```

后端语法检查示例：

```bash
node -c mobius/backend/routes/assistant.js
```

生产模式重启：

```bash
python3 start.py
```

## 部署

从 GitLab 拉取代码时，使用已授权账号或部署环境中配置好的凭据，不建议把密码直接写进命令或文档。

首次部署示例：

```bash
git clone -b agent_smart_dev <gitlab-imac-repo-url> imac
cd imac
cp .env.default deploy/.env
cd deploy
podman compose build
podman compose up
```

更新部署示例：

```bash
cd imac
git pull
cp .env.default deploy/.env
cd deploy
podman compose build
podman compose down
podman compose up
```

## 当前调研结论

截至 2026-06-08，本项目介绍总文档需要更新，原因是现有 README 只覆盖了早期自举、鞭策、Memory/Skill 和部署片段，没有反映以下最新实现：

- 小莫已经升级为用户级持久 Agent Session，并支持模型、Skill、Memory 配置。
- 小莫前端会发送当前页面状态，后端会基于页面状态和工具调用执行搜索、创建和澄清。
- 小莫已经支持自塑入口，能在自进化项目中创建 Issue 和 Session。
- 引导系统已经从单一生日 Demo 扩展出三条路线的代码骨架和分段逻辑：生日邀请页、导入已有项目、上下文配置。
- 引导系统已经支持跨路由/弹窗分段、表单预填、上下文快照说明、Session 完成状态推进和演示项目清理。
- 当前只有生日邀请页 Demo 有首次登录自动入口；导入已有项目和上下文配置 Demo 还需要补显式启动入口。
- 项目总能力还包括 Research、扩展项目和特殊应用，这些能力也应在总介绍中被记录。
