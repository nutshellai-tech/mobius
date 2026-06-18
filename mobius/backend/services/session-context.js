/**
 * session-context.js — 把 Web 端 ContextPanel 上展示的元数据
 * (用户 / 项目 / Issue / Session / Skill / Memory) 拼成一段可注入到 prompt 的字符串.
 *
 * 仅在 session 首次发消息时注入一次, 后续轮次依赖对话历史.
 * 同一字符串通过 GET /api/sessions/:id/context-preview 暴露给前端预览按钮.
 */
const { Sessions } = require('../repositories/sessions');
const { Issues } = require('../repositories/issues');
const { Researches } = require('../repositories/researches');
const { Projects } = require('../repositories/projects');
const { Skills } = require('../repositories/skills');
const { Memories } = require('../repositories/memories');
const { PORT } = require('../config');
const { resolveEffectiveSkills } = require('./skill-resolver');
const { parseSkillId } = require('./skills-fs');
const { TARGET_SUBDIR: SKILLS_SUBDIR } = require('./session-skills-sync');
const { isGitRepoRoot } = require('./workspace');
const { filterReadableContextItems } = require('./access-control');
const { isAssistantSession } = require('./assistant-session');

const ISSUE_STATUS_LABELS = { active: '开放', in_progress: '进行中', completed: '已解决', open: '开放' };
const RESEARCH_STATUS_LABELS = { active: '开放', completed: '已完成' };
const SESSION_STATUS_LABELS = { active: '进行中', archived: '已归档', completed: '已完成' };
const ISSUE_STATUS_LABELS_EN = { active: 'Open', in_progress: 'In Progress', completed: 'Resolved', open: 'Open' };
const RESEARCH_STATUS_LABELS_EN = { active: 'Open', completed: 'Completed' };
const SESSION_STATUS_LABELS_EN = { active: 'In Progress', archived: 'Archived', completed: 'Completed' };

// 注入上下文语言归一: 仅 'zh' / 'en', 其余回退中文.
function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'zh';
}
const RANDOM_EMOJIS = [
  // 天体 / 天气
  '✨', '🌟', '💫', '⭐', '🌙', '☀️', '🌤️', '🌦️',
  '🌧️', '⛅', '⛈️', '🌩️', '🌨️', '🌬️', '🌫️', '🌠',
  // 植物 / 自然
  '🍀', '🌿', '🌱', '🌵', '🌸', '🌼', '🌻', '🍁',
  '🌹', '🌷', '🌺', '🌳', '🌲', '🎋', '🍂', '🍄',
  // 游戏 / 艺术
  '🎲', '🧩', '🎯', '🎪', '🎨', '🎭', '🎬', '🎧',
  // 交通 / 场景
  '🚀', '🛰️', '✈️', '🛸', '🚦', '🛤️', '🏕️', '🏙️',
  '🚁', '⛵', '🚂', '🚲', '🏎️', '🗽', '🏰', '🎡',
  // 元素 / 气象
  '🔥', '⚡', '💧', '❄️', '🌊', '🌪️', '☄️', '🌈',
  // 水果
  '🍉', '🍓', '🍒', '🍑', '🍍', '🥝', '🫐', '🍯',
  '🍎', '🍊', '🍋', '🍌', '🍇', '🥭', '🍈', '🥥',
  // 庆祝 / 奖励
  '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🏅', '🎖️',
  // 工具 / 魔法 / 探索
  '💎', '🔮', '🪄', '🧭', '🗺️', '🔭', '🔬', '⚙️',
  '🛠️', '🔑', '🧪', '💡', '📌', '📎', '📝', '📚',
  // 爱心
  '💜', '💙', '💚', '💛', '🧡', '❤️', '🤍', '🖤',
  // 圆点
  '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚪', '⚫',
  // 动物
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁',
  '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦇',
  '🐺', '🐗', '🦄', '🐝', '🦋', '🐌', '🐞', '🐢',
  '🐙', '🦑', '🦀', '🐠', '🐬', '🐳', '🦈', '🐊',
  '🦓', '🦍', '🐘', '🦒', '🦘', '🐪', '🦔', '🦦',
  // 表情
  '😀', '😄', '😁', '😆', '😂', '🤣', '😊', '😍',
  '🥰', '😎', '🤩', '🥳', '🤓', '🧐', '🤔', '😉',
  // 食物
  '🍕', '🍔', '🍟', '🌭', '🍿', '🥐', '🥯', '🧀',
  '🌮', '🌯', '🍣', '🍱', '🍜', '🍝', '🍪', '🍩',
  '🍰', '🧁', '🍫', '🍬', '🍭', '🍦', '🍨', '🥧',
  // 饮品
  '☕', '🍵', '🧃', '🥤', '🧋', '🍺', '🍻', '🥂',
  '🍷', '🍸', '🍹', '🥃', '🧉', '🍾',
  // 运动
  '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱',
  '🏓', '🏸', '🥏', '🪁', '🏹', '🥊', '🛹', '⛸️',
  '🎿', '🏂', '🏄', '🏊', '🚵', '🚴', '🧗', '🧘',
  // 乐器
  '🎵', '🎶', '🎼', '🎤', '🎷', '🎸', '🎹', '🎺',
  '🎻', '🪕', '🥁',
  // 电子 / 设备
  '⌚', '📱', '💻', '⌨️', '🖥️', '🖱️', '🕹️', '💾',
  '📷', '📸', '📹', '🎥', '📺', '📻', '⏰', '⏱️',
];

// memory scope -> 展示标签; 未列出的 (如 'user') 回退到 '用户级', 与历史行为一致.
const MEMORY_SCOPE_LABELS = { project: '项目级', builtin: '内置级' };

// 内置级 memory: 平台自带、与具体用户/项目无关的长期事实, 始终注入 (排在 DB memory 之前).
const BUILTIN_MEMORIES = [
  {
    scope: 'builtin',
    name: '向用户展示图像',
    description: 'display_images (bash命令): 将一个或多个图片展示给用户。',
    body: [
      '图片路径【必须是绝对路径】(以 / 开头), 或是 http:// / https:// 开头的 URL。传入相对路径会被拒绝。',
      '参数:',
      '  <图片N>       图片的绝对路径(以 / 开头)或 http(s) URL',
      '示例:',
      '  display_images /home/alice/pics/cat.png',
      '  display_images /home/alice/pics/a.png /home/alice/pics/b.jpg',
      '  display_images https://example.com/photo.jpg',
    ].join('\n'),
  },
];

function indent(text, prefix = '  ') {
  return String(text || '').split('\n').map(l => prefix + l).join('\n');
}

