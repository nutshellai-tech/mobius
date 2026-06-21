const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_FILE = 'self-cognition.db';
const MAX_LIMIT = 200;
const DEFAULT_SCAN_QUERY = 'all:"Gödel Agent" OR all:"self-improving agents" OR all:"recursive self-improvement"';
const SEED_VERSION = 2;
const PRODUCT_RESEARCH_VERSION = 1;

const SOURCE_TYPES = new Set(['paper', 'framework', 'method', 'note', 'scan']);
const STATUSES = new Set(['new', 'candidate', 'triaged', 'planned', 'applied', 'archived']);
const DIRECTIVE_STATUSES = new Set(['open', 'planned', 'done', 'archived']);
const PRIORITIES = new Set(['low', 'medium', 'high']);
const PRODUCT_CATEGORIES = new Set(['office-agent', 'coding-agent', 'general-agent', 'workflow-agent', 'personal-agent', 'research-agent', 'other']);

function paragraphs(...items) {
  return items.filter(Boolean).join('\n\n');
}

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
    key_inspiration: paragraphs(
      '启发一: 哥德尔机最值得借鉴的不是“让系统随便改自己”, 而是把“为什么要改”提升成第一等对象。对莫比乌斯来说, 任何自我迭代都应该显式说明: 当前系统哪里不够好、这次改动改变了哪个行为边界、怎样判断它比旧版本更好、失败时如何回滚。',
      '启发二: 理论上的全局证明很难落地, 但可以工程化降级成“证据包”。例如莫比乌斯要改插件权限模型, 不能只提交代码; 还应附带权限矩阵、攻击面说明、最小测试、人工确认点和回滚命令。这样虽然不是数学证明, 但能把信任问题拆成可检查证据。',
      '莫比乌斯例子: 当一个研究条目建议“自动把高价值启发转成 issue”时, 系统不能直接创建并执行自改任务。它应先生成一份 proof-like proposal: 候选 issue 内容、预期收益、涉及文件、需要的用户权限、禁止执行的动作、验证命令。用户看不完论文, 但可以看这个浓缩证据包。'
    ),
    mobius_use: paragraphs(
      '建立“改动证明包”字段: idea -> proposal -> patch 每一层都保留目标、影响面、证据、回滚策略。',
      '短期用测试、日志、人工 review 和灰度环境替代理论证明; 长期再接入更强规格检查和权限证明。',
      '可以先在本插件里给每条启发增加“可信证据/可疑点/可验证问题”, 后续 AI 追问时优先围绕这些问题展开。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: Gödel Agent 的核心是把策略 π 和改进规则 I 同时纳入更新。莫比乌斯现在已经有“issue -> session -> commit -> start.py”的链路, 但这个链路本身也应该被观察和改进: 谁来提出 issue、如何挑选测试、何时回滚、什么时候需要用户介入, 都是 I 的一部分。',
      '启发二: 自我认知不等于写一段自我介绍, 而是让系统能读到自己的行为逻辑和迭代记录。莫比乌斯可以把插件、skills、项目知识、会话日志、commit、验证结果组织成“我如何工作”的可查询对象。用户追问“你为什么建议这么改”时, AI 应能回到这些证据。',
      '莫比乌斯例子: 如果某次自迭代失败是因为测试覆盖不足, 下一轮不只应该修 bug, 还应修改 I: 例如以后凡是改扩展 handler, 必须跑 handler 直接调用测试、真实 /api/ext 测试、零编译 build-status 测试。这样系统不是只学会一个 bug, 而是学会一种更稳的改法。'
    ),
    mobius_use: paragraphs(
      '把本插件定位为元规则草稿箱: 每条研究不只写摘要, 必须写“对 Mobius 的流程改造点”。',
      '后续可把高相关条目转为自迭代 issue, 但在执行前经过 AI 追问、证据核查和用户授权。',
      '把自迭代规则 I 版本化: 例如测试策略、回滚策略、上下文收集策略、提交规范都应能追踪版本。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: DGM 的 archive 思想非常适合莫比乌斯。不要把每次自迭代看成“当前版本到下一个版本”的单线过程, 而要保存候选分支、失败分支和被放弃的方案。失败不是垃圾, 它是未来避免重复试错的反例库。',
      '启发二: 开放式探索的价值在于多样性。莫比乌斯不应该只收录论文启发, 还应该收录市场产品、开发者指示、用户困惑、失败日志、竞品做法。比如 WorkBuddy 的“办公交付”、Devin 的“工程任务闭环”、OpenClaw 的“聊天入口”都可能成为不同分支的 stepping stone。',
      '莫比乌斯例子: 同一个目标“让莫比乌斯能自主发现新 idea”, 可以有多个分支: arXiv 扫描分支、相似产品扫描分支、用户会话反思分支、失败日志挖掘分支。DGM 风格会保留这些分支的效果, 而不是早早押注唯一方案。'
    ),
    mobius_use: paragraphs(
      '为后续自迭代增加 lineage: idea -> issue -> session -> patch -> test -> outcome。',
      '把 status=applied 的条目作为 lineage 根节点, 记录它实际改变了哪个模块、通过了哪些验证、带来了什么副作用。',
      '把失败方案也入库: 失败原因、触发条件、以后遇到类似问题时禁止重复的做法。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: Polaris 的经验抽象适合解决“用户不信任 AI 结论”的问题。用户不需要立刻相信 AI 对论文的完整解读, 但可以要求 AI 把失败或证据抽象成短小、可复核、可复用的策略。例如“扩展 handler 不能持有顶层状态”就是一种经验抽象。',
      '启发二: 最小补丁比宏大重构更容易建立信任。莫比乌斯要把论文启发落地时, 不应直接改一堆核心架构; 可以先做一个插件内 MVP、一个只读证据面板、一个测试服开关。等用户验证有价值, 再扩大权限。',
      '莫比乌斯例子: 如果 AI 追问功能要上线, Polaris 式落地不是先让 AI 直接改 Mobius, 而是先做“追问 -> 生成证据答复 -> 生成待确认 proposal”。只有用户按下授权, 才进入真正代码变更链路。'
    ),
    mobius_use: paragraphs(
      '在自迭代 Session 结束时沉淀三类资产: failure_pattern、repair_rule、minimal_patch。',
      '本插件先承载人工整理的 experience abstraction; 后续可让 agent 自动从 session log 生成。',
      '每个启发落地前优先生成最小补丁路径: 插件内验证、测试服验证、核心架构改造三档。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: HGM 强调“当前表现”和“后续自我改进潜力”不是一回事。某个 patch 可能让当前 bug 过了, 但让系统更难维护; 另一个 patch 当前收益小, 但增加了日志、测试和抽象, 会让后续迭代更稳。',
      '启发二: 莫比乌斯需要元生产力指标。比如: 一次改动是否减少了下次定位问题的时间? 是否让测试可复用? 是否减少用户解释成本? 是否让失败更容易归因? 这些指标比单次功能成功更接近“自我进化能力”。',
      '莫比乌斯例子: 给插件增加相似产品调研, 短期只是多一个 tab; 但如果它沉淀了竞品启发、来源链接、风险和可落地路径, 未来每次做产品功能时都能复用, 这就是元生产力提升。'
    ),
    mobius_use: paragraphs(
      '给自迭代引入“元生产力”指标: 新增测试数量、复用知识条目、减少人工澄清次数、降低回滚概率、提升后续任务成功率。',
      '在测试服机制里不仅看功能是否通过, 还要记录它是否改善了下一轮迭代的观测、复现和回滚能力。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: HarnessFix 提醒我们, agent 失败经常不是“模型笨”, 而是 harness 层出了问题: 工具协议不清、上下文不完整、权限边界错误、生命周期没有记录、测试反馈太粗。莫比乌斯应把失败归因到具体层。',
      '启发二: AI 追问环节可以围绕 failure layer 展开。用户问“这篇论文说得对吗”, AI 不应该只复述摘要, 而应回答: 证据来自哪里、对莫比乌斯属于哪一层改动、需要哪些验证、哪些结论只是推断。',
      '莫比乌斯例子: 如果 arXiv 扫描失败, failure_layer 可能是 network/API; 如果插件页面空白, 可能是 frontend/dist 构建; 如果 AI 提议危险改动, 可能是 permission/governance。不同层要有不同修复模板。'
    ),
    mobius_use: paragraphs(
      '为 Session 日志增加 failure_layer 字段和修复模板。',
      '把失败归因接入未来 AI 追问: 每个回答都可声明“这是论文事实/工程推断/待验证假设”。',
      '在测试服里按层记录失败, 避免把所有问题都回收到 prompt 调整。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: “日志就是智能体”这个观点非常贴近莫比乌斯。真正的自我认知不是一段总结, 而是能回放“我为什么做了这个决定”。研究条目、用户指示、AI 追问、issue、命令、测试、commit、重启结果都应该成为事件。',
      '启发二: 事件流天然支持测试服和分叉。用户想试一个激进改动时, 可以从某个事件点 fork 出测试环境; 如果验证通过再合并, 不通过就保留为失败分支。',
      '莫比乌斯例子: 现在插件记录了 seed、扫描和指示, 但未来可以进一步记录“某条启发被 AI 追问过三次, 最终转成某个 issue, 在测试服通过, 然后 commit 到主线”。这条因果链比单独的 memory 更可信。'
    ),
    mobius_use: paragraphs(
      '后续把自迭代链路改造成 event-sourced: 研究条目、issue、session、命令、测试、commit、用户反馈都是事件。',
      '先在插件内展示 lineage 投影, 再考虑改核心架构。',
      '测试服机制建议基于事件分叉而不是直接在主线试错。'
    ),
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
    key_inspiration: paragraphs(
      '启发一: SkillSmith 的重点是技能和工具协同进化。莫比乌斯已经有 skills, 但如果工具协议、扩展权限、测试方式不匹配, 只改 skill 文案不会根治问题。',
      '启发二: 反模式库比单纯成功经验更重要。比如“看到用户说自动落实就立刻改核心代码”就是一个反模式; 正确做法是先生成 proposal、权限说明和测试服计划。',
      '莫比乌斯例子: mobius-extension skill 规定 handler 只能写 ext_data_dir; 如果未来某个自迭代想让插件直接写核心代码, 这不是 skill 能力不足, 而是工具/权限层的问题, 必须走架构讨论和授权。'
    ),
    mobius_use: paragraphs(
      '把每次失败沉淀成 anti-pattern: 触发条件、症状、根因、修复方式、禁止重复的方案。',
      '把 skill 与 tool 一起纳入评估: 文档是否清楚、工具是否足够、权限是否过大、测试是否覆盖。',
      '相似产品调研也可以沉淀反模式: 哪些产品看起来强但信任、权限、隐私和可验证性不足。'
    ),
    limitations: '工具层自动修改风险更高, 必须走白名单、回归测试和人工批准。',
  },
];