function shuffled(items) {
  const out = Array.isArray(items) ? [...items] : [];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// =====================================================================
// 上下文分段拼装函数. 每段都有中文 (zh_add_*) 与英文 (en_add_*) 两版,
// 由 formatBody 按 session 的 language 选用. 新增字段时务必同步两版.
// =====================================================================

function researchBlackboardUrl(researchId) {
  return `http://localhost:${PORT}/api/research-blackboard/${researchId}`;
}

// ---------- 中文版 ----------

function zh_add_header(lines) {
  lines.push('# 上下文');
  lines.push('');
  lines.push('以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.');
  lines.push('');
}

function zh_add_user_level_info(lines, user) {
  if (!user) return;
  lines.push('## 用户');
  lines.push(`- 姓名: ${user.display_name || user.id}`);
  lines.push(`- 角色: ${user.role === 'admin' ? '管理员' : '成员'}`);
  lines.push('');
}

function zh_add_project_level_info(lines, project) {
  if (!project) return;
  lines.push('## 项目');
  lines.push(`- 名称: ${project.name}`);
  if (project.description) {
    lines.push('- 描述:');
    lines.push(indent(project.description));
  }
  lines.push('');
}

function zh_add_issue_level_info(lines, issue) {
  if (!issue) return;
  lines.push('## Issue');
  lines.push(`- 标题: ${issue.title}`);
  lines.push(`- 状态: ${ISSUE_STATUS_LABELS[issue.status] || issue.status || '未知'}`);
  if (issue.description) {
    lines.push('- 描述:');
    lines.push(indent(issue.description));
  }
  lines.push('');
}

function zh_add_research_level_info(lines, research) {
  if (!research) return;
  lines.push('## Research');
  lines.push(`- ID: ${research.id}`);
  lines.push(`- 标题: ${research.title}`);
  lines.push(`- 状态: ${RESEARCH_STATUS_LABELS[research.status] || research.status || '未知'}`);
  if (research.description) {
    lines.push('- 描述:');
    lines.push(indent(research.description));
  }
  lines.push('');
}

function zh_add_session_level_info(lines, session) {
  if (!session) return;
  lines.push('## Session');
  lines.push(`- 名称: ${session.name}`);
  lines.push(`- 状态: ${SESSION_STATUS_LABELS[session.status] || session.status || '未知'}`);
  if (session.research_role) {
    lines.push(`- 角色: ${session.research_role}`);
  }
  if (session.description) {
    lines.push('- 描述:');
    lines.push(indent(session.description));
  }
  lines.push('');
}

function zh_add_research_blackboard_info(lines, research, session) {
  if (!(research && research.id)) return;
  const url = researchBlackboardUrl(research.id);
  const author = session?.research_role || 'research_assistant';
  lines.push('## Research Blackboard');
  lines.push(`当前研究的 Blackboard 只能通过 Mobius HTTP API 读写。不要直接编辑 \`.imac/blackboard/${research.id}/blackboard.jsonl\` 文件。`);
  lines.push('');
  lines.push('读取完整 Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl ${url}`);
  lines.push('```');
  lines.push('');
  lines.push('写入 Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl -X POST ${url} \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  lines.push(`  -d '{"author":"${author}","content":"这里写入你的研究进展、发现或需要同步给团队的信息"}'`);
  lines.push('```');
  lines.push('');
  lines.push('Blackboard 内容只记录写入者和内容，不指定接收者。任意写入都会在后台投递给本 Research 中其他已创建 session。');
  lines.push('');
}

function zh_add_research_peer_info(lines, peers) {
  if (!Array.isArray(peers) || peers.length === 0) return;
  lines.push('## 已有 Research Sessions');
  for (const p of peers) {
    lines.push(`- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`);
  }
  lines.push('');
}

function zh_add_memory_info(lines, memories) {
  const all = shuffled([...BUILTIN_MEMORIES, ...(Array.isArray(memories) ? memories : [])]);
  if (all.length === 0) return;
  lines.push('## 持久 Memory');
  lines.push('本用户与项目积累的长期事实 / 偏好如下. 视作已知信息.');
  lines.push('');
  all.forEach((m, idx) => {
    lines.push(`### ${m.name}`);
    if (m.description) lines.push(`> ${m.description}`);
    lines.push('');
    lines.push((m.body || '').replace(/\r\n/g, '\n').trimEnd());
    lines.push('');
    if (idx < all.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });
  lines.push('');
}

function zh_add_skill_info(lines, skills) {
  if (!skills || skills.length === 0) return;
  lines.push('## 必要 Skill');
  lines.push('以下Skill与当前问题可能有关，在解决问题之前，你必须根据实际需要，有选择性地理解并学习以下skill');
  lines.push('');
  for (const sk of shuffled(skills)) {
    const rel = sk.dirName ? `${SKILLS_SUBDIR}/${sk.dirName}/SKILL.md` : '(未知路径)';
    lines.push(`- **${sk.name}**`);
    lines.push(`  - 路径: \`${rel}\``);
    if (sk.description) lines.push(`  - 简介: ${sk.description}`);
  }
  lines.push('');
}

function zh_add_worktree_info(lines, issue, project, session) {
  const wt = (issue && issue.use_worktree && project && project.bind_path)
    ? { root: project.bind_path, branch: issue.worktree_branch }
    : null;
  if (!wt) return;
  if (!isGitRepoRoot(wt.root)) {
    lines.push('## Git Worktree 设置');
    lines.push(`本 Issue 勾选了 git worktree，但项目绑定路径 \`${wt.root}\` 当前不是 Git 仓库根。平台已忽略 git worktree 选项。`);
    lines.push(`请直接在普通工作目录 \`${wt.root}\` 内完成任务，不要创建或切换 git worktree。`);
    lines.push('');
    return;
  }
  const wtPath = `${wt.root}/${wt.branch}`;
  lines.push('## Git Worktree 工作区 (必读, 任务开始前优先执行)');
  lines.push(`本 Issue 启用 git worktree. 仓库根: \`${wt.root}\` ; 你的工作区: \`${wtPath}\` (分支 \`${wt.branch}\`).`);
  lines.push('平台只创建了该路径下的空占位目录, **真正的 git worktree 需要你来创建**.');
  lines.push('');
  lines.push('### 第一步 (任何任务动作之前)');
  lines.push('在仓库根把占位目录初始化为 git worktree, 创建并检出分支, 然后进入工作区:');
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wt.root}"`);
  lines.push(`rm -rf "${wtPath}"   # 平台占位空目录; git worktree add 不接受已存在目录`);
  lines.push(`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`);
  lines.push(`  || git worktree add "${wtPath}" "${wt.branch}"   # 分支已存在则复用`);
  lines.push(`cd "${wtPath}"`);
  lines.push('```');
  lines.push('');
  lines.push('此后所有代码改动都在该 worktree 内进行. (备注：可能存在不止一个git仓库，请随机应变）');
  lines.push('');
  lines.push(isAssistantSession(session)
    ? '### 任务完成时 (成功或失败)'
    : '### 任务完成时 (成功或失败, 在删除下方 running.flag 之前必须做)');
  lines.push(`把分支 \`${wt.branch}\` 合并到 \`agent_smart_dev\` 分支:`);
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wtPath}"`);
  lines.push(`git add -A && git commit -m "task: ${wt.branch}" || true`);
  lines.push(`cd "${wt.root}"`);
  lines.push('git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev');
  lines.push('git checkout agent_smart_dev');
  lines.push(`git merge "${wt.branch}"`);
  lines.push('```');
  lines.push('');
  lines.push('若合并有冲突, 必须解决全部冲突后再完成合并; 合并完成后重新运行测试验证需求是否满足. 若仍有冲突或测试不通过, 继续修复 → 重新合并 → 重新测试, **直到没有冲突且测试通过为止**.');
  lines.push('一切结束后，尝试git push，如果因为认证，失败了也没关系，跳过即可。');
  if (!isAssistantSession(session)) {
    lines.push(`提示: running.flag 位于仓库根 \`${wt.root}/.imac/...\`, 不在 worktree 内 — 重建/删除 worktree 目录时不要误删它.`);
  }
  lines.push('');
}

function zh_add_completion_flag_info(lines, session, project) {
  if (!(session && session.session_id && session.session_id !== '(待创建)')) return;
  if (isAssistantSession(session)) return;
  const flagRoot = (project && project.bind_path) ? project.bind_path : '.';
  const flagPath = `${flagRoot}/.imac/flags/${session.session_id}/running.flag`;
  lines.push('## 当任务完成时的最后一步');
  lines.push(`当任务最终成功或者最终失败时，你需要删除标记文件 ${flagPath}。但是，不要轻易放弃，尝试一切可能解决问题的方法，直到你确信无法继续为止。`);
}

// ---------- 英文版 ----------

function en_add_header(lines) {
  lines.push('# Context');
  lines.push('');
  lines.push('The following describes the user you are assisting, and the Project, Issue/Research, and Session this work belongs to.');
  lines.push('Use it to calibrate how you address the user and the scope of your work; do not ask for fields already listed here.');
  lines.push('');
}

function en_add_user_level_info(lines, user) {
  if (!user) return;
  lines.push('## User');
  lines.push(`- Name: ${user.display_name || user.id}`);
  lines.push(`- Role: ${user.role === 'admin' ? 'Admin' : 'Member'}`);
  lines.push('');
}

function en_add_project_level_info(lines, project) {
  if (!project) return;
  lines.push('## Project');
  lines.push(`- Name: ${project.name}`);
  if (project.description) {
    lines.push('- Description:');
    lines.push(indent(project.description));
  }
  lines.push('');
}

function en_add_issue_level_info(lines, issue) {
  if (!issue) return;
  lines.push('## Issue');
  lines.push(`- Title: ${issue.title}`);
  lines.push(`- Status: ${ISSUE_STATUS_LABELS_EN[issue.status] || issue.status || 'Unknown'}`);
  if (issue.description) {
    lines.push('- Description:');
    lines.push(indent(issue.description));
  }
  lines.push('');
}

function en_add_research_level_info(lines, research) {
  if (!research) return;
  lines.push('## Research');
  lines.push(`- ID: ${research.id}`);
  lines.push(`- Title: ${research.title}`);
  lines.push(`- Status: ${RESEARCH_STATUS_LABELS_EN[research.status] || research.status || 'Unknown'}`);
  if (research.description) {
    lines.push('- Description:');
    lines.push(indent(research.description));
  }
  lines.push('');
}

function en_add_session_level_info(lines, session) {
  if (!session) return;
  lines.push('## Session');
  lines.push(`- Name: ${session.name}`);
  lines.push(`- Status: ${SESSION_STATUS_LABELS_EN[session.status] || session.status || 'Unknown'}`);
  if (session.research_role) {
    lines.push(`- Research Role: ${session.research_role}`);
  }
  if (session.description) {
    lines.push('- Description:');
    lines.push(indent(session.description));
  }
  lines.push('');
}

function en_add_research_blackboard_info(lines, research, session) {
  if (!(research && research.id)) return;
  const url = researchBlackboardUrl(research.id);
  const author = session?.research_role || 'research_assistant';
  lines.push('## Research Blackboard');
  lines.push(`This research's Blackboard can only be read and written through the Mobius HTTP API. Do not directly edit the \`.imac/blackboard/${research.id}/blackboard.jsonl\` file.`);
  lines.push('');
  lines.push('Read the full Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl ${url}`);
  lines.push('```');
  lines.push('');
  lines.push('Write to the Blackboard:');
  lines.push('');
  lines.push('```bash');
  lines.push(`curl -X POST ${url} \\`);
  lines.push(`  -H 'Content-Type: application/json' \\`);
  lines.push(`  -d '{"author":"${author}","content":"Write your research progress, findings, or anything to sync with the team here"}'`);
  lines.push('```');
  lines.push('');
  lines.push('A Blackboard entry records only its author and content, with no designated recipient. Any write is delivered in the background to the other sessions already created in this Research.');
  lines.push('');
}

function en_add_research_peer_info(lines, peers) {
  if (!Array.isArray(peers) || peers.length === 0) return;
  lines.push('## Existing Research Sessions');
  for (const p of peers) {
    lines.push(`- ${p.research_role || 'unknown'}: session_id=${p.session_id}, name=${p.name}, status=${p.status}`);
  }
  lines.push('');
}

function en_add_memory_info(lines, memories) {
  const all = shuffled([...BUILTIN_MEMORIES, ...(Array.isArray(memories) ? memories : [])]);
  if (all.length === 0) return;
  lines.push('## Persistent Memory');
  lines.push('Long-term facts / preferences accumulated for this user and project are listed below. Treat them as known information.');
  lines.push('');
  all.forEach((m, idx) => {
    lines.push(`### ${m.name}`);
    if (m.description) lines.push(`> ${m.description}`);
    lines.push('');
    lines.push((m.body || '').replace(/\r\n/g, '\n').trimEnd());
    lines.push('');
    if (idx < all.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });
  lines.push('');
}

function en_add_skill_info(lines, skills) {
  if (!skills || skills.length === 0) return;
  lines.push('## Required Skills');
  lines.push('Before solving the problem, you can read and learn the following skills according to your need.');
  lines.push('');
  for (const sk of shuffled(skills)) {
    const rel = sk.dirName ? `${SKILLS_SUBDIR}/${sk.dirName}/SKILL.md` : '(unknown path)';
    lines.push(`- **${sk.name}**`);
    lines.push(`  - Path: \`${rel}\``);
    if (sk.description) lines.push(`  - Summary: ${sk.description}`);
  }
  lines.push('');
}

function en_add_worktree_info(lines, issue, project, session) {
  const wt = (issue && issue.use_worktree && project && project.bind_path)
    ? { root: project.bind_path, branch: issue.worktree_branch }
    : null;
  if (!wt) return;
  if (!isGitRepoRoot(wt.root)) {
    lines.push('## Git Worktree Setup');
    lines.push(`This Issue enabled git worktree, but the project bind path \`${wt.root}\` is currently not a Git repository root. The platform has ignored the git worktree option.`);
    lines.push(`Please complete the task directly in the normal working directory \`${wt.root}\`; do not create or switch git worktrees.`);
    lines.push('');
    return;
  }
  const wtPath = `${wt.root}/${wt.branch}`;
  lines.push('## Git Worktree Workspace (must read, do this first before starting the task)');
  lines.push(`This Issue enables git worktree. Repo root: \`${wt.root}\` ; your workspace: \`${wtPath}\` (branch \`${wt.branch}\`).`);
  lines.push('The platform only created an empty placeholder directory at that path; **you must create the actual git worktree yourself**.');
  lines.push('');
  lines.push('### Step 1 (before any task action)');
  lines.push('In the repo root, initialize the placeholder directory as a git worktree, create and check out the branch, then enter the workspace:');
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wt.root}"`);
  lines.push(`rm -rf "${wtPath}"   # platform placeholder empty dir; git worktree add does not accept an existing directory`);
  lines.push(`git worktree add -b "${wt.branch}" "${wtPath}" 2>/dev/null \\`);
  lines.push(`  || git worktree add "${wtPath}" "${wt.branch}"   # reuse the branch if it already exists`);
  lines.push(`cd "${wtPath}"`);
  lines.push('```');
  lines.push('');
  lines.push('From now on, make all code changes inside this worktree. (Note: there may be more than one git repo, so adapt as needed.)');
  lines.push('');
  lines.push(isAssistantSession(session)
    ? '### When the task is done (success or failure)'
    : '### When the task is done (success or failure, must do this before deleting the running.flag below)');
  lines.push(`Merge branch \`${wt.branch}\` into the \`agent_smart_dev\` branch:`);
  lines.push('');
  lines.push('```bash');
  lines.push(`cd "${wtPath}"`);
  lines.push(`git add -A && git commit -m "task: ${wt.branch}" || true`);
  lines.push(`cd "${wt.root}"`);
  lines.push('git show-ref --verify --quiet refs/heads/agent_smart_dev || git branch agent_smart_dev');
  lines.push('git checkout agent_smart_dev');
  lines.push(`git merge "${wt.branch}"`);
  lines.push('```');
  lines.push('');
  lines.push('If the merge has conflicts, you must resolve all of them before completing the merge; after merging, re-run the tests to verify the requirements are met. If conflicts remain or tests fail, keep fixing → re-merging → re-testing, **until there are no conflicts and the tests pass**.');
  lines.push('When everything is done, try git push; if it fails due to authentication, that is fine, just skip it.');
  if (!isAssistantSession(session)) {
    lines.push(`Note: running.flag lives at the repo root \`${wt.root}/.imac/...\`, not inside the worktree — do not accidentally delete it when rebuilding/removing the worktree directory.`);
  }
  lines.push('');
}

function en_add_completion_flag_info(lines, session, project) {
  if (!(session && session.session_id && session.session_id !== '(待创建)')) return;
  if (isAssistantSession(session)) return;
  const flagRoot = (project && project.bind_path) ? project.bind_path : '.';
  const flagPath = `${flagRoot}/.imac/flags/${session.session_id}/running.flag`;
  lines.push('## Final step when the task is complete');
  lines.push(`When the task ultimately succeeds or ultimately fails, you must delete the marker file ${flagPath}. But do not give up easily — try every possible way to solve the problem until you are convinced you cannot continue.`);
}

function buildRandomEmojiPrefix() {
  const emojiCount = Math.random() < 0.5 ? 1 : 2;
  const pool = [...RANDOM_EMOJIS];
  const picked = [];

  for (let i = 0; i < emojiCount && pool.length > 0; i += 1) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }

  return `${picked.join('')}\n`;
}

const ADD_FNS = {
  zh: {
    header: zh_add_header,
    user: zh_add_user_level_info,
    project: zh_add_project_level_info,
    research: zh_add_research_level_info,
    researchBlackboard: zh_add_research_blackboard_info,
    researchPeer: zh_add_research_peer_info,
    memory: zh_add_memory_info,
    skill: zh_add_skill_info,
    worktree: zh_add_worktree_info,
    completionFlag: zh_add_completion_flag_info,
    issue: zh_add_issue_level_info,
    session: zh_add_session_level_info,
  },
  en: {
    header: en_add_header,
    user: en_add_user_level_info,
    project: en_add_project_level_info,
    research: en_add_research_level_info,
    researchBlackboard: en_add_research_blackboard_info,
    researchPeer: en_add_research_peer_info,
    memory: en_add_memory_info,
    skill: en_add_skill_info,
    worktree: en_add_worktree_info,
    completionFlag: en_add_completion_flag_info,
    issue: en_add_issue_level_info,
    session: en_add_session_level_info,
  },
};

function formatBody({ user, project, issue, research, session, skills, memories, research_peers, language }) {
  const fns = ADD_FNS[normalizeLanguage(language)];
  const lines = [];
  fns.header(lines);
  fns.user(lines, user);
  fns.project(lines, project);
  fns.research(lines, research);
  fns.researchBlackboard(lines, research, session);
  fns.researchPeer(lines, research_peers);
  fns.memory(lines, memories);
  fns.skill(lines, skills);
  fns.worktree(lines, issue, project, session);
  fns.completionFlag(lines, session, project);
  fns.issue(lines, issue);
  fns.session(lines, session);
  return `${buildRandomEmojiPrefix()}${lines.join('\n').trimEnd()}`;
}

function compactSkillForSnapshot(sk) {
  if (!sk || !sk.id) return null;
  const parsed = parseSkillId(sk.id);
  return {
    id: sk.id,
    scope: sk.scope,
    name: sk.name,
    description: sk.description || '',
    research_role: sk.research_role || '',
    dirName: sk.dirName || (parsed ? parsed.dirName : null),
    body: sk.body || '',
  };
}

function compactMemoryForSnapshot(m) {
  if (!m || !m.id) return null;
  return {
    id: m.id,
    scope: m.scope,
    name: m.name,
    description: m.description || '',
    body: m.body || '',
  };
}

function normalizeSelectionSnapshot(raw) {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const skills = Array.isArray(parsed.skills) ? parsed.skills.map(compactSkillForSnapshot).filter(Boolean) : [];
  const memories = Array.isArray(parsed.memories) ? parsed.memories.map(compactMemoryForSnapshot).filter(Boolean) : [];
  const allSkills = Array.isArray(parsed.all_skills)
    ? parsed.all_skills.map(item => {
      const sk = compactSkillForSnapshot(item);
      return sk ? { ...sk, enabled: item.enabled !== false } : null;
    }).filter(Boolean)
    : skills.map(sk => ({ ...sk, enabled: true }));
  const allMemories = Array.isArray(parsed.all_memories)
    ? parsed.all_memories.map(item => {
      const memory = compactMemoryForSnapshot(item);
      return memory ? { ...memory, enabled: item.enabled !== false } : null;
    }).filter(Boolean)
    : memories.map(memory => ({ ...memory, enabled: true }));
  const totals = parsed.totals && typeof parsed.totals === 'object' ? {
    skills: Number.isFinite(Number(parsed.totals.skills)) ? Number(parsed.totals.skills) : skills.length,
    memories: Number.isFinite(Number(parsed.totals.memories)) ? Number(parsed.totals.memories) : memories.length,
  } : { skills: allSkills.length, memories: allMemories.length };
  return {
    version: parsed.version || 1,
    skills,
    memories,
    all_skills: allSkills,
    all_memories: allMemories,
    totals,
    excluded_skill_ids: Array.isArray(parsed.excluded_skill_ids) ? parsed.excluded_skill_ids.filter(x => typeof x === 'string') : [],
    excluded_memory_ids: Array.isArray(parsed.excluded_memory_ids) ? parsed.excluded_memory_ids.filter(x => typeof x === 'string') : [],
  };
}

function parseJsonObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseStoredIdArray(raw) {
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string' && x.length > 0);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

function uniqueAllowedIds(ids, allowedIds) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (allowedIds && !allowedIds.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildSelectionSnapshotFromSources(selectedSources, totalSources, excludedSkillIds, excludedMemoryIds) {
  const selected = selectedSources || {};
  const total = totalSources || selected;
  const skills = Array.isArray(selected.skills) ? selected.skills.map(compactSkillForSnapshot).filter(Boolean) : [];
  const memories = Array.isArray(selected.memories) ? selected.memories.map(compactMemoryForSnapshot).filter(Boolean) : [];
  const enabledSkillIds = new Set(skills.map(sk => sk.id));
  const enabledMemoryIds = new Set(memories.map(memory => memory.id));
  const allSkills = (Array.isArray(total.skills) ? total.skills : skills)
    .map(compactSkillForSnapshot)
    .filter(Boolean)
    .map(sk => ({ ...sk, enabled: enabledSkillIds.has(sk.id) }));
  const allMemories = (Array.isArray(total.memories) ? total.memories : memories)
    .map(compactMemoryForSnapshot)
    .filter(Boolean)
    .map(memory => ({ ...memory, enabled: enabledMemoryIds.has(memory.id) }));
  return {
    version: 1,
    skills,
    memories,
    all_skills: allSkills,
    all_memories: allMemories,
    totals: { skills: allSkills.length, memories: allMemories.length },
    excluded_skill_ids: Array.isArray(excludedSkillIds) ? excludedSkillIds : [],
    excluded_memory_ids: Array.isArray(excludedMemoryIds) ? excludedMemoryIds : [],
  };
}

function getProjectUserContextWhitelist(projectId, user) {
  if (!projectId || !user?.id) return { skill_ids: null, memory_ids: null };
  try {
    return Projects.getUserContextWhitelist(projectId, user.id);
  } catch (e) {
    console.warn(`[session-context] load project user context whitelist failed (${projectId}/${user.id}): ${e.message}`);
    return { skill_ids: null, memory_ids: null };
  }
}

function filterUserLevelByWhitelist(items, whitelistIds) {
  if (!Array.isArray(whitelistIds)) return items;
  const allowed = new Set(whitelistIds);
  return (Array.isArray(items) ? items : []).filter(item => item.scope !== 'user' || allowed.has(item.id));
}

function filterBuiltinByWhitelist(items, whitelistIds) {
  if (!Array.isArray(whitelistIds)) return items;
  const allowed = new Set(whitelistIds);
  return (Array.isArray(items) ? items : []).filter(item => item.scope !== 'builtin' || allowed.has(item.id));
}

function shapeSkillForContext(s) {
  const parsed = parseSkillId(s.id);
  return {
    id: s.id,
    scope: s.scope,
    name: s.name,
    description: s.description,
    research_role: s.research_role || '',
    body: s.body || '',
    dirName: parsed ? parsed.dirName : null,
  };
}

function listUserProjectContextSkills(user, projectId) {
  const userWhitelist = getProjectUserContextWhitelist(projectId, user);
  const readable = filterReadableContextItems(
    user,
    'skill',
    user && projectId ? Skills.listForIssue(user.id, projectId) : [],
  );
  return filterUserLevelByWhitelist(readable, userWhitelist.skill_ids);
}

function listBuiltinContextSkills(user, projectId) {
  const userWhitelist = getProjectUserContextWhitelist(projectId, user);
  return filterBuiltinByWhitelist(
    Skills.listBuiltin(),
    userWhitelist.builtin_skill_ids,
  );
}

const ARCHITECTURE_ISSUE_TITLE = '项目结构绘制';
const ARCHITECTURE_REQUIRED_BUILTIN_SKILL_ID = 'builtin:mobius-architecture-draw';
const ASSISTANT_ISSUE_TITLE = '小莫对话';
const ASSISTANT_REQUIRED_BUILTIN_SKILL_ID = 'builtin:mobius-assistant';
// 拓展项目 (project.kind === 'extension') 的所有 Session 强制必选 mobius-extension skill,
// 保证 agent 始终带上拓展开发协议 (handler / SDK / 目录规范) 上下文.
const EXTENSION_REQUIRED_BUILTIN_SKILL_ID = 'builtin:mobius-extension';
// 系统宏观规划 Issue (is_planning=1) 的所有 Session 强制必选 mobius-planner skill,
// 保证 agent 严格遵守"只读写 project_knowledge.md, 严禁动代码"的协议.
const PLANNING_REQUIRED_BUILTIN_SKILL_ID = 'builtin:mobius-planner';

function forcedIssueSkillIds(issue, project) {
  const ids = new Set();
  if (issue?.title === ARCHITECTURE_ISSUE_TITLE) ids.add(ARCHITECTURE_REQUIRED_BUILTIN_SKILL_ID);
  if (issue?.title === ASSISTANT_ISSUE_TITLE) ids.add(ASSISTANT_REQUIRED_BUILTIN_SKILL_ID);
  if (project?.kind === 'extension') ids.add(EXTENSION_REQUIRED_BUILTIN_SKILL_ID);
  if (issue?.is_planning) ids.add(PLANNING_REQUIRED_BUILTIN_SKILL_ID);
  return ids;
}

function forcedResearchSkillIds(project) {
  const ids = new Set();
  if (project?.kind === 'extension') ids.add(EXTENSION_REQUIRED_BUILTIN_SKILL_ID);
  return ids;
}

// 共用部分: 从 issue + project 计算 skill / memory 列表, 不依赖 session.
// sessionExclusions = { skills: [id...], memories: [id...] } 可选, 在 issue 默认集合上再做减法.
function gatherIssueSources(user, issue, sessionExclusions) {
  const projectId = issue ? issue.project_id : null;
  const project = projectId ? Projects.findById(projectId) : null;
  const userWhitelist = getProjectUserContextWhitelist(projectId, user);
  const forcedSkillSet = forcedIssueSkillIds(issue, project);

  let skillSelected = [], skillExcluded = [];
  if (issue) {
    try { skillSelected = JSON.parse(issue.selected_skills || '[]'); } catch {}
    try { skillExcluded = JSON.parse(issue.excluded_skills || '[]'); } catch {}
    if (!Array.isArray(skillSelected)) skillSelected = [];
    if (!Array.isArray(skillExcluded)) skillExcluded = [];
  }

  const exSkillSet = new Set(sessionExclusions && Array.isArray(sessionExclusions.skills) ? sessionExclusions.skills : []);
  const exMemSet = new Set(sessionExclusions && Array.isArray(sessionExclusions.memories) ? sessionExclusions.memories : []);

  let effectiveSkills = [];
  if (issue && projectId && user) {
    const userProjectSkills = resolveEffectiveSkills(
      listUserProjectContextSkills(user, projectId),
      { selected: skillSelected, excluded: skillExcluded },
    );
    let builtinSkills = listBuiltinContextSkills(user, projectId);
    for (const id of forcedSkillSet) {
      if (!builtinSkills.some(s => s.id === id) && !userProjectSkills.some(s => s.id === id)) {
        const forced = Skills.findById(id);
        if (forced) builtinSkills = [...builtinSkills, forced];
      }
    }
    effectiveSkills = [...userProjectSkills, ...builtinSkills]
      .filter(s => forcedSkillSet.has(s.id) || !exSkillSet.has(s.id))
      .map(shapeSkillForContext);
  }

  let effectiveMemories = [];
  try {
    const userMemories = filterUserLevelByWhitelist(
      user ? Memories.listForUser(user.id) : [],
      userWhitelist.memory_ids,
    );
    const projectMemories = projectId ? filterReadableContextItems(user, 'memory', Memories.listForProject(projectId)) : [];
    effectiveMemories = [...userMemories, ...projectMemories]
      .filter(m => !exMemSet.has(m.id))
      .map(m => ({
        id: m.id,
        scope: m.scope,
        name: m.name,
        description: m.description,
        body: m.body || '',
      }));
  } catch (e) {
    effectiveMemories = [];
  }

  return {
    user: user ? { id: user.id, display_name: user.display_name, role: user.role } : null,
    project: project ? { id: project.id, name: project.name, description: project.description || '', bind_path: project.bind_path || '' } : null,
    issue: issue ? {
      id: issue.id, title: issue.title, description: issue.description || '', status: issue.status,
      selected_skills: skillSelected, excluded_skills: skillExcluded,
      use_worktree: !!issue.use_worktree,
      worktree_branch: (issue.worktree_branch || '').trim() || issue.id,
    } : null,
    skills: effectiveSkills,
    memories: effectiveMemories,
  };
}

// Research 复用项目级 + 用户级 Skill/Memory, 不引入 research 级 overrides.
function gatherResearchSources(user, research, sessionExclusions) {
  const projectId = research ? research.project_id : null;
  const project = projectId ? Projects.findById(projectId) : null;
  const userWhitelist = getProjectUserContextWhitelist(projectId, user);
  const forcedSkillSet = forcedResearchSkillIds(project);
  const exSkillSet = new Set(sessionExclusions && Array.isArray(sessionExclusions.skills) ? sessionExclusions.skills : []);
  const exMemSet = new Set(sessionExclusions && Array.isArray(sessionExclusions.memories) ? sessionExclusions.memories : []);

  let effectiveSkills = [];
  if (research && projectId && user) {
    const userProjectSkills = resolveEffectiveSkills(
      listUserProjectContextSkills(user, projectId),
      { selected: [], excluded: [] },
    );
    let builtinSkills = listBuiltinContextSkills(user, projectId);
    for (const id of forcedSkillSet) {
      if (!builtinSkills.some(s => s.id === id) && !userProjectSkills.some(s => s.id === id)) {
        const forced = Skills.findById(id);
        if (forced) builtinSkills = [...builtinSkills, forced];
      }
    }
    effectiveSkills = [...userProjectSkills, ...builtinSkills]
      .filter(s => forcedSkillSet.has(s.id) || !exSkillSet.has(s.id))
      .map(shapeSkillForContext);
  }

  let effectiveMemories = [];
  try {
    const userMemories = filterUserLevelByWhitelist(
      user ? Memories.listForUser(user.id) : [],
      userWhitelist.memory_ids,
    );
    const projectMemories = projectId ? filterReadableContextItems(user, 'memory', Memories.listForProject(projectId)) : [];
    effectiveMemories = [...userMemories, ...projectMemories]
      .filter(m => !exMemSet.has(m.id))
      .map(m => ({
        id: m.id,
        scope: m.scope,
        name: m.name,
        description: m.description,
        body: m.body || '',
      }));
  } catch (e) {
    effectiveMemories = [];
  }

  return {
    user: user ? { id: user.id, display_name: user.display_name, role: user.role } : null,
    project: project ? { id: project.id, name: project.name, description: project.description || '', bind_path: project.bind_path || '' } : null,
    research: research ? {
      id: research.id,
      title: research.title,
      description: research.description || '',
      status: research.status,
      project_id: research.project_id,
    } : null,
    skills: effectiveSkills,
    memories: effectiveMemories,
  };
}

function gatherSources(user, sessionId) {
  const session = Sessions.findById(sessionId);
  if (!session) return null;
  const storedSelection = normalizeSelectionSnapshot(session.session_selection_snapshot);

  // 读 session 自身的勾选状态 (Wizard 第二步取消的 skill/memory id 列表).
  let exSkills = [], exMemories = [];
  try { exSkills = JSON.parse(session.session_excluded_skills || '[]'); } catch {}
  try { exMemories = JSON.parse(session.session_excluded_memories || '[]'); } catch {}
  if (!Array.isArray(exSkills)) exSkills = [];
  if (!Array.isArray(exMemories)) exMemories = [];

  if (session.scope_type === 'research') {
    const research = session.research_id ? Researches.findById(session.research_id) : null;
    const researchSources = gatherResearchSources(
      user,
      research,
      storedSelection ? { skills: [], memories: [] } : { skills: exSkills, memories: exMemories },
    );
    if (storedSelection) {
      researchSources.skills = storedSelection.skills;
      researchSources.memories = storedSelection.memories;
      researchSources.selection_totals = storedSelection.totals;
      researchSources.selection_excluded_skill_ids = storedSelection.excluded_skill_ids;
      researchSources.selection_excluded_memory_ids = storedSelection.excluded_memory_ids;
    }
    const peers = research?.id
      ? Sessions.listAllByResearch(research.id)
        .filter(s => s.session_id !== session.session_id)
        .map(s => ({
          session_id: s.session_id,
          name: s.name,
          status: s.status,
          research_role: s.research_role,
          created_at: s.created_at,
        }))
      : [];
    return {
      ...researchSources,
      research_peers: peers,
      language: normalizeLanguage(session.language),
      session: {
        session_id: session.session_id,
        session_key: session.session_key || '',
        user_id: session.user_id || '',
        name: session.name,
        description: session.description || '',
        status: session.status,
        research_role: session.research_role || '',
      },
    };
  }

  const issue = session.issue_id ? Issues.findById(session.issue_id) : null;
  const issueSources = gatherIssueSources(
    user,
    issue,
    storedSelection ? { skills: [], memories: [] } : { skills: exSkills, memories: exMemories },
  );
  if (storedSelection) {
    issueSources.skills = storedSelection.skills;
    issueSources.memories = storedSelection.memories;
    issueSources.selection_totals = storedSelection.totals;
    issueSources.selection_excluded_skill_ids = storedSelection.excluded_skill_ids;
    issueSources.selection_excluded_memory_ids = storedSelection.excluded_memory_ids;
  }
  return {
    ...issueSources,
    language: normalizeLanguage(session.language),
    session: {
      session_id: session.session_id,
      session_key: session.session_key || '',
      user_id: session.user_id || '',
      name: session.name,
      description: session.description || '',
      status: session.status,
    },
  };
}

function buildSessionContext(user, sessionId) {
  const sources = gatherSources(user, sessionId);
  if (!sources) return { body: '', sources: null, language: 'zh' };
  return { body: formatBody(sources), sources, language: normalizeLanguage(sources.language) };
}

// 新建 Session Wizard 用: 在 session 还没创建时, 用 issue + 输入框中的 name/desc + 勾选状态预览注入内容.
// excludedSkillIds / excludedMemoryIds: 用户在 Wizard Step 2 中取消勾选的 id 列表.
function buildIssueContextPreview(user, issueId, draftSession, excludedSkillIds, excludedMemoryIds, language) {
  const issue = Issues.findById(issueId);
  if (!issue) return { body: '', sources: null };
  const issueSources = gatherIssueSources(user, issue, {
    skills: Array.isArray(excludedSkillIds) ? excludedSkillIds : [],
    memories: Array.isArray(excludedMemoryIds) ? excludedMemoryIds : [],
  });
  const sources = {
    ...issueSources,
    language: normalizeLanguage(language),
    session: draftSession ? {
      session_id: '(待创建)',
      name: draftSession.name || '(未命名)',
      description: draftSession.description || '',
      status: 'active',
    } : null,
  };
  return { body: formatBody(sources), sources };
}

// 项目级 Session 预设用: 特殊 Issue 尚未创建时, 用一个草稿 issue 计算与普通
// Issue Session 一致的 skill/memory/context 预览, 但不落库。
function buildProjectIssueContextPreview(user, projectId, draftIssue, draftSession, excludedSkillIds, excludedMemoryIds, language) {
  const project = Projects.findById(projectId);
  if (!project) return { body: '', sources: null };
  const issue = {
    id: draftIssue?.id || '(待创建)',
    project_id: projectId,
    title: draftIssue?.title || '(待创建 Issue)',
    description: draftIssue?.description || '',
    status: draftIssue?.status || 'active',
    selected_skills: '[]',
    excluded_skills: '[]',
    use_worktree: 0,
    worktree_branch: '',
  };
  const issueSources = gatherIssueSources(user, issue, {
    skills: Array.isArray(excludedSkillIds) ? excludedSkillIds : [],
    memories: Array.isArray(excludedMemoryIds) ? excludedMemoryIds : [],
  });
  const sources = {
    ...issueSources,
    language: normalizeLanguage(language),
    session: draftSession ? {
      session_id: '(待创建)',
      name: draftSession.name || '(未命名)',
      description: draftSession.description || '',
      status: 'active',
    } : null,
  };
  return { body: formatBody(sources), sources };
}

function buildResearchContextPreview(user, researchId, draftSession, excludedSkillIds, excludedMemoryIds, language) {
  const research = Researches.findById(researchId);
  if (!research) return { body: '', sources: null };
  const researchSources = gatherResearchSources(user, research, {
    skills: Array.isArray(excludedSkillIds) ? excludedSkillIds : [],
    memories: Array.isArray(excludedMemoryIds) ? excludedMemoryIds : [],
  });
  const peers = Sessions.listAllByResearch(researchId).map(s => ({
    session_id: s.session_id,
    name: s.name,
    status: s.status,
    research_role: s.research_role,
    created_at: s.created_at,
  }));
  const sources = {
    ...researchSources,
    research_peers: peers,
    language: normalizeLanguage(language),
    session: draftSession ? {
      session_id: '(待创建)',
      name: draftSession.name || '(未命名)',
      description: draftSession.description || '',
      status: 'active',
      research_role: draftSession.role || 'research_assistant',
    } : null,
  };
  return { body: formatBody(sources), sources };
}

function buildSessionSelectionSnapshot(user, issueId, excludedSkillIds, excludedMemoryIds) {
  const selected = buildIssueContextPreview(user, issueId, null, excludedSkillIds, excludedMemoryIds).sources;
  const total = buildIssueContextPreview(user, issueId, null, [], []).sources;
  return buildSelectionSnapshotFromSources(selected, total, excludedSkillIds, excludedMemoryIds);
}

function buildResearchSessionSelectionSnapshot(user, researchId, excludedSkillIds, excludedMemoryIds) {
  const selected = buildResearchContextPreview(user, researchId, null, excludedSkillIds, excludedMemoryIds).sources;
  const total = buildResearchContextPreview(user, researchId, null, [], []).sources;
  return buildSelectionSnapshotFromSources(selected, total, excludedSkillIds, excludedMemoryIds);
}

function disabledIdsFromStoredSelection(storedSelection, rawSelection, allKey, excludedKey) {
  if (!storedSelection) return null;
  const rawAll = rawSelection && Array.isArray(rawSelection[allKey]) ? rawSelection[allKey] : null;
  if (rawAll && rawAll.length > 0) {
    return (Array.isArray(storedSelection[allKey]) ? storedSelection[allKey] : [])
      .filter(item => item && item.enabled === false)
      .map(item => item.id);
  }
  return Array.isArray(storedSelection[excludedKey]) ? storedSelection[excludedKey] : [];
}

function builtinSkillDefaultExclusions(currentSources, storedSelection) {
  const currentBuiltinIds = (currentSources?.skills || [])
    .filter(sk => sk && sk.scope === 'builtin')
    .map(sk => sk.id);
  if (!storedSelection) return currentBuiltinIds;
  const represented = new Set((storedSelection.all_skills || []).map(sk => sk.id));
  return currentBuiltinIds.filter(id => !represented.has(id));
}

// 新建 Session Wizard 默认勾选状态:
// 同一 Issue 下若已有非删除 Session, 继承最新创建 Session 的 skill/memory 勾选状态.
// 当前已不可用的 id 会被过滤; 新增的 skill/memory 默认保持勾选.
function buildIssueSelectionDefaults(user, issueId) {
  const issue = Issues.findById(issueId);
  if (!issue) return { inherited: false, source_session: null, excluded_skill_ids: [], excluded_memory_ids: [] };

  const currentSources = gatherIssueSources(user, issue, { skills: [], memories: [] });
  const currentSkillIds = new Set((currentSources.skills || []).map(sk => sk.id));
  const currentMemoryIds = new Set((currentSources.memories || []).map(memory => memory.id));

  const latest = Sessions.findLatestReusableSelectionForIssue(issueId);
  if (!latest) {
    return {
      inherited: false,
      source_session: null,
      excluded_skill_ids: uniqueAllowedIds(builtinSkillDefaultExclusions(currentSources, null), currentSkillIds),
      excluded_memory_ids: [],
    };
  }

  const rawSelection = parseJsonObject(latest.session_selection_snapshot);
  const storedSelection = normalizeSelectionSnapshot(rawSelection);
  const snapshotSkillExclusions = disabledIdsFromStoredSelection(storedSelection, rawSelection, 'all_skills', 'excluded_skill_ids');
  const snapshotMemoryExclusions = disabledIdsFromStoredSelection(storedSelection, rawSelection, 'all_memories', 'excluded_memory_ids');

  const excludedSkillIds = uniqueAllowedIds(
    [
      ...(snapshotSkillExclusions === null ? parseStoredIdArray(latest.session_excluded_skills) : snapshotSkillExclusions),
      ...builtinSkillDefaultExclusions(currentSources, storedSelection),
    ],
    currentSkillIds,
  );
  const excludedMemoryIds = uniqueAllowedIds(
    snapshotMemoryExclusions === null ? parseStoredIdArray(latest.session_excluded_memories) : snapshotMemoryExclusions,
    currentMemoryIds,
  );

  return {
    inherited: true,
    source_session: {
      session_id: latest.session_id,
      name: latest.name,
      created_at: latest.created_at,
      last_active: latest.last_active,
      selection_snapshot_at: latest.session_selection_snapshot_at || null,
    },
    excluded_skill_ids: excludedSkillIds,
    excluded_memory_ids: excludedMemoryIds,
  };
}

function buildResearchSelectionDefaults(user, researchId) {
  const research = Researches.findById(researchId);
  if (!research) return { inherited: false, source_session: null, excluded_skill_ids: [], excluded_memory_ids: [] };

  const currentSources = gatherResearchSources(user, research, { skills: [], memories: [] });
  const currentSkillIds = new Set((currentSources.skills || []).map(sk => sk.id));
  const currentMemoryIds = new Set((currentSources.memories || []).map(memory => memory.id));

  const latest = Sessions.findLatestReusableSelectionForResearch(researchId);
  if (!latest) {
    return {
      inherited: false,
      source_session: null,
      excluded_skill_ids: uniqueAllowedIds(builtinSkillDefaultExclusions(currentSources, null), currentSkillIds),
      excluded_memory_ids: [],
    };
  }

  const rawSelection = parseJsonObject(latest.session_selection_snapshot);
  const storedSelection = normalizeSelectionSnapshot(rawSelection);
  const snapshotSkillExclusions = disabledIdsFromStoredSelection(storedSelection, rawSelection, 'all_skills', 'excluded_skill_ids');
  const snapshotMemoryExclusions = disabledIdsFromStoredSelection(storedSelection, rawSelection, 'all_memories', 'excluded_memory_ids');

  const excludedSkillIds = uniqueAllowedIds(
    [
      ...(snapshotSkillExclusions === null ? parseStoredIdArray(latest.session_excluded_skills) : snapshotSkillExclusions),
      ...builtinSkillDefaultExclusions(currentSources, storedSelection),
    ],
    currentSkillIds,
  );
  const excludedMemoryIds = uniqueAllowedIds(
    snapshotMemoryExclusions === null ? parseStoredIdArray(latest.session_excluded_memories) : snapshotMemoryExclusions,
    currentMemoryIds,
  );

  return {
    inherited: true,
    source_session: {
      session_id: latest.session_id,
      name: latest.name,
      created_at: latest.created_at,
      last_active: latest.last_active,
      selection_snapshot_at: latest.session_selection_snapshot_at || null,
    },
    excluded_skill_ids: excludedSkillIds,
    excluded_memory_ids: excludedMemoryIds,
  };
}

function buildProjectIssueSelectionDefaults(user, projectId, draftIssue) {
  const project = Projects.findById(projectId);
  if (!project) return { inherited: false, source_session: null, excluded_skill_ids: [], excluded_memory_ids: [] };
  const issue = {
    id: draftIssue?.id || '(待创建)',
    project_id: projectId,
    title: draftIssue?.title || '(待创建 Issue)',
    description: draftIssue?.description || '',
    status: draftIssue?.status || 'active',
    selected_skills: '[]',
    excluded_skills: '[]',
    use_worktree: 0,
    worktree_branch: '',
  };
  const currentSources = gatherIssueSources(user, issue, { skills: [], memories: [] });
  const currentSkillIds = new Set((currentSources.skills || []).map(sk => sk.id));
  return {
    inherited: false,
    source_session: null,
    excluded_skill_ids: uniqueAllowedIds(builtinSkillDefaultExclusions(currentSources, null), currentSkillIds),
    excluded_memory_ids: [],
  };
}

function wrapUserMessage(body, userMessage, language) {
  if (!body) return userMessage;
  const heading = normalizeLanguage(language) === 'en' ? "## User's Question" : '## 用户的问题';
  return `${body}\n\n---\n\n${heading}\n${userMessage}`;
}

module.exports = {
  buildSessionContext,
  buildIssueContextPreview,
  buildProjectIssueContextPreview,
  buildSessionSelectionSnapshot,
  buildIssueSelectionDefaults,
  buildProjectIssueSelectionDefaults,
  buildResearchContextPreview,
  buildResearchSessionSelectionSnapshot,
  buildResearchSelectionDefaults,
  wrapUserMessage,
  gatherIssueSources,
};