const PRODUCT_SEEDS = [
  {
    id: 'product-workbuddy',
    name: 'WorkBuddy',
    source_url: 'https://copilot.tencent.com/work/',
    category: 'office-agent',
    status: 'triaged',
    relevance: 5,
    tags: ['办公智能体', '多智能体', '交付物', '市场竞品'],
    positioning: '腾讯元宝面向办公场景的 AI 工作台, 强调多智能体协作、文档/会议/研究/写作等办公交付。',
    observed_capabilities: paragraphs(
      '面向办公任务而不是单纯聊天, 适合承载“一个任务 -> 多个子智能体 -> 可交付结果”的产品心智。',
      '对用户的吸引点不是模型能力本身, 而是能否稳定产出报告、方案、表格、会议摘要等工作产物。'
    ),
    key_inspiration: paragraphs(
      '莫比乌斯可以借鉴 WorkBuddy 的“工作产物优先”心智。自我认知插件不应只是论文书架, 更应该输出可执行的改造建议、测试清单、架构讨论稿和竞品对照表。',
      '如果未来做 AI 追问, 可以把回答分成“事实摘录、推断、可执行建议、待验证问题”四块, 让用户不用读完原文也能判断可信度。'
    ),
    mobius_use: paragraphs(
      '增加“相似产品的可借鉴调研”栏目, 把竞品能力转成对 Mobius 的借鉴点。',
      '后续可做“研究任务包”: 用户给一个方向, Mobius 同时查论文、查竞品、查自身代码, 最后交付一份 proposal。'
    ),
    risks: '办公智能体容易做成“泛泛总结”, 需要用来源链接、可验证问题和对 Mobius 的具体映射避免空泛。',
  },
  {
    id: 'product-devin',
    name: 'Devin',
    source_url: 'https://devin.ai/',
    category: 'coding-agent',
    status: 'triaged',
    relevance: 5,
    tags: ['编码智能体', '异步工程', '知识库', '市场竞品'],
    positioning: 'Cognition 的 AI 软件工程师产品, 面向真实工程任务、代码库理解和异步交付。',
    observed_capabilities: paragraphs(
      '产品重点不是“能不能写代码片段”, 而是围绕工程上下文、任务跟踪、执行环境和结果交付形成闭环。',
      '对企业用户来说, 权限、审计、上下文隔离和可回滚比炫技式代码生成更重要。'
    ),
    key_inspiration: paragraphs(
      '莫比乌斯的自迭代也应该从“会改代码”升级为“会交付一个工程变更包”。一个合格变更包应包含需求解释、代码 diff、测试结果、重启状态、风险、下一步。',
      'AI 追问入口可以让用户围绕某个变更包继续问: 为什么这么改? 哪些结论来自原文? 哪些只是推断? 有没有更保守方案?'
    ),
    mobius_use: paragraphs(
      '把自迭代 Session 的输出格式标准化为工程交付包。',
      '为测试服机制预留“异步执行 + 审计 + 回滚”能力, 不在主线直接试错。'
    ),
    risks: '编码智能体产品容易隐藏执行细节; Mobius 应反向强调透明日志和可追问证据。',
  },
  {
    id: 'product-openai-workspace-agents',
    name: 'OpenAI Workspace Agents',
    source_url: 'https://openai.com/index/introducing-company-knowledge-and-workspace-agents/',
    category: 'workflow-agent',
    status: 'candidate',
    relevance: 5,
    tags: ['组织知识', '权限', '共享智能体', '市场竞品'],
    positioning: '面向企业工作区的 agent 能力, 强调连接公司知识、工作流和组织权限。',
    observed_capabilities: paragraphs(
      '把 agent 从个人聊天提升到组织级工作空间: 需要权限、共享、审计、知识源边界和可管理性。',
      'agent 不是孤立 prompt, 而是带有角色、上下文、工具和运行边界的可配置对象。'
    ),
    key_inspiration: paragraphs(
      '这直接对应用户提出的信任问题: AI 能追问之前, 必须知道它能看什么、能做什么、不能做什么。Mobius 的 AI 追问应展示权限说明, 例如“只读论文库”“可读取当前插件代码”“可创建 proposal 但不能提交”。',
      '未来如果允许“一键落实”, 也应以 workspace agent 的权限模型设计: 读权限、建议权限、测试服执行权限、主线写权限分开。'
    ),
    mobius_use: paragraphs(
      '先在插件里设计“AI 追问权限矩阵”文案, 但不直接开放执行。',
      '后续核心架构讨论时, 把 agent 权限做成显式 capability, 而不是靠提示词约束。'
    ),
    risks: '组织级 agent 的权限设计复杂, 不能只在前端加按钮; 必须有后端授权和审计。',
  },
  {
    id: 'product-manus',
    name: 'Manus',
    source_url: 'https://manus.im/',
    category: 'general-agent',
    status: 'candidate',
    relevance: 4,
    tags: ['通用智能体', '异步任务', '市场竞品'],
    positioning: '通用 AI agent 产品, 对外强调可以代办复杂任务、形成结果交付。',
    observed_capabilities: paragraphs(
      '通用 agent 的产品表达通常围绕“替你完成任务”, 而不是“给你聊天答案”。',
      '它给 Mobius 的提醒是: 用户需要看到任务进度、证据来源、产物和下一步, 否则很难建立信任。'
    ),
    key_inspiration: paragraphs(
      '莫比乌斯可以把每次调研做成任务对象: 调研中、已发现来源、已提炼启发、待用户追问、可转 issue。',
      'AI 追问不是纯聊天, 而是围绕一个任务对象继续收敛: 补证据、反驳、找竞品、生成实施计划。'
    ),
    mobius_use: '给研究条目和产品条目增加“可追问、可转 proposal、可进入测试服”的状态机, 但执行权限需要后续讨论。',
    risks: '通用 agent 容易承诺过大; Mobius 应优先建立透明任务状态和验证边界。',
  },
  {
    id: 'product-openclaw',
    name: 'OpenClaw',
    source_url: 'https://github.com/openclaw/openclaw',
    category: 'coding-agent',
    status: 'candidate',
    relevance: 4,
    tags: ['开源', '聊天入口', '编码代理', '市场竞品'],
    positioning: '开源项目, 将聊天工具连接到 AI 编码代理, 让开发任务可以从 Slack/Discord/Telegram 等入口触发。',
    observed_capabilities: paragraphs(
      '价值点在于入口和编排: 用户不一定进入主系统 UI, 也可以从常用沟通工具触发 agent。',
      '这类产品强调多渠道接入, 但也会放大权限和审计风险。'
    ),
    key_inspiration: paragraphs(
      'Mobius 后续可以把“追问”和“落实 proposal”设计成统一协议, UI、聊天入口、API 都调用同一套授权流程。',
      '如果未来允许外部聊天入口触发自迭代, 必须先有测试服和审批队列, 不能让聊天消息直接变成主线代码修改。'
    ),
    mobius_use: '把“入口层”和“执行层”拆开: 插件按钮、聊天入口、API 都只能创建 proposal; 真正执行走统一测试服管线。',
    risks: '多入口会放大误触发和提示注入风险, 必须有强审计。',
  },
  {
    id: 'product-zapier-agents',
    name: 'Zapier Agents',
    source_url: 'https://zapier.com/agents',
    category: 'workflow-agent',
    status: 'candidate',
    relevance: 4,
    tags: ['工作流', '集成', '自动化', '市场竞品'],
    positioning: '面向业务流程的 AI agent, 强调连接应用、数据和自动化动作。',
    observed_capabilities: paragraphs(
      '强项是应用集成和动作自动化, 不是论文理解本身。',
      '对 Mobius 来说, 它提示我们后续要把“启发”连接到真实动作, 例如创建 issue、生成测试服、发起 review、更新文档。'
    ),
    key_inspiration: paragraphs(
      '不要把落实能力做成一个危险的大按钮。更合理的是把动作拆成可组合 workflow: 生成 proposal、创建测试分支、跑测试、生成报告、等待批准、合并。',
      '每一步都应能暂停和追问, 用户可以问“为什么现在要进入下一步”。'
    ),
    mobius_use: '为 4 的“真实落实”讨论准备 workflow 分层: 只读调研、proposal、测试服执行、主线执行。',
    risks: '应用自动化容易误操作真实数据; Mobius 需要测试数据和 dry-run。',
  },
  {
    id: 'product-lindy',
    name: 'Lindy',
    source_url: 'https://www.lindy.ai/',
    category: 'personal-agent',
    status: 'candidate',
    relevance: 3,
    tags: ['个人助理', '工作流', '无代码', '市场竞品'],
    positioning: '面向个人与团队流程的 AI 助理/agent 平台, 强调自动处理邮件、日程、CRM 等任务。',
    observed_capabilities: '强调用户可配置工作流与日常业务任务代办, 对非技术用户更友好。',
    key_inspiration: paragraphs(
      'Mobius 的自我认知插件也需要降低使用门槛: 用户不应该必须懂 arXiv 查询语法或代码路径, 应该能用自然语言提出“查一下相似产品有没有值得抄的”。',
      'AI 追问可以先以“只读研究助手”形式存在, 帮用户把条目讲明白, 再逐步进入 proposal。'
    ),
    mobius_use: '后续为扫描入口增加自然语言任务模板, 先生成查询和候选来源, 再由用户确认执行。',
    risks: '无代码工作流若缺少权限提示, 用户可能不知道 AI 实际动了什么。',
  },
  {
    id: 'product-genspark',
    name: 'Genspark Super Agent',
    source_url: 'https://www.genspark.ai/',
    category: 'research-agent',
    status: 'candidate',
    relevance: 3,
    tags: ['研究助手', '多模态产物', '市场竞品'],
    positioning: '面向搜索、研究和多模态产物生成的 AI agent 产品。',
    observed_capabilities: '强调从信息检索到产物生成的一体化体验, 用户关注最终报告和可分享产物。',
    key_inspiration: paragraphs(
      'Mobius 的调研结果应可以直接形成“可分享研究卡片”: 来源、可信度、关键启发、对 Mobius 的落地建议、风险。',
      '相似产品调研不应只列竞品名称, 要输出“可借鉴点”和“不该学的点”。'
    ),
    mobius_use: '把产品调研卡片和论文启发卡片统一成“可转 proposal”的知识对象。',
    risks: '研究 agent 产物容易幻觉来源; 必须保留 URL 和抓取时间。',
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

function rowToProduct(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  return {
    ...row,
    relevance: Number(row.relevance) || 3,
    tags,
  };
}

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
      updated_at TEXT NOT NULL,
      seed_version INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS product_research (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'candidate',
      relevance INTEGER NOT NULL DEFAULT 3,
      tags TEXT NOT NULL DEFAULT '[]',
      positioning TEXT NOT NULL DEFAULT '',
      observed_capabilities TEXT NOT NULL DEFAULT '',
      key_inspiration TEXT NOT NULL DEFAULT '',
      mobius_use TEXT NOT NULL DEFAULT '',
      risks TEXT NOT NULL DEFAULT '',
      source_quality TEXT NOT NULL DEFAULT 'official',
      fetched_title TEXT NOT NULL DEFAULT '',
      fetched_description TEXT NOT NULL DEFAULT '',
      fetched_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      seed_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_source_url ON product_research(source_url);
    CREATE INDEX IF NOT EXISTS idx_product_status ON product_research(status);
    CREATE INDEX IF NOT EXISTS idx_product_category ON product_research(category);

    CREATE TABLE IF NOT EXISTS product_scan_runs (
      id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      product_id TEXT,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'ideas', 'seed_version', 'INTEGER NOT NULL DEFAULT 0');
}

function openDb(extDataDir) {
  ensureDir(extDataDir);
  const db = new Database(path.join(extDataDir, DB_FILE));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initDb(db);
  seedIdeas(db);
  seedProducts(db);
  return db;
}

function seedIdeas(db) {
  const insert = db.prepare(`
    INSERT INTO ideas (
      id, title, source_url, source_id, source_type, status, relevance,
      authors, published_at, tags, abstract, key_inspiration, mobius_use,
      limitations, auto_fetched, fetched_at, created_by, created_at, updated_at, seed_version
    ) VALUES (
      @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
      @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
      @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
    )
  `);
  const update = db.prepare(`
    UPDATE ideas
       SET title = @title,
           source_url = @source_url,
           source_id = @source_id,
           source_type = @source_type,
           status = @status,
           relevance = @relevance,
           authors = @authors,
           published_at = @published_at,
           tags = @tags,
           abstract = @abstract,
           key_inspiration = @key_inspiration,
           mobius_use = @mobius_use,
           limitations = @limitations,
           updated_at = @updated_at,
           seed_version = @seed_version
     WHERE id = @id
       AND created_by = 'system'
       AND COALESCE(seed_version, 0) < @seed_version
  `);
  const ts = '2026-06-21T00:00:00.000Z';
  const tx = db.transaction(() => {
    for (const item of SEED_IDEAS) {
      const row = {
        ...item,
        tags: JSON.stringify(normalizeTags(item.tags)),
        auto_fetched: 0,
        fetched_at: null,
        created_by: 'system',
        created_at: ts,
        updated_at: nowIso(),
        seed_version: SEED_VERSION,
      };
      const existing = db.prepare('SELECT id FROM ideas WHERE id = ?').get(item.id);
      if (existing) update.run(row);
      else insert.run(row);
    }
  });
  tx();
}

function seedProducts(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO product_research (
      id, name, source_url, category, status, relevance, tags, positioning,
      observed_capabilities, key_inspiration, mobius_use, risks, source_quality,
      fetched_title, fetched_description, fetched_at, created_by, created_at, updated_at, seed_version
    ) VALUES (
      @id, @name, @source_url, @category, @status, @relevance, @tags, @positioning,
      @observed_capabilities, @key_inspiration, @mobius_use, @risks, @source_quality,
      @fetched_title, @fetched_description, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
    )
  `);
  const update = db.prepare(`
    UPDATE product_research
       SET name = @name,
           source_url = @source_url,
           category = @category,
           status = @status,
           relevance = @relevance,
           tags = @tags,
           positioning = @positioning,
           observed_capabilities = @observed_capabilities,
           key_inspiration = @key_inspiration,
           mobius_use = @mobius_use,
           risks = @risks,
           source_quality = @source_quality,
           updated_at = @updated_at,
           seed_version = @seed_version
     WHERE id = @id
       AND created_by = 'system'
       AND COALESCE(seed_version, 0) < @seed_version
  `);
  const ts = '2026-06-21T00:00:00.000Z';
  const tx = db.transaction(() => {
    for (const item of PRODUCT_SEEDS) {
      const row = {
        ...item,
        tags: JSON.stringify(normalizeTags(item.tags)),
        source_quality: item.source_quality || 'official',
        fetched_title: '',
        fetched_description: '',
        fetched_at: null,
        created_by: 'system',
        created_at: ts,
        updated_at: nowIso(),
        seed_version: PRODUCT_RESEARCH_VERSION,
      };
      const existing = db.prepare('SELECT id FROM product_research WHERE id = ?').get(item.id);
      if (existing) update.run(row);
      else insert.run(row);
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
  const productTotal = db.prepare('SELECT COUNT(*) AS n FROM product_research').get().n;
  const productTriaged = db.prepare("SELECT COUNT(*) AS n FROM product_research WHERE status IN ('triaged', 'planned', 'applied')").get().n;
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
    product_total: productTotal,
    product_triaged: productTriaged,
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
    seed_version: 0,
  };
  db.prepare(`
    INSERT INTO ideas (
      id, title, source_url, source_id, source_type, status, relevance,
      authors, published_at, tags, abstract, key_inspiration, mobius_use,
      limitations, auto_fetched, fetched_at, created_by, created_at, updated_at, seed_version
    ) VALUES (
      @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
      @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
      @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
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

function getProduct(db, id) {
  return rowToProduct(db.prepare('SELECT * FROM product_research WHERE id = ?').get(id));
}

function listProducts(db, payload = {}) {
  const where = [];
  const params = [];
  const q = cleanText(payload.product_q || payload.q, 120);
  if (q) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    where.push(`(
      name LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR positioning LIKE ? ESCAPE '\\'
      OR observed_capabilities LIKE ? ESCAPE '\\' OR key_inspiration LIKE ? ESCAPE '\\'
      OR mobius_use LIKE ? ESCAPE '\\' OR risks LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const status = cleanText(payload.product_status || payload.status, 32);
  if (status && STATUSES.has(status)) {
    where.push('status = ?');
    params.push(status);
  }
  const category = cleanText(payload.product_category || payload.category, 32);
  if (category && PRODUCT_CATEGORIES.has(category)) {
    where.push('category = ?');
    params.push(category);
  }
  const tag = cleanText(payload.product_tag || payload.tag, 32);
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${tag.replace(/"/g, '')}"%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM product_research
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
      updated_at DESC
  `).all(...params);
  return { products: rows.map(rowToProduct), product_total: rows.length };
}

function validateProductInput(input, mode) {
  const isCreate = mode === 'create';
  const name = cleanText(input.name, 180);
  const sourceUrl = input.source_url == null && !isCreate ? undefined : mustUrl(input.source_url);
  if (isCreate && !name) throw new Error('产品名称不能为空');
  if (input.name != null && !name) throw new Error('产品名称不能为空');
  const category = input.category == null ? undefined : cleanText(input.category, 32);
  if (category != null && !PRODUCT_CATEGORIES.has(category)) throw new Error('category 非法');
  const status = input.status == null ? undefined : cleanText(input.status, 32);
  if (status != null && !STATUSES.has(status)) throw new Error('产品 status 非法');
  const out = {};
  if (input.name != null) out.name = name;
  if (sourceUrl !== undefined) out.source_url = sourceUrl;
  if (category != null) out.category = category;
  if (status != null) out.status = status;
  if (input.relevance != null) out.relevance = clampInt(input.relevance, 3, 1, 5);
  if (input.tags != null) out.tags = JSON.stringify(normalizeTags(input.tags));
  if (input.positioning != null) out.positioning = cleanLongText(input.positioning, 3000);
  if (input.observed_capabilities != null) out.observed_capabilities = cleanLongText(input.observed_capabilities, 5000);
  if (input.key_inspiration != null) out.key_inspiration = cleanLongText(input.key_inspiration, 5000);
  if (input.mobius_use != null) out.mobius_use = cleanLongText(input.mobius_use, 5000);
  if (input.risks != null) out.risks = cleanLongText(input.risks, 3000);
  if (input.source_quality != null) out.source_quality = cleanText(input.source_quality, 64);
  if (input.fetched_title != null) out.fetched_title = cleanText(input.fetched_title, 260);
  if (input.fetched_description != null) out.fetched_description = cleanText(input.fetched_description, 1000);
  return out;
}

function createProduct(db, payload, username) {
  const fields = validateProductInput(payload, 'create');
  const ts = nowIso();
  const row = {
    id: newId('p'),
    name: fields.name,
    source_url: fields.source_url,
    category: fields.category || 'other',
    status: fields.status || 'candidate',
    relevance: fields.relevance || 3,
    tags: fields.tags || '[]',
    positioning: fields.positioning || '',
    observed_capabilities: fields.observed_capabilities || '',
    key_inspiration: fields.key_inspiration || '待提炼: 请补充这个产品对莫比乌斯的可借鉴点。',
    mobius_use: fields.mobius_use || '',
    risks: fields.risks || '',
    source_quality: fields.source_quality || 'manual',
    fetched_title: fields.fetched_title || '',
    fetched_description: fields.fetched_description || '',
    fetched_at: null,
    created_by: username,
    created_at: ts,
    updated_at: ts,
    seed_version: 0,
  };
  db.prepare(`
    INSERT INTO product_research (
      id, name, source_url, category, status, relevance, tags, positioning,
      observed_capabilities, key_inspiration, mobius_use, risks, source_quality,
      fetched_title, fetched_description, fetched_at, created_by, created_at, updated_at, seed_version
    ) VALUES (
      @id, @name, @source_url, @category, @status, @relevance, @tags, @positioning,
      @observed_capabilities, @key_inspiration, @mobius_use, @risks, @source_quality,
      @fetched_title, @fetched_description, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
    )
  `).run(row);
  return getProduct(db, row.id);
}

function updateProduct(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  const current = getProduct(db, id);
  if (!current) throw new Error('产品调研不存在');
  const fields = validateProductInput(payload, 'update');
  const entries = Object.entries(fields);
  if (!entries.length) return current;
  entries.push(['updated_at', nowIso()]);
  db.prepare(`UPDATE product_research SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
  return getProduct(db, id);
}

function deleteProduct(db, payload) {
  const id = cleanText(payload.id, 120);
  if (!id) throw new Error('id 必填');
  db.prepare('DELETE FROM product_research WHERE id = ?').run(id);
  return { id };
}

function listProductScanRuns(db) {
  return db.prepare('SELECT * FROM product_scan_runs ORDER BY created_at DESC LIMIT 30').all();
}

function parseHtmlMetadata(html) {
  const text = String(html || '').slice(0, 800000);
  const title = decodeXml(((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
  const descMatch = text.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i);
  const description = decodeXml((descMatch || [])[1] || '');
  return { title: cleanText(title, 260), description: cleanText(description, 1000) };
}

async function scanProductUrl(db, payload, username) {
  const sourceUrl = mustUrl(payload.source_url);
  const nameHint = cleanText(payload.name, 180);
  const category = cleanText(payload.category, 32) && PRODUCT_CATEGORIES.has(cleanText(payload.category, 32))
    ? cleanText(payload.category, 32)
    : 'other';
  const runId = newId('product_scan');
  const createdAt = nowIso();
  try {
    const html = await fetchText(sourceUrl);
    const meta = parseHtmlMetadata(html);
    const ts = nowIso();
    const id = stableId('product', sourceUrl);
    const name = nameHint || meta.title || new URL(sourceUrl).hostname.replace(/^www\./, '');
    const row = {
      id,
      name: cleanText(name, 180),
      source_url: sourceUrl,
      category,
      status: 'candidate',
      relevance: clampInt(payload.relevance, 3, 1, 5),
      tags: JSON.stringify(normalizeTags(['自动抓取', '相似产品', ...(payload.tags ? normalizeTags(payload.tags) : [])])),
      positioning: cleanLongText(payload.positioning || meta.description || '自动抓取候选产品, 需要继续人工补充定位。', 3000),
      observed_capabilities: cleanLongText(payload.observed_capabilities || '自动抓取只提取页面标题和描述。下一步需要人工或 AI 追问补充能力、价格、典型场景和用户评价。', 5000),
      key_inspiration: cleanLongText(payload.key_inspiration || '待提炼: 这个产品可能包含对莫比乌斯有用的交互、权限、任务交付或市场定位设计, 需要进一步追问和核验。', 5000),
      mobius_use: cleanLongText(payload.mobius_use || '待补充: 将该产品的能力映射到莫比乌斯的插件、AI 追问、测试服或自迭代流程。', 5000),
      risks: cleanLongText(payload.risks || '自动抓取结果只来自公开页面元信息, 不能替代完整产品体验。', 3000),
      source_quality: 'fetched_url',
      fetched_title: meta.title,
      fetched_description: meta.description,
      fetched_at: ts,
      created_by: username,
      created_at: ts,
      updated_at: ts,
      seed_version: 0,
    };
    db.prepare(`
      INSERT INTO product_research (
        id, name, source_url, category, status, relevance, tags, positioning,
        observed_capabilities, key_inspiration, mobius_use, risks, source_quality,
        fetched_title, fetched_description, fetched_at, created_by, created_at, updated_at, seed_version
      ) VALUES (
        @id, @name, @source_url, @category, @status, @relevance, @tags, @positioning,
        @observed_capabilities, @key_inspiration, @mobius_use, @risks, @source_quality,
        @fetched_title, @fetched_description, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
      )
      ON CONFLICT(source_url) DO UPDATE SET
        fetched_title = excluded.fetched_title,
        fetched_description = excluded.fetched_description,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `).run(row);
    const product = rowToProduct(db.prepare('SELECT * FROM product_research WHERE source_url = ?').get(sourceUrl));
    db.prepare(`
      INSERT INTO product_scan_runs (id, source_url, product_id, status, error, created_by, created_at)
      VALUES (?, ?, ?, 'ok', '', ?, ?)
    `).run(runId, sourceUrl, product.id, username, createdAt);
    return { run_id: runId, product };
  } catch (e) {
    db.prepare(`
      INSERT INTO product_scan_runs (id, source_url, product_id, status, error, created_by, created_at)
      VALUES (?, ?, NULL, 'error', ?, ?, ?)
    `).run(runId, sourceUrl, cleanText(e.message, 500), username, createdAt);
    throw new Error('产品页面抓取失败: ' + cleanText(e.message, 160));
  }
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
        'user-agent': 'Mobius self-cognition extension/0.2',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
        limitations, auto_fetched, fetched_at, created_by, created_at, updated_at, seed_version
      ) VALUES (
        @id, @title, @source_url, @source_id, @source_type, @status, @relevance,
        @authors, @published_at, @tags, @abstract, @key_inspiration, @mobius_use,
        @limitations, @auto_fetched, @fetched_at, @created_by, @created_at, @updated_at, @seed_version
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
          seed_version: 0,
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
    products: db.prepare('SELECT * FROM product_research ORDER BY updated_at DESC').all().map(rowToProduct),
    directives: listDirectives(db),
    scan_runs: listScanRuns(db),
    product_scan_runs: listProductScanRuns(db),
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
        product_research: listProducts(db).products,
        product_scan_runs: listProductScanRuns(db),
        constants: {
          statuses: [...STATUSES],
          source_types: [...SOURCE_TYPES],
          product_categories: [...PRODUCT_CATEGORIES],
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
    case 'list_products':
      return { ok: true, ...listProducts(db, payload), stats: stats(db), product_scan_runs: listProductScanRuns(db) };
    case 'create_product':
      return { ok: true, product: createProduct(db, payload, username), ...listProducts(db, {}), stats: stats(db) };
    case 'update_product':
      return { ok: true, product: updateProduct(db, payload), ...listProducts(db, {}), stats: stats(db) };
    case 'delete_product':
      return { ok: true, removed: deleteProduct(db, payload), ...listProducts(db, {}), stats: stats(db) };
    case 'scan_product_url': {
      const result = await scanProductUrl(db, payload, username);
      return {
        ok: true,
        product_scan: result,
        ...listProducts(db, {}),
        stats: stats(db),
        product_scan_runs: listProductScanRuns(db),
      };
    }
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
