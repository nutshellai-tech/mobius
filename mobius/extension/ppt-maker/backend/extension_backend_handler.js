const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const { v4: uuid } = require('uuid');
const { loadUser } = require('../../../backend/services/extension-agent-bridge');
const { Projects } = require('../../../backend/repositories/projects');
const { Issues } = require('../../../backend/repositories/issues');
const { Sessions } = require('../../../backend/repositories/sessions');
const { buildSessionSelectionSnapshot } = require('../../../backend/services/session-context');
const modelRegistry = require('../../../backend/services/model-registry');
const modelPromptLimits = require('../../../backend/services/model-prompt-limits');

const EXTENSION_NAME = 'ppt-maker';
const EXTENSION_DISPLAY_NAME = 'PPT Maker';
const PPT_MASTER_REPO = 'https://github.com/hugohe3/ppt-master';
const PPT_MASTER_RAW_BASE = 'https://raw.githubusercontent.com/hugohe3/ppt-master/main/skills/ppt-master';
const EXPECTED_TABLER_OUTLINE_ICON_COUNT = 5039;
const RAW_REPAIR_LIMIT = 5;
const PPT_MASTER_PATCH_VERSION = '2026-06-13-visual-evidence-v1';
const MAX_TEXT_SOURCE_BYTES = 3 * 1024 * 1024;
const MAX_PROJECTS = 80;
const MAX_OUTPUTS = 80;
const MAX_TEMPLATE_ASSETS = 48;
const MAX_INLINE_ASSET_BYTES = 180 * 1024;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_ARTIFACT_PREVIEW_BYTES = 800 * 1024;
const SOURCE_DOC_EXTENSIONS = new Set(['.md', '.markdown']);
const TEXT_PREVIEW_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

const TEMPLATE_KIND_LABEL = {
  free: '自由设计',
  layout: '页面结构模板',
  deck: '完整风格模板',
  brand: '品牌视觉模板',
};

const FREE_TEMPLATE = {
  id: 'free',
  name: '自由设计',
  kind: 'free',
  kind_label: TEMPLATE_KIND_LABEL.free,
  summary: '不绑定模板，由 ppt-maker 根据材料和要求决定视觉方向。',
  template_path: '',
  template_rel_path: '',
  primary_color: '#2563EB',
  page_count: null,
  canvas_format: '',
};

const TEMPLATE_DISPLAY_META = {
  academic_defense: {
    name: '学术答辩风格',
    summary: '适合论文答辩、科研进展、课题申请和学术交流。',
  },
  medical_university: {
    name: '医疗健康风格',
    summary: '适合医学报告、病例讨论、科研汇报和教学培训。',
  },
  重庆大学: {
    name: '科研报告风格',
    summary: '适合正式学术汇报、课程展示和研究成果交流。',
  },
  ai_ops: {
    name: '科技产品风格 1',
    summary: '适合技术方案、系统架构、数字化转型和智能基础设施汇报。',
  },
  pixel_retro: {
    name: '创意复古风格',
    summary: '适合技术分享、编程课程、游戏主题和轻松展示。',
  },
  psychology_attachment: {
    name: '教育培训风格',
    summary: '适合心理课程、专业培训、案例分析和知识分享。',
  },
  government_blue: {
    name: '政务汇报风格 1',
    summary: '适合重点项目汇报、政策解读、工作总结和招商介绍。',
  },
  government_red: {
    name: '政务汇报风格 2',
    summary: '适合正式汇报、组织介绍、工作总结和项目推进材料。',
  },
  中国电信: {
    name: '商务汇报风格 1',
    summary: '适合政企数字化方案、转型规划、产品介绍和内部汇报。',
  },
  中国电建_常规: {
    name: '工程建设风格 1',
    summary: '适合工程项目报告、技术方案、商务洽谈和年度总结。',
  },
  中国电建_现代: {
    name: '工程建设风格 2',
    summary: '适合大型工程汇报、国际市场推广和高端商务展示。',
  },
  中汽研_商务: {
    name: '科技产品风格 2',
    summary: '适合产品认证展示、测评汇报、技术推广和商务报告。',
  },
  中汽研_常规: {
    name: '科技产品风格 3',
    summary: '适合产品认证展示、测评说明、技术推广和业务来访材料。',
  },
  中汽研_现代: {
    name: '品牌发布风格 1',
    summary: '适合前沿技术展示、战略发布和高端业务汇报。',
  },
  招商银行: {
    name: '金融商务风格',
    summary: '适合金融产品介绍、客户案例、销售方案和培训材料。',
  },
  anthropic: {
    name: '科技产品风格 4',
    summary: '适合人工智能、开发者活动、技术培训和产品发布。',
  },
  google: {
    name: '品牌发布风格 2',
    summary: '适合多产品介绍、开发者活动、教育培训和生态展示。',
  },
};

const REQUIRED_SKILL_FILES = [
  'SKILL.md',
  'scripts/project_manager.py',
  'scripts/source_to_md/doc_to_md.py',
  'scripts/source_to_md/pdf_to_md.py',
  'scripts/source_to_md/web_to_md.py',
  'scripts/svg_to_pptx.py',
  'templates/layouts/layouts_index.json',
  'templates/decks/decks_index.json',
  'workflows/topic-research.md',
  'workflows/template-fill-pptx.md',
];

function nowIso() {
  return new Date().toISOString();
}

function safeUserSegment(username) {
  return String(username || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function slugify(value, fallback = 'ppt') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || fallback).slice(0, 80);
}

function trimText(value, max = 800) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function sanitizeFilename(name, fallback = 'source.md') {
  const base = path.basename(String(name || fallback)).replace(/[^\w\u4e00-\u9fff .@()+,-]/g, '_').trim();
  return (base || fallback).slice(0, 180);
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeSourceUrls(value) {
  return ensureArray(value)
    .flatMap((item) => String(item || '').split(/[\n,，;；]+/))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

const SOURCE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/[),.;，。；、）]+$/g, '');
}

function urlsFromUrlOnlyLine(line) {
  const candidate = String(line || '')
    .trim()
    .replace(/^([-*+]\s+|\d+[.)]\s+)/, '')
    .trim();
  if (!candidate) return [];
  const urls = (candidate.match(SOURCE_URL_RE) || []).map(normalizeSourceUrl).filter(Boolean);
  if (!urls.length) return [];
  const remainder = candidate
    .replace(SOURCE_URL_RE, '')
    .replace(/[\s,，;；、|]+/g, '')
    .trim();
  return remainder ? [] : urls;
}

function urlsFromLine(line) {
  return (String(line || '').match(SOURCE_URL_RE) || [])
    .map(normalizeSourceUrl)
    .filter(Boolean);
}

function splitMixedSourceInput(value) {
  const urls = [];
  const seen = new Set();
  const markdownLines = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const urlOnlyLineUrls = urlsFromUrlOnlyLine(line);
    const lineUrls = urlOnlyLineUrls.length ? urlOnlyLineUrls : urlsFromLine(line);
    for (const url of lineUrls) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    if (urlOnlyLineUrls.length) {
      continue;
    }
    markdownLines.push(line);
  }
  return {
    sourceUrls: urls.slice(0, 20),
    inlineMarkdown: markdownLines.join('\n').trim(),
  };
}

function mergeSourceInputs(payload) {
  const mixed = splitMixedSourceInput(payload.source_input || payload.sourceInput || '');
  const explicitUrls = normalizeSourceUrls(payload.source_urls || payload.sourceUrls || payload.url || payload.urls);
  const urlSeen = new Set();
  const sourceUrls = [...mixed.sourceUrls, ...explicitUrls]
    .map(normalizeSourceUrl)
    .filter((url) => {
      if (!url || urlSeen.has(url)) return false;
      urlSeen.add(url);
      return true;
    })
    .slice(0, 20);
  const explicitMarkdown = typeof payload.markdown === 'string' ? payload.markdown : '';
  const parts = [mixed.inlineMarkdown, explicitMarkdown].map((item) => String(item || '').trim()).filter(Boolean);
  return {
    sourceUrls,
    inlineMarkdown: parts.join(parts.length > 1 ? '\n\n' : ''),
  };
}

function safeResolve(root, ...parts) {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path escapes extension data dir');
  }
  return abs;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst) {
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.venv') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

function userRoot(extDataDir, username) {
  return safeResolve(extDataDir, 'users', safeUserSegment(username));
}

function userUploadRoot(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'uploads');
}

function sharedSourceRoot(extDataDir) {
  return safeResolve(extDataDir, 'source', 'ppt-master');
}

function sharedCommitPath(extDataDir) {
  return safeResolve(extDataDir, 'source', 'ppt-master.commit');
}

function userSkillRoot(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'skills', 'ppt-master');
}

function userLastSyncedCommitPath(extDataDir, username) {
  return safeResolve(userSkillRoot(extDataDir, username), '.last_synced_commit');
}

function statePath(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'state.json');
}

async function readState(extDataDir, username) {
  const fallback = { version: 1, uploads: [], projects: [], updated_at: null };
  const state = await readJson(statePath(extDataDir, username), fallback);
  state.version = 1;
  state.uploads = Array.isArray(state.uploads) ? state.uploads : [];
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  return state;
}

async function saveState(extDataDir, username, state) {
  state.updated_at = nowIso();
  await writeJson(statePath(extDataDir, username), state);
  return state;
}

function shapeUpload(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    size: item.size || 0,
    mime_type: item.mime_type || '',
    created_at: item.created_at,
  };
}

function shapeProject(project) {
  if (!project) return null;
  const outputUrl = project.output_url || project.download_url || '';
  const sourceCount = Array.isArray(project.sources) ? project.sources.length : Number(project.source_count || 0) || 0;
  return {
    id: project.id,
    name: project.name || project.topic || project.id || '',
    topic: project.topic || '',
    template: project.template || 'free',
    template_name: project.template_name || (project.template === 'free' ? FREE_TEMPLATE.name : project.template || ''),
    template_kind: project.template_kind || '',
    template_kind_label: project.template_kind_label || '',
    template_path: project.template_path || '',
    template_rel_path: project.template_rel_path || '',
    format: project.format || '',
    notes: project.notes || '',
    workflow_hint: project.workflow_hint || '',
    status: project.status || 'unknown',
    progress: project.progress || 0,
    hidden_from_main: Boolean(project.hidden_from_main),
    hidden_at: project.hidden_at || '',
    created_at: project.created_at,
    updated_at: project.updated_at,
    project_dir: project.project_dir || '',
    output_path: project.output_path || '',
    download_url: outputUrl,
    output_url: outputUrl,
    output_size: project.output_size || 0,
    page_count: project.page_count || null,
    source_kind: project.source_kind || '',
    session_payload_path: project.session_payload_path || '',
    session_url: project.session_url || '',
    session_id: project.session_id || '',
    issue_id: project.issue_id || '',
    error: project.error || '',
    source_count: sourceCount,
    artifacts: project.artifacts || null,
  };
}

function downloadPath(absPath) {
  return `/api/download?path=${encodeURIComponent(absPath)}`;
}

function relProjectPath(projectDir, filePath) {
  return path.relative(projectDir, filePath).replace(/\\/g, '/');
}

function artifactMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pptx') return PPTX_MIME;
  return 'application/octet-stream';
}

async function artifactFromFile(projectDir, filePath, extras = {}) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const relPath = relProjectPath(projectDir, filePath);
    return {
      id: relPath,
      name: path.basename(filePath),
      rel_path: relPath,
      path: filePath,
      size: stat.size,
      updated_at: stat.mtime.toISOString(),
      download_url: downloadPath(filePath),
      mime_type: artifactMime(filePath),
      ...extras,
    };
  } catch {
    return null;
  }
}

async function listFilesRecursive(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 4;
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fp, depth + 1);
      else if (entry.isFile()) out.push(fp);
    }
  }
  await walk(root, 0);
  return out;
}

function sourceDocLabel(relPath) {
  const base = path.basename(relPath);
  if (base === 'inline-source.md') return '用户粘贴材料';
  if (base === 'source-urls.md') return 'URL 源材料清单';
  if (/topic|research/i.test(relPath)) return '主题研究材料';
  return '源材料 Markdown';
}

function sourceDocPriority(item) {
  const rel = item.rel_path || '';
  const base = path.basename(rel);
  if (base === 'inline-source.md') return 0;
  if (base === 'source-urls.md') return 1;
  if (/topic|research/i.test(rel)) return 2;
  return 3;
}

function flattenImageSourceEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.images)) return raw.images;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.sources)) return raw.sources;
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => (
      value && typeof value === 'object' ? { image_key: key, ...value } : { image_key: key, value }
    ));
  }
  return [];
}

function pickImageSourceInfo(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const fileKey = path.basename(String(
    entry.filename || entry.file || entry.path || entry.output || entry.name || entry.image || entry.image_key || '',
  ));
  if (!fileKey) return null;
  return {
    fileKey,
    source_url: String(entry.source_url || entry.page_url || entry.url || entry.source || entry.origin || '').trim(),
    purpose: trimText(entry.purpose || entry.usage || entry.recommended_slide || entry.slide || entry.caption || entry.description || entry.alt || '', 180),
    credit: trimText(entry.credit || entry.author || entry.provider || entry.license || entry.rights || '', 140),
  };
}

async function readImageSourceMap(imagesDir) {
  const candidates = ['image_sources.json', 'image_manifest.json'];
  const byName = new Map();
  for (const name of candidates) {
    const filePath = path.join(imagesDir, name);
    const raw = await readJson(filePath, null);
    if (!raw) continue;
    for (const entry of flattenImageSourceEntries(raw)) {
      const info = pickImageSourceInfo(entry);
      if (!info) continue;
      byName.set(info.fileKey, info);
    }
  }
  return byName;
}

async function buildProjectArtifacts(projectDir) {
  const outputPath = path.join(projectDir, 'output.pptx');
  const output = await artifactFromFile(projectDir, outputPath, {
    kind: 'pptx',
    label: 'PPTX 成品',
    preview_kind: 'pptx',
  });

  const sourcesDir = path.join(projectDir, 'sources');
  const sourceFiles = (await listFilesRecursive(sourcesDir, { maxDepth: 5 }))
    .filter((filePath) => SOURCE_DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const sources = [];
  for (const filePath of sourceFiles) {
    const relPath = relProjectPath(projectDir, filePath);
    const item = await artifactFromFile(projectDir, filePath, {
      kind: 'source_markdown',
      label: sourceDocLabel(relPath),
      preview_kind: 'text',
    });
    if (item) sources.push(item);
  }
  sources.sort((a, b) => sourceDocPriority(a) - sourceDocPriority(b)
    || a.rel_path.localeCompare(b.rel_path, undefined, { numeric: true, sensitivity: 'base' }));

  const designSpec = await artifactFromFile(projectDir, path.join(projectDir, 'design_spec.md'), {
    kind: 'design_spec',
    label: '设计方案 / 大纲',
    preview_kind: 'text',
  });

  const notesDir = path.join(projectDir, 'notes');
  const noteFiles = (await listFilesRecursive(notesDir, { maxDepth: 2 }))
    .filter((filePath) => SOURCE_DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const notes = [];
  for (const filePath of noteFiles) {
    const relPath = relProjectPath(projectDir, filePath);
    const item = await artifactFromFile(projectDir, filePath, {
      kind: 'speaker_notes',
      label: path.basename(filePath) === 'total.md' ? '完整讲稿 / 备注' : '分页讲稿 / 备注',
      preview_kind: 'text',
      sort_priority: path.basename(filePath) === 'total.md' ? 0 : 1,
      display_name: path.basename(filePath) === 'total.md' ? 'total.md' : relPath.replace(/^notes\//, ''),
    });
    if (item) notes.push(item);
  }
  notes.sort((a, b) => (a.sort_priority || 0) - (b.sort_priority || 0)
    || a.rel_path.localeCompare(b.rel_path, undefined, { numeric: true, sensitivity: 'base' }));

  const imagesDir = path.join(projectDir, 'images');
  const imageSourceMap = await readImageSourceMap(imagesDir);
  const imageFiles = (await listFilesRecursive(imagesDir, { maxDepth: 2 }))
    .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const images = [];
  for (const filePath of imageFiles) {
    const base = path.basename(filePath);
    const info = imageSourceMap.get(base) || null;
    const item = await artifactFromFile(projectDir, filePath, {
      kind: 'image_asset',
      label: '图片素材',
      preview_kind: 'image',
      source_url: info?.source_url || '',
      purpose: info?.purpose || '',
      credit: info?.credit || '',
    });
    if (item) images.push(item);
  }
  images.sort((a, b) => a.rel_path.localeCompare(b.rel_path, undefined, { numeric: true, sensitivity: 'base' }));

  const advancedCandidates = [
    ['request.md', '生成请求'],
    ['spec_lock.md', '执行锁定文件'],
    ['session-payload.json', 'Session 启动载荷'],
    ['output.pptx.trace.json', 'PPTX 导出追踪'],
    ['README.md', '项目说明'],
  ];
  const advanced = [];
  for (const [relPath, label] of advancedCandidates) {
    const filePath = path.join(projectDir, relPath);
    const ext = path.extname(filePath).toLowerCase();
    const item = await artifactFromFile(projectDir, filePath, {
      kind: 'advanced_file',
      label,
      preview_kind: TEXT_PREVIEW_EXTENSIONS.has(ext) || ext === '.json' ? 'text' : '',
    });
    if (item) advanced.push(item);
  }

  return {
    output,
    sources,
    design_spec: designSpec,
    notes,
    images,
    advanced,
  };
}

function normalizeProjectStatus({ hasOutput, stateProject, session }) {
  if (hasOutput) return 'completed';
  const raw = String(stateProject?.status || '').trim();
  if (raw === 'session_failed') return 'session_failed';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'completed') return 'failed';
  if (raw === 'processing') {
    return session?.agent_status === 'running' ? 'processing' : 'failed';
  }
  if (session?.agent_status === 'running') return 'processing';
  if (stateProject?.session_id || stateProject?.session_url) return 'failed';
  return 'unknown';
}

function normalizeProjectError({ hasOutput, stateProject, status }) {
  if (hasOutput) return '';
  if (stateProject?.error) return stateProject.error;
  if (status === 'session_failed') return '生成 Session 启动失败';
  if (status === 'failed') return '未找到 output.pptx，生成可能已停止或失败';
  return '';
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slideXmlText(text, x, y, w, h, fontSize = 2400, color = '202124', bold = false) {
  const lines = String(text || '').split('\n').slice(0, 10);
  const paragraphs = lines.map((line) => `
        <a:p>
          <a:r>
            <a:rPr lang="zh-CN" sz="${fontSize}"${bold ? ' b="1"' : ''}>
              <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
            </a:rPr>
            <a:t>${escapeXml(line || ' ')}</a:t>
          </a:r>
        </a:p>`).join('');
  return `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${Math.floor(Math.random() * 100000) + 10}" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
        <a:ln><a:noFill/></a:ln>
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0"/>
        <a:lstStyle/>
        ${paragraphs}
      </p:txBody>
    </p:sp>`;
}

function slideXmlShape(x, y, w, h, fill, line = fill, radius = false) {
  return `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${Math.floor(Math.random() * 100000) + 10}" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
        <a:prstGeom prst="${radius ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>
        <a:ln><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>
      </p:spPr>
    </p:sp>`;
}

function buildSlideXml({ title, subtitle, bullets, footer, accent = '2563EB', index = 1 }) {
  const bulletText = (bullets || []).slice(0, 6).map((b) => `• ${trimText(b, 120)}`).join('\n');
  const isCover = index === 1;
  const shapes = [
    slideXmlShape(0, 0, 12192000, 6858000, 'F8FAFC', 'F8FAFC'),
    slideXmlShape(0, 0, 12192000, 520000, accent, accent),
    slideXmlShape(520000, 1320000, 50000, 3850000, accent, accent),
  ];
  if (isCover) {
    shapes.push(slideXmlShape(8150000, 1380000, 2450000, 2450000, 'E0ECFF', 'C7D2FE', true));
    shapes.push(slideXmlShape(9140000, 2370000, 720000, 720000, accent, accent, true));
  } else {
    shapes.push(slideXmlShape(7900000, 1280000, 2900000, 3850000, 'EEF2FF', 'C7D2FE', true));
  }
  const text = [
    slideXmlText(title, 820000, isCover ? 1560000 : 960000, isCover ? 6900000 : 6200000, 900000, isCover ? 4000 : 3200, '111827', true),
    slideXmlText(subtitle, 840000, isCover ? 2640000 : 1780000, isCover ? 6800000 : 5900000, 900000, isCover ? 1900 : 1700, '475569'),
    slideXmlText(bulletText, 900000, isCover ? 3700000 : 2750000, 6500000, 2100000, 1700, '1F2937'),
    slideXmlText(footer || `Generated by PPT Maker · slide ${index}`, 820000, 6200000, 7600000, 300000, 1100, '64748B'),
  ];
  if (!isCover) {
    text.push(slideXmlText('PPT Maker', 8350000, 1710000, 2100000, 360000, 1800, accent, true));
    text.push(slideXmlText('完整生成流程\n由 ppt-maker skill 生成', 8350000, 2280000, 2100000, 1000000, 1450, '475569'));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join('\n')}
      ${text.join('\n')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, compressed,
    ]);
    locals.push(local);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(centralStart), u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

function relsXml(targets) {
  const rels = targets.map((target, i) => `<Relationship Id="rId${i + 1}" Type="${target.type}" Target="${target.target}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function buildPptxBuffer(slides) {
  const slideCount = slides.length;
  const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  const presentationRels = [
    { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((_, i) => ({ type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${i + 1}.xml` })),
    { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: 'theme/theme1.xml' },
  ];
  const overrides = slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${overrides}
</Types>`,
    },
    { name: '_rels/.rels', data: relsXml([
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'ppt/presentation.xml' },
      { type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', target: 'docProps/app.xml' },
    ]) },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
    },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presentationRels) },
    {
      name: 'ppt/slideMasters/slideMaster1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`,
    },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml([
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' },
    ]) },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
    },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relsXml([
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' },
    ]) },
    {
      name: 'ppt/theme/theme1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PPT Maker">
  <a:themeElements>
    <a:clrScheme name="PPT Maker"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="475569"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="PPT Maker"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="PPT Maker"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>PPT Maker Output</dc:title><dc:creator>Mobius PPT Maker</dc:creator><cp:lastModifiedBy>Mobius PPT Maker</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${nowIso()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso()}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Mobius PPT Maker</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slideCount}</Slides></Properties>`,
    },
  ];
  slides.forEach((slide, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slide });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: relsXml([
      { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    ]) });
  });
  return makeZip(files);
}

function summarizeMarkdown(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter((line) => /^#{1,4}\s+/.test(line)).map((line) => line.replace(/^#{1,4}\s+/, '').trim());
  const bullets = lines
    .filter((line) => /^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^([-*+]|\d+[.)])\s+/, '').trim());
  const paragraphs = lines.filter((line) => !/^#{1,4}\s+/.test(line) && !/^([-*+]|\d+[.)])\s+/.test(line));
  return {
    headings,
    bullets,
    paragraphs,
    excerpt: trimText(paragraphs.join(' '), 900),
  };
}

function normalizePageCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

async function readTextSource(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_TEXT_SOURCE_BYTES) return '';
  const ext = path.extname(filePath).toLowerCase();
  if (!['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.htm'].includes(ext)) return '';
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function templateRelPath(kind, id) {
  const root = kind === 'brand'
    ? path.join('templates', 'brands')
    : kind === 'deck'
      ? path.join('templates', 'decks')
      : path.join('templates', 'layouts');
  return path.join(root, id).replace(/\\/g, '/');
}

function fallbackTemplateName(kind, index) {
  if (kind === 'layout') return `结构风格 ${index}`;
  if (kind === 'deck') return `商务风格 ${index}`;
  if (kind === 'brand') return `品牌风格 ${index}`;
  return `内置模板 ${index}`;
}

function fallbackTemplateSummary(kind) {
  if (kind === 'layout') return '使用内置页面结构约束，视觉身份由 ppt-maker 继续补全。';
  if (kind === 'deck') return '使用内置完整风格模板，约束整体视觉、结构和页面节奏。';
  if (kind === 'brand') return '使用内置品牌视觉约束，页面结构由 ppt-maker 继续设计。';
  return '使用内置模板约束生成方向。';
}

function shapeTemplateOption({ skillDir, kind, id, meta, index, previewUrl = '' }) {
  if (id === 'free') return { ...FREE_TEMPLATE };
  const display = TEMPLATE_DISPLAY_META[id] || {};
  const relPath = templateRelPath(kind, id);
  return {
    id,
    raw_id: id,
    name: display.name || fallbackTemplateName(kind, index),
    kind,
    kind_label: TEMPLATE_KIND_LABEL[kind] || '内置模板',
    summary: trimText(display.summary || fallbackTemplateSummary(kind), 220),
    source_summary: trimText(meta?.summary || '', 220),
    primary_color: meta?.primary_color || '',
    page_count: meta?.page_count || null,
    canvas_format: meta?.canvas_format || '',
    template_path: path.join(skillDir, relPath),
    template_rel_path: relPath,
    preview_url: previewUrl,
  };
}

function dataUrlMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function inlineAssetUrl(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_INLINE_ASSET_BYTES) return '';
    const body = await fs.readFile(file);
    return `data:${dataUrlMime(file)};base64,${body.toString('base64')}`;
  } catch {
    return '';
  }
}

async function findTemplatePreview(skillDir, kind, id) {
  const base = kind === 'brand'
    ? path.join(skillDir, 'templates', 'brands', id)
    : kind === 'deck'
      ? path.join(skillDir, 'templates', 'decks', id)
      : path.join(skillDir, 'templates', 'layouts', id);
  const names = kind === 'brand'
    ? ['logo.png', 'logo_dark.png', 'google_g_logo.svg', 'anthropic_mark.svg', `${id}_wordmark.svg`]
    : ['01_cover.svg', 'cover.svg', 'reference_style.svg', 'logo.png', 'cover_bg.png'];
  for (const name of names) {
    const url = await inlineAssetUrl(path.join(base, name));
    if (url) return url;
  }
  return '';
}

async function readTemplateGroup(skillDir, kind, indexRel, baseRel) {
  const data = await readJson(path.join(skillDir, indexRel), {});
  const rows = [];
  for (const [id, meta] of Object.entries(data || {})) {
    const previewUrl = await findTemplatePreview(skillDir, kind, id);
    rows.push({
      ...shapeTemplateOption({ skillDir, kind, id, meta, index: rows.length + 1, previewUrl }),
      asset_root: path.join(skillDir, baseRel, id),
    });
  }
  return rows;
}

async function loadSelectableTemplates(skillDir) {
  const layouts = await readTemplateGroup(skillDir, 'layout', path.join('templates', 'layouts', 'layouts_index.json'), path.join('templates', 'layouts'));
  const decks = await readTemplateGroup(skillDir, 'deck', path.join('templates', 'decks', 'decks_index.json'), path.join('templates', 'decks'));
  const brands = await readTemplateGroup(skillDir, 'brand', path.join('templates', 'brands', 'brands_index.json'), path.join('templates', 'brands'));
  return {
    layouts,
    decks,
    brands,
    templates: [{ ...FREE_TEMPLATE }, ...layouts, ...decks, ...brands],
  };
}

async function resolveTemplateSelection(skillDir, rawTemplateId) {
  const id = String(rawTemplateId || 'free').trim() || 'free';
  const library = await loadSelectableTemplates(skillDir);
  return library.templates.find((item) => item.id === id) || { ...FREE_TEMPLATE };
}

async function listAssetFiles(dir, kind, max = MAX_TEMPLATE_ASSETS) {
  const rows = [];
  async function walk(current, depth = 0) {
    if (rows.length >= max || depth > 2 || !await exists(current)) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= max) break;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (entry.isFile() && /\.(svg|png|jpe?g|webp)$/i.test(entry.name)) {
        const url = await inlineAssetUrl(abs);
        if (!url) continue;
        rows.push({
          id: path.relative(dir, abs).replace(/\\/g, '/'),
          name: path.basename(entry.name, path.extname(entry.name)),
          kind,
          path: abs,
          url,
        });
      }
    }
  }
  await walk(dir, 0);
  return rows;
}

async function loadTemplateLibrary(skillDir) {
  const selectable = await loadSelectableTemplates(skillDir);
  const { layouts, decks, brands, templates } = selectable;
  const icons = await listAssetFiles(path.join(skillDir, 'templates', 'icons'), 'icon', 32);
  const charts = await listAssetFiles(path.join(skillDir, 'templates', 'charts'), 'chart', 32);
  return {
    templates,
    featured: templates.slice(0, 8),
    assets: {
      featured: templates.slice(0, 8),
      layouts,
      decks,
      brands,
      icons,
      charts,
    },
  };
}

async function countFilesRecursive(dir) {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) count += await countFilesRecursive(abs);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

async function countFilesIfExists(dir) {
  if (!await exists(dir)) return 0;
  return countFilesRecursive(dir);
}

async function readOptionalText(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeTextIfChanged(file, content) {
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (current === content) return false;
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
  return true;
}

async function insertSkillPatchBlock(file, id, anchor, block) {
  let content = await fs.readFile(file, 'utf8');
  const marker = `<!-- mobius-ppt-maker:${id}:${PPT_MASTER_PATCH_VERSION} -->`;
  if (content.includes(marker)) return false;
  const patch = `\n\n${marker}\n${block.trim()}\n<!-- /mobius-ppt-maker:${id} -->`;
  if (anchor && content.includes(anchor)) {
    content = content.replace(anchor, `${anchor}${patch}`);
  } else {
    content = `${content.trimEnd()}${patch}\n`;
  }
  return writeTextIfChanged(file, content);
}

async function patchProjectManagerVisualEvidence(scriptPath) {
  let content = await fs.readFile(scriptPath, 'utf8');
  if (content.includes('--render-vector-figures')) return false;
  const from = [
    '                str(pdf_path),',
    '                "-o",',
  ].join('\n');
  const to = [
    '                str(pdf_path),',
    '                "--render-vector-figures",',
    '                "-o",',
  ].join('\n');
  if (!content.includes(from)) return false;
  content = content.replace(from, to);
  return writeTextIfChanged(scriptPath, content);
}

async function applyPptMasterVisualEvidencePatch(skillDir, logger, label = '') {
  const markerPath = path.join(skillDir, '.mobius-ppt-maker-patch');
  if (await readOptionalText(markerPath) === PPT_MASTER_PATCH_VERSION) return false;
  const changes = [];
  changes.push(await insertSkillPatchBlock(
    path.join(skillDir, 'SKILL.md'),
    'skill-visual-evidence-audit',
    'place usable media in `images/`.',
    [
      '> **PPT Maker extension visual-evidence audit**:',
      '> After each conversion/import, inspect the converted Markdown, companion `_files/` folders, `<project_path>/images/`, and `images/image_manifest.json` when present. If evidence assets exist, run `analyze_images.py <project_path>/images` before Strategist writes `design_spec.md`.',
      '> Treat paper figures, report screenshots, product photos, UI screenshots, official images, architecture diagrams, and benchmark charts as first-class evidence. Strategist must place suitable assets in §VIII Image Resource List and `spec_lock.md images`; Executor must use those listed assets where the page content calls for them. If no substantive image is usable, state the concrete reason in the log/final answer.',
    ].join('\n'),
  ));
  changes.push(await insertSkillPatchBlock(
    path.join(skillDir, 'workflows', 'topic-research.md'),
    'topic-visual-evidence-log',
    '**Hard rule**: Prefer images that can teach or prove something. A meaningful paper figure beats an abstract generated background; an official product screenshot beats a generic laptop photo.',
    [
      '**PPT Maker extension requirement**: The visual evidence pass must leave an auditable trail. If images are downloaded, list filenames and recommended slide use in `## Visual Assets`. If no substantive image can be used, still write `## Visual Assets` with a short reason such as rights unavailable, resolution too low, no official images found, or topic is abstract.',
    ].join('\n'),
  ));
  changes.push(await insertSkillPatchBlock(
    path.join(skillDir, 'references', 'strategist.md'),
    'strategist-image-resource-gate',
    '**Hard rule**: For paper, research, product, company, technology, and topic-research decks, recommend source-backed evidence images before AI illustration. Evidence images include paper figures, architecture diagrams, product photos, UI screenshots, report charts, benchmark plots, and official page screenshots. Use AI images for explanatory abstractions or backgrounds after factual images have been considered.',
    [
      '**PPT Maker extension hard gate**: Before choosing option A (No images) or leaving §VIII empty, inspect `<project_path>/sources`, companion `_files` directories, `<project_path>/images/image_manifest.json`, and `image_analysis.csv` if available. If any evidence-quality asset exists, it must be represented in §VIII Image Resource List with `Acquire Via: user` / `Status: Existing` and mirrored in `spec_lock.md images`. If all candidates are rejected, write a one-sentence rejection reason below §VIII.',
    ].join('\n'),
  ));
  changes.push(await insertSkillPatchBlock(
    path.join(skillDir, 'references', 'executor-base.md'),
    'executor-use-listed-images',
    '**Reference syntax**: see [`svg-image-embedding.md`](svg-image-embedding.md).',
    [
      '**PPT Maker extension requirement**: If `design_spec.md §VIII` and `spec_lock.md images` list evidence assets for specific pages, Executor must actually reference the matching files in those page SVGs unless the page brief changed or the asset is unusable. Do not replace all evidence rows with decorative code-drawn SVG motifs. When an evidence asset is skipped, state the reason in the generation log.',
    ].join('\n'),
  ));
  changes.push(await patchProjectManagerVisualEvidence(path.join(skillDir, 'scripts', 'project_manager.py')));
  await writeTextIfChanged(markerPath, PPT_MASTER_PATCH_VERSION);
  const changed = changes.some(Boolean);
  if (changed) {
    logger?.info?.('patched ppt-master visual evidence guidance', { skill_dir: skillDir, label, version: PPT_MASTER_PATCH_VERSION });
  }
  return changed;
}

function rawSkillUrl(relPath) {
  return `${PPT_MASTER_RAW_BASE}/${String(relPath).split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadRawSkillFile(relPath, dest) {
  const url = rawSkillUrl(relPath);
  await ensureDir(path.dirname(dest));
  const body = await new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (redirect) => {
          if (redirect.statusCode !== 200) {
            reject(new Error(`raw fetch failed: ${redirect.statusCode}`));
            redirect.resume();
            return;
          }
          const chunks = [];
          redirect.on('data', (chunk) => chunks.push(chunk));
          redirect.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`raw fetch failed: ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => {
      req.destroy(new Error('raw fetch timeout'));
    });
    req.on('error', reject);
  });
  await fs.writeFile(dest, body);
}

async function inspectSkillDir(skillDir, extDataDir, includeTotalCount = false) {
  const dirExists = await exists(skillDir);
  const missing = [];
  if (dirExists) {
    for (const rel of REQUIRED_SKILL_FILES) {
      if (!await exists(path.join(skillDir, rel))) missing.push(rel);
    }
  } else {
    missing.push(...REQUIRED_SKILL_FILES);
  }
  const tablerOutlineDir = path.join(skillDir, 'templates', 'icons', 'tabler-outline');
  const tablerOutlineCount = dirExists ? await countFilesIfExists(tablerOutlineDir) : 0;
  const fileCount = includeTotalCount && dirExists ? await countFilesRecursive(skillDir) : null;
  const commitHash = await readOptionalText(sharedCommitPath(extDataDir));
  return {
    exists: dirExists,
    skill_dir: skillDir,
    repo: PPT_MASTER_REPO,
    commit_hash: commitHash,
    file_count: fileCount,
    missing_required_files: missing,
    icon_sets: {
      tabler_outline: {
        path: tablerOutlineDir,
        file_count: tablerOutlineCount,
        expected_count: EXPECTED_TABLER_OUTLINE_ICON_COUNT,
        ok: tablerOutlineCount >= EXPECTED_TABLER_OUTLINE_ICON_COUNT,
      },
    },
  };
}

async function repairSharedRequiredFiles(sharedDir, missing, logger) {
  if (!missing.length) return [];
  if (missing.length > RAW_REPAIR_LIMIT) return missing;
  logger?.warn?.('ppt-master shared source missing required files, raw repair start', missing);
  const failed = [];
  for (const rel of missing) {
    try {
      await downloadRawSkillFile(rel, path.join(sharedDir, rel));
    } catch (e) {
      failed.push(`${rel}: ${e.message}`);
    }
  }
  if (failed.length) logger?.warn?.('ppt-master raw repair failed', failed);
  return failed;
}

async function ensureSharedSource(extDataDir, logger) {
  const sharedDir = sharedSourceRoot(extDataDir);
  let status = await inspectSkillDir(sharedDir, extDataDir, false);
  if (!status.exists) {
    throw new Error(`ppt-master 共享缓存不存在: ${sharedDir}。请先从 ${PPT_MASTER_REPO} 浅克隆并复制 skills/ppt-master 到该目录。`);
  }
  if (status.missing_required_files.length) {
    await repairSharedRequiredFiles(sharedDir, status.missing_required_files, logger);
    status = await inspectSkillDir(sharedDir, extDataDir, false);
  }
  if (status.missing_required_files.length) {
    throw new Error(`ppt-master 共享缓存关键文件缺失: ${status.missing_required_files.join(', ')}`);
  }
  if (!status.icon_sets.tabler_outline.ok) {
    const iconStatus = status.icon_sets.tabler_outline;
    throw new Error(`ppt-master 共享缓存图标不完整: tabler-outline ${iconStatus.file_count}/${iconStatus.expected_count}`);
  }
  await applyPptMasterVisualEvidencePatch(sharedDir, logger, 'shared');
  return {
    ...status,
    ok: true,
    source_dir: sharedDir,
  };
}

async function ensureUserSkillCopy(extDataDir, username, logger, includeTotalCount = false) {
  const shared = await ensureSharedSource(extDataDir, logger);
  const skillDir = userSkillRoot(extDataDir, username);
  let user = await inspectSkillDir(skillDir, extDataDir, includeTotalCount);
  const userLastSynced = await readOptionalText(userLastSyncedCommitPath(extDataDir, username));
  const commitMismatch = !!shared.commit_hash && userLastSynced !== shared.commit_hash;
  const needsSync = !user.exists
    || user.missing_required_files.length > 0
    || !user.icon_sets.tabler_outline.ok
    || commitMismatch;

  if (needsSync) {
    logger?.info?.('同步 ppt-master skill user copy from shared source', {
      username,
      shared_dir: shared.source_dir,
      user_skill_dir: skillDir,
      missing: user.missing_required_files,
      tabler_outline_count: user.icon_sets.tabler_outline.file_count,
      commit_mismatch: commitMismatch,
    });
    await fs.rm(skillDir, { recursive: true, force: true });
    await ensureDir(path.dirname(skillDir));
    await copyDir(shared.source_dir, skillDir);
    if (shared.commit_hash) {
      await fs.writeFile(userLastSyncedCommitPath(extDataDir, username), shared.commit_hash);
    }
    user = await inspectSkillDir(skillDir, extDataDir, includeTotalCount);
  }

  if (user.missing_required_files.length) {
    throw new Error(`ppt-master 用户副本关键文件缺失: ${user.missing_required_files.join(', ')}`);
  }
  if (!user.icon_sets.tabler_outline.ok) {
    const iconStatus = user.icon_sets.tabler_outline;
    throw new Error(`ppt-master 用户副本图标不完整: tabler-outline ${iconStatus.file_count}/${iconStatus.expected_count}`);
  }
  await applyPptMasterVisualEvidencePatch(skillDir, logger, `user:${username}`);

  return {
    ok: true,
    skill_dir: skillDir,
    missing: user.missing_required_files,
    synced_from_shared: needsSync,
    shared_source_dir: shared.source_dir,
    shared,
    user,
  };
}

function sourceDescriptorFromUpload(upload) {
  return {
    type: 'file',
    name: upload.name,
    path: upload.path,
    size: upload.size || 0,
    mime_type: upload.mime_type || '',
  };
}

async function resolveSourceFiles(extDataDir, username, payload, state) {
  const root = userRoot(extDataDir, username);
  const files = [];
  const uploadIds = new Set(ensureArray(payload.upload_ids).map(String));
  for (const upload of state.uploads) {
    if (uploadIds.has(String(upload.id))) files.push(sourceDescriptorFromUpload(upload));
  }
  for (const raw of ensureArray(payload.source_files)) {
    if (!raw) continue;
    if (typeof raw === 'string') {
      const abs = path.resolve(raw);
      if (abs.startsWith(path.resolve(root) + path.sep) && await exists(abs)) {
        files.push({ type: 'file', name: path.basename(abs), path: abs, size: fss.statSync(abs).size, mime_type: '' });
      }
    } else if (typeof raw === 'object' && raw.path) {
      const abs = path.resolve(raw.path);
      if (abs.startsWith(path.resolve(root) + path.sep) && await exists(abs)) {
        files.push({
          type: 'file',
          name: sanitizeFilename(raw.name || path.basename(abs)),
          path: abs,
          size: Number(raw.size) || fss.statSync(abs).size,
          mime_type: String(raw.mime_type || ''),
        });
      }
    }
  }
  const seen = new Set();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  }).slice(0, 20);
}

async function materializeProjectSources(projectDir, sourceFiles, sourceUrls, inlineMarkdown) {
  const sourcesDir = path.join(projectDir, 'sources');
  await ensureDir(sourcesDir);
  const copied = [];
  for (const src of sourceFiles) {
    const dest = path.join(sourcesDir, sanitizeFilename(src.name || path.basename(src.path)));
    await fs.copyFile(src.path, dest);
    copied.push({ ...src, project_path: dest });
  }
  if (inlineMarkdown) {
    const dest = path.join(sourcesDir, 'inline-source.md');
    await fs.writeFile(dest, inlineMarkdown, 'utf8');
    copied.push({ type: 'inline_markdown', name: 'inline-source.md', path: dest, project_path: dest, size: Buffer.byteLength(inlineMarkdown) });
  }
  if (sourceUrls.length) {
    const dest = path.join(sourcesDir, 'source-urls.md');
    await fs.writeFile(dest, sourceUrls.map((url) => `- ${url}`).join('\n') + '\n', 'utf8');
    copied.push({ type: 'url_list', name: 'source-urls.md', path: dest, project_path: dest, size: sourceUrls.join('\n').length });
  }
  return copied;
}

function sourceTypeLabel(type) {
  if (type === 'inline_markdown') return 'user pasted Markdown/text';
  if (type === 'url_list') return 'URL source list';
  if (type === 'file') return 'uploaded source file';
  return type || 'source file';
}

function requestSourceLine(src) {
  const targetPath = src.project_path || src.path || '';
  if (src.type === 'inline_markdown') {
    return `- Inline Markdown/text path: ${targetPath}`;
  }
  if (src.type === 'url_list') {
    return `- URL source list path: ${targetPath}`;
  }
  return `- ${src.name} (${sourceTypeLabel(src.type)}): ${targetPath}`;
}

function promptSourceLine(src) {
  const targetPath = src.project_path || src.path || '';
  const label = sourceTypeLabel(src.type);
  if (src.type === 'inline_markdown') {
    return `  - inline-source.md（用户粘贴的 Markdown/文本）：${targetPath}`;
  }
  if (src.type === 'url_list') {
    return `  - source-urls.md（URL 源材料清单）：${targetPath}`;
  }
  return `  - ${src.name}（${label}）：${targetPath}`;
}

async function buildRequestMarkdown({
  topic,
  sourceUrls,
  copiedSources,
  skillDir,
  projectDir,
  templateOption,
  format,
  pageCount,
  notes,
  workflowHint,
}) {
  const templateLines = templateOption?.id === 'free'
    ? [
        '- Template display name: 自由设计',
        '- Template binding: none',
      ]
    : [
        `- Template display name: ${templateOption.name}`,
        `- Template kind: ${templateOption.kind_label || templateOption.kind}`,
        `- Template id: ${templateOption.id}`,
        `- Template path: ${templateOption.template_path}`,
        `- Template relative path: ${templateOption.template_rel_path}`,
      ];
  const lines = [
    '# PPT Maker Generation Request',
    '',
    `- Topic: ${topic || '(not specified)'}`,
    `- Created at: ${nowIso()}`,
    `- Project dir: ${projectDir}`,
    `- ppt-master skill: ${skillDir}`,
    `- Source dir: ${path.join(projectDir, 'sources')}`,
    `- Output PPTX: ${path.join(projectDir, 'output.pptx')}`,
    `- Format: ${format || 'ppt169'}`,
    `- Page count: ${pageCount}`,
    '- Raw source material policy: large user material is intentionally stored in `sources/` files, not packed into the agent prompt.',
    '',
    '## Template',
    '',
    ...templateLines,
    '',
    '## Source Files',
    '',
    ...(copiedSources.length
      ? copiedSources.map(requestSourceLine)
      : ['- No source file.']),
    '',
    '## Source URLs',
    '',
    ...(sourceUrls.length ? sourceUrls.map((url) => `- ${url}`) : ['- None']),
    '',
    '## Additional Requirements',
    '',
    notes ? notes.split(/\r?\n/).map((line) => `- ${line}`).join('\n') : '- None',
    '',
    '## Execution Notes',
    '',
    `- Input mode: ${workflowHint || 'source-material'}`,
    '- `topic-only`: when there is only a topic and no URL/file/inline text source material, run `workflows/topic-research.md` first, then return to the main `ppt-master` pipeline.',
    '- `url-only`: URLs are source material. First process the URLs with the skill URL flow / `scripts/source_to_md/web_to_md.py` and convert useful web content to Markdown; only supplement with research if URL content is insufficient or background context is explicitly needed.',
    '- `mixed-source-material`: read this `request.md` and every relevant item in `sources/` one by one; do not ignore URL lists, uploaded files, or inline Markdown/text.',
    '- For the merged source input box, URL-only lines are stored in `sources/source-urls.md`; all remaining Markdown/plain text is stored in `sources/inline-source.md`.',
    '- For Markdown/text input, treat `sources/inline-source.md` as user-provided source material. The inline text is intentionally saved there instead of being packed into the prompt.',
    '- For uploaded files, read the files from the source directory above; convert non-Markdown files using the matching `source_to_md` script.',
    '- After conversion/import, inspect `sources/`, companion `_files/` folders, and the project `images/` folder for usable visual evidence. Preserve paper figures, report charts, product/UI screenshots, architecture diagrams, benchmark plots, and official images when the source provides them.',
    '- Strategist must write suitable evidence images into `design_spec.md` §VIII Image Resource List and `spec_lock.md images`. If there are no usable substantive images, write a short reason in the generation log / final answer instead of silently defaulting to all-SVG decoration.',
    '- If a template path is present, treat it as the explicit template directory path required by SKILL.md Step 3.',
    '- If template binding is none, keep free design and let ppt-maker decide the visual direction.',
    '- Keep the workflow serial; do not batch-generate SVG pages.',
    '- Final PPTX must overwrite `output.pptx` in this project directory when complete.',
  ];
  return lines.join('\n');
}

function inputWorkflowHint({ topic, sourceUrls, sourceFiles, inlineMarkdown }) {
  const hasTopic = !!String(topic || '').trim();
  const hasUrls = Array.isArray(sourceUrls) && sourceUrls.length > 0;
  const hasFiles = Array.isArray(sourceFiles) && sourceFiles.length > 0;
  const hasMarkdown = !!String(inlineMarkdown || '').trim();
  if (hasTopic && !hasUrls && !hasFiles && !hasMarkdown) return 'topic-only';
  if (hasUrls && !hasTopic && !hasFiles && !hasMarkdown) return 'url-only';
  if (hasMarkdown && !hasFiles && !hasUrls) return hasTopic ? 'topic-and-text' : 'text-only';
  if (hasFiles && !hasUrls && !hasMarkdown) return hasTopic ? 'topic-and-files' : 'files-only';
  return 'mixed-source-material';
}

function sourceKindFromWorkflowHint(hint) {
  if (hint === 'topic-only') return '主题';
  if (hint === 'url-only') return 'URL';
  if (hint === 'text-only' || hint === 'topic-and-text') return 'Markdown';
  if (hint === 'files-only' || hint === 'topic-and-files') return '文件';
  return '混合材料';
}

function defaultProjectTitle({ topic, sourceUrls, sourceFiles, inlineMarkdown }) {
  if (topic) return topic;
  if (Array.isArray(sourceFiles) && sourceFiles.length) return trimText(path.basename(sourceFiles[0].name || sourceFiles[0].path || '源文件演示文稿'), 80);
  if (Array.isArray(sourceUrls) && sourceUrls.length) return trimText(sourceUrls[0], 80);
  if (inlineMarkdown) return '文本材料演示文稿';
  return 'PPT Maker Presentation';
}

function buildSessionPrompt({ project, skillDir }) {
  const sourceList = Array.isArray(project.sources) && project.sources.length
    ? project.sources.map(promptSourceLine).join('\n')
    : '  - 无上传源文件';
  const urlList = Array.isArray(project.source_urls) && project.source_urls.length
    ? project.source_urls.map((url) => `  - ${url}`).join('\n')
    : '  - 无 URL';
  const templateLines = project.template === 'free'
    ? [
        '- 模板：自由设计',
        '- 模板路径：无，按自由设计执行。',
      ]
    : [
        `- 模板：${project.template_name || project.template}`,
        `- 模板真实 id：${project.template}`,
        `- 模板真实路径：${project.template_path}`,
        '- 进入 SKILL.md Step 3 时，把上面的真实路径视为用户初始消息里提供的明确模板目录路径。',
      ];
  return [
    '你是一个 PPT 生成 agent。请使用 ppt-maker / ppt-master 技能套件完成这个 PPT Maker 项目，**直接执行完整生成流程**。',
    '',
    '## 项目坐标',
    `- 项目目录：${project.project_dir}`,
    `- ppt-master 技能目录：${skillDir}`,
    `- 源文件目录：${path.join(project.project_dir, 'sources')}`,
    `- 源材料简报：${path.join(project.project_dir, 'request.md')}`,
    `- 期望输出：${path.join(project.project_dir, 'output.pptx')}`,
    `- 格式：${project.format || 'ppt169'}`,
    `- 页数：${project.page_count}`,
    '',
    '## 用户输入',
    `- 主题：${project.topic || '未指定'}`,
    '- URL：',
    urlList,
    '- 源文件 / 文本材料：',
    sourceList,
    '- 模板选择：',
    ...templateLines,
    `- 补充要求：${project.notes || '无'}`,
    `- 输入模式：${project.workflow_hint || 'source-material'}`,
    '',
    '## 输入模式处理规则',
    '- `topic-only`：只有主题、没有 URL / 文件 / Markdown 文本等实质材料时，先执行 `workflows/topic-research.md`，完成资料收集后回到 SKILL.md 主流程。',
    '- `url-only`：URL 是源材料，不要默认等同于纯主题研究。先用 skill 的 URL 处理流程 / `scripts/source_to_md/web_to_md.py` 转成 Markdown，再按主流程使用；只有 URL 内容不足或需要补充背景时再补充 research。',
    '- `mixed-source-material`：必须逐项读取 `request.md` 与 `sources/` 下的 URL 清单、上传文件、inline-source.md；不要因为某一种材料存在而忽略另一种材料。',
    '- 合并输入框拆分规则：单独一行的 URL 已写入 `sources/source-urls.md`，其它 Markdown/普通文本已写入 `sources/inline-source.md`。',
    '',
    '## 硬性执行要求（HARD RULES）',
    `1. **必须**先阅读 \`${skillDir}/SKILL.md\` 全文，按其中的 Step 1-9 串行执行。`,
    `2. **必须**通过 Bash 工具实际执行 \`${skillDir}/scripts/project_manager.py\` / \`${skillDir}/scripts/svg_to_pptx.py\` 等 Python 脚本来管理项目和导出 PPTX。**禁止**只生成纯文本 PPT 占位、**禁止**用模板字符串拼 PPTX、**禁止**跳过脚本。`,
    '3. **必须**把生成的高质量 `output.pptx` 覆盖写入上面的项目目录 output.pptx 路径。',
    `4. **禁止**修改 \`${skillDir}\` 技能目录与 Mobius 主系统代码；只读写本项目目录内材料。`,
    '5. **禁止**批量生成 SVG（必须一页一页串行写）。',
    `6. 完成后**必须**运行 \`bash -lc "ls -la ${project.project_dir}/output.pptx"\` 确认产物存在，并把最终 PPTX 路径回贴到你的回答中。`,
    '7. 这是 PPT Maker 拓展发起的完整生成请求，用户已经提交主题、材料、模板、格式、页数和补充要求；除非缺少不可替代的信息，不要停下来要求用户创建其它会话。',
    '8. **必须**在源材料转换/导入后检查可用图片资产：论文图表、报告截图、产品图、UI 截图、官方图片、架构图、基准图等都应作为实质视觉证据优先进入 `design_spec.md` §VIII Image Resource List 与 `spec_lock.md images`；不要在已有明显视觉证据时全部退化为装饰性代码 SVG。',
    '9. 如果最终没有使用任何实质图片，请在生成日志或最终回复中说明原因，例如“源文件未提取出可读图片 / URL 无可授权图片 / 图片分辨率不足”。',
    '',
    '## STEP 进度标记（MANDATORY）',
    '前端会订阅你输出的文字流来实时显示进度。在每个关键节点，你**必须**单独输出一行 `<<<STEP:<name>[:detail]>>>`（用三对尖括号包裹，单行独占，前后空行）。',
    '请按以下顺序输出 STEP 标记，**未完成前一个 STEP 就不要输出下一个**：',
    '',
    '  1. 读完 SKILL.md 之后立即输出：',
    '     `<<<STEP:reading-skill>>>`',
    '  2. 开始读取/转换源材料时输出：',
    '     `<<<STEP:reading-sources:start>>>`',
    '     每处理完一个源文件或转换后的 Markdown 时输出：',
    '     `<<<STEP:reading-sources:file:<filename>>>>`',
    '     非 Markdown 文件必须先按 SKILL.md Step 1 使用对应 `source_to_md` 脚本转换；转换完成也算处理源材料进度。',
    '     全部处理完成后输出：',
    '     `<<<STEP:reading-sources:done>>>`',
    '  3. 跑 `project_manager.py` 初始化时：',
    '     `<<<STEP:project-init>>>`',
    '  4. 写 design_spec.md 时：',
    '     `<<<STEP:design-spec>>>`',
    '  5. 写 spec_lock.md（锁定设计方案）时：',
    '     `<<<STEP:spec-lock>>>`',
    '  6. 进入逐页 SVG 生成：',
    '     `<<<STEP:svg-generation:start:total=<N>>>>` （N 是计划总页数）',
    '     每写完一页 SVG 立即输出：',
    '     `<<<STEP:svg-generation:page:<i>:<N>>>>` （i 从 1 开始）',
    '     全部写完：',
    '     `<<<STEP:svg-generation:done>>>`',
    '  7. 跑质量检查 + 后处理：',
    '     `<<<STEP:quality-check>>>` 然后 `<<<STEP:post-process>>>`',
    '  8. 跑 `svg_to_pptx.py` 导出时：',
    '     `<<<STEP:export-pptx>>>`',
    '  9. 验证 output.pptx 存在后输出：',
    '     `<<<STEP:done>>>`',
    '',
    '如果中途发生致命错误，请输出：',
    '`<<<STEP:error:<一句话描述>>>>`',
    '',
    '## 其它',
    `- 仅主题且没有任何实质材料时，先执行 \`${skillDir}/workflows/topic-research.md\` 再回到主流程。`,
    `- 仅 URL 时，先按 URL/web_to_md 源材料流程处理；如果网页内容不足，再补充 \`${skillDir}/workflows/topic-research.md\`。`,
    '- URL、Markdown/文本、上传源文件都已在 request.md 和 sources/ 中列清；不要忽略任何一种输入。',
    '- 大量材料不在当前 prompt 正文里，必须从 `request.md` 与 `sources/` 文件读取；不要根据本提示中的摘要臆造内容。',
    '- 图片使用以内容需要为准，不强制每页放图；但当纸面图表、产品/UI/官方图片等明显证据存在时，Strategist 和 Executor 必须实际引用合适图片。',
    '- 你的回答用中文；PPT 内容语言跟随用户输入。',
  ].join('\n');
}

async function createGeneration({ extDataDir, username, displayName, payload, state, skillDir }) {
  const topic = trimText(payload.topic || payload.title || '', 160);
  const sourceInput = mergeSourceInputs(payload);
  const inlineMarkdown = sourceInput.inlineMarkdown;
  if (Buffer.byteLength(inlineMarkdown, 'utf8') > MAX_TEXT_SOURCE_BYTES) {
    throw new Error('Markdown/文本超过 3MB，请保存为 .md/.txt 后作为源文件上传');
  }
  const sourceUrls = sourceInput.sourceUrls;
  const sourceFiles = await resolveSourceFiles(extDataDir, username, payload, state);
  const notes = trimText(payload.notes || payload.additional_requirements || payload.requirements || '', 4000);
  const format = trimText(payload.format || 'ppt169', 40) || 'ppt169';
  const pageCount = normalizePageCount(payload.page_count || payload.pageCount);
  const templateOption = await resolveTemplateSelection(skillDir, payload.template);
  const template = templateOption.id || 'free';
  const workflowHint = inputWorkflowHint({ topic, sourceUrls, sourceFiles, inlineMarkdown });
  const projectTitle = defaultProjectTitle({ topic, sourceUrls, sourceFiles, inlineMarkdown });

  if (!sourceFiles.length && !sourceUrls.length && !inlineMarkdown && !topic) {
    throw new Error('请提供源文件、URL、Markdown 或主题');
  }

  const requestedProjectId = trimText(payload.project_id || payload.projectId || '', 110);
  const projectId = requestedProjectId
    ? slugify(requestedProjectId, 'ppt')
    : `${Date.now()}-${slugify(projectTitle, 'ppt')}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 110);
  const projectDir = safeResolve(userRoot(extDataDir, username), 'projects', projectId);
  await ensureDir(projectDir);
  const copiedSources = await materializeProjectSources(projectDir, sourceFiles, sourceUrls, inlineMarkdown);

  const requestMarkdown = await buildRequestMarkdown({
    topic,
    sourceUrls,
    copiedSources,
    skillDir,
    projectDir,
    templateOption,
    format,
    pageCount,
    notes,
    workflowHint,
  });
  const requestPath = path.join(projectDir, 'request.md');
  await fs.writeFile(requestPath, requestMarkdown, 'utf8');

  const outputPath = path.join(projectDir, 'output.pptx');
  const project = {
    id: projectId,
    name: projectTitle,
    topic,
    template,
    template_name: templateOption.name,
    template_kind: templateOption.kind,
    template_kind_label: templateOption.kind_label,
    template_path: templateOption.template_path || '',
    template_rel_path: templateOption.template_rel_path || '',
    format,
    notes,
    workflow_hint: workflowHint,
    status: 'processing',
    progress: 0,
    hidden_from_main: false,
    hidden_at: '',
    created_at: nowIso(),
    updated_at: nowIso(),
    project_dir: projectDir,
    request_path: requestPath,
    output_path: '',
    output_size: 0,
    download_url: '',
    output_url: '',
    output_mime: PPTX_MIME,
    page_count: pageCount,
    source_kind: sourceKindFromWorkflowHint(workflowHint),
    sources: copiedSources,
    source_urls: sourceUrls,
    session_prompt: '',
    session_payload_path: '',
    session_id: '',
    session_url: '',
    issue_id: '',
  };
  project.session_prompt = buildSessionPrompt({ project, skillDir });
  const sessionPayload = {
    endpoint: 'POST /api/issues/:issueId/sessions/',
    note: 'start_generation 会创建用于完整生成流程的 Mobius Session；/api/ext 主进程会在后端自动启动 agent。start_message_body 仅作为审计与手动补偿材料，前端不需要二次 POST。',
    create_session_body: {
      name: `生成 PPT：${projectTitle}`,
      description: project.session_prompt,
      model: 'codex',
      language: 'zh',
      excluded_skill_ids: [],
      excluded_memory_ids: [],
    },
    start_message_body: {
      content: project.session_prompt,
    },
    ppt_maker_action: {
      action: 'start_generation',
      source_files: copiedSources.map((src) => src.project_path),
      source_urls: sourceUrls,
      template,
      template_path: templateOption.template_path || '',
      format,
      page_count: pageCount,
      notes,
      topic,
    },
    created_for: {
      username,
      display_name: displayName || username,
    },
  };
  const sessionPayloadPath = path.join(projectDir, 'session-payload.json');
  await writeJson(sessionPayloadPath, sessionPayload);
  project.session_payload_path = sessionPayloadPath;

  state.projects.unshift(project);
  state.projects = state.projects.slice(0, MAX_PROJECTS);
  await saveState(extDataDir, username, state);

  let mobius = null;
  let postActions = [];
  try {
    const created = await createSessionForProject({
      extDataDir,
      username,
      projectId,
      state,
      skillDir,
    });
    mobius = created.created;
    postActions = [{
      type: 'session_message',
      session_id: project.session_id,
      project_id: project.id,
      content: project.session_prompt,
      input_text: topic || inlineMarkdown.slice(0, 160) || sourceUrls[0] || 'PPT Maker 生成请求',
      request_id: `ppt-maker-${project.id}`,
      source: 'extension.ppt-maker.start_generation',
      result_key: 'backend_start',
    }];
  } catch (e) {
    project.status = 'session_failed';
    project.error = e.message || '建 Session 失败';
    project.updated_at = nowIso();
    state.projects = state.projects.map((p) => (p.id === projectId ? project : p));
    await saveState(extDataDir, username, state);
    return { project, sessionPayload, error: project.error };
  }

  await saveState(extDataDir, username, state);
  return { project, sessionPayload, mobius, postActions };
}

async function createSessionForProject({ extDataDir, username, projectId, state, skillDir }) {
  let project = state.projects.find((item) => item.id === projectId);
  if (!project && projectId) {
    project = await readProjectFromDir(safeResolve(userRoot(extDataDir, username), 'projects', projectId));
    if (project) {
      project.session_prompt = buildSessionPrompt({ project, skillDir });
      state.projects.unshift(project);
      state.projects = state.projects.slice(0, MAX_PROJECTS);
    }
  }
  if (!project) throw new Error('未找到项目');
  if (!project.session_prompt) project.session_prompt = buildSessionPrompt({ project, skillDir });
  const user = loadUser(username);
  const extensionProject = Projects.findByExtensionName(EXTENSION_NAME, user.id) || Projects.findById(`ext_${EXTENSION_NAME}`, user.id);
  if (!extensionProject) throw new Error('PPT Maker 拓展项目尚未注册，请先 reload extension registry');

  const issueSubject = trimText(project.topic || project.name || project.id, 80);
  const issueTitle = `PPT 生成：${issueSubject}`;
  let issue = Issues.findByProjectAndTitle(extensionProject.id, issueTitle);
  if (!issue) {
    const issueId = uuid().slice(0, 8);
    Issues.insert({
      id: issueId,
      project_id: extensionProject.id,
      title: issueTitle,
      description: [
        `PPT Maker 项目目录：${project.project_dir}`,
        `目标输出：${path.join(project.project_dir, 'output.pptx')}`,
        '',
        project.session_prompt,
      ].join('\n'),
      created_by: user.id,
      use_worktree: false,
      worktree_branch: '',
      visibility: 'inherit',
    });
    issue = Issues.findById(issueId);
  }

  const resolvedModel = modelRegistry.resolveSessionModelForCreate('codex');
  const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    const err = new Error(limitCheck.error || '模型使用额度不足');
    err.status = limitCheck.status || 429;
    throw err;
  }
  const sessionId = uuid().slice(0, 8);
  const selectionSnapshot = buildSessionSelectionSnapshot(user, issue.id, [], []);
  Sessions.insert({
    session_id: sessionId,
    issue_id: issue.id,
    project_id: extensionProject.id,
    user_id: user.id,
    name: `生成 PPT：${trimText(project.topic || project.name || project.id, 70)}`,
    description: project.session_prompt,
    session_key: `extension:${EXTENSION_NAME}:${user.id}:${sessionId}`,
    excluded_skill_ids: [],
    excluded_memory_ids: [],
    selection_snapshot: selectionSnapshot,
    model: resolvedModel.sessionModelValue,
    language: 'zh',
  });
  Issues.touchActiveAndIncrement(issue.id);

  const session = Sessions.findById(sessionId);
  const created = {
    project: {
      id: extensionProject.id,
      name: extensionProject.name,
      bind_path: extensionProject.bind_path || '',
    },
    issue: {
      id: issue.id,
      project_id: issue.project_id,
      title: issue.title,
      description: issue.description || '',
      status: issue.status,
    },
    session: {
      session_id: session.session_id,
      issue_id: session.issue_id,
      project_id: session.project_id,
      name: session.name,
      description: session.description || '',
      status: session.status,
      model: session.model,
      language: session.language,
    },
  };
  project.session_id = sessionId;
  project.issue_id = issue.id;
  project.session_url = `/u/${encodeURIComponent(user.id)}/p/${encodeURIComponent(extensionProject.id)}/i/${encodeURIComponent(issue.id)}?session=${encodeURIComponent(sessionId)}`;
  project.updated_at = nowIso();
  if (state.projects?.length) {
    state.projects = state.projects.map((p) => (p.id === projectId ? project : p));
  }
  return { project, created };
}

async function listOutputs(extDataDir, username, state) {
  const projects = await listUserProjects(extDataDir, username, state);
  return projects
    .filter((project) => !project.hidden_from_main)
    .filter((project) => project.output_path || project.output_url || project.download_url)
    .slice(0, MAX_OUTPUTS);
}

function countPptxSlides(buffer) {
  const text = buffer.toString('latin1');
  const matches = new Set();
  const re = /ppt\/slides\/slide(\d+)\.xml/g;
  let match;
  while ((match = re.exec(text)) !== null) matches.add(match[1]);
  return matches.size || null;
}

function inferSourceKind(project) {
  if (project.source_kind) return project.source_kind;
  const sources = Array.isArray(project.sources) ? project.sources : [];
  const urls = Array.isArray(project.source_urls) ? project.source_urls : [];
  if (sources.some((src) => src.type === 'file')) return '文件';
  if (sources.some((src) => src.type === 'inline_markdown')) return 'Markdown';
  if (urls.length || sources.some((src) => src.type === 'url_list')) return 'URL';
  return '主题';
}

async function readProjectFromDir(projectDir, stateProject = null) {
  const id = path.basename(projectDir);
  const outputPath = path.join(projectDir, 'output.pptx');
  const hasOutput = await exists(outputPath);
  const requestText = await readOptionalText(path.join(projectDir, 'request.md'));
  if (!hasOutput && !stateProject && !requestText) return null;
  const stat = hasOutput ? await fs.stat(outputPath) : { size: 0, mtime: new Date(), birthtime: new Date() };
  const artifacts = await buildProjectArtifacts(projectDir);
  let session = null;
  if (stateProject?.session_id) {
    try { session = Sessions.findById(stateProject.session_id); } catch {}
  }
  const status = normalizeProjectStatus({ hasOutput, stateProject, session });
  const titleMatch = requestText.match(/^- Topic:\s*(.+)$/m);
  const templateIdMatch = requestText.match(/^- Template id:\s*(.+)$/m);
  const templateNameMatch = requestText.match(/^- Template display name:\s*(.+)$/m);
  const templateKindMatch = requestText.match(/^- Template kind:\s*(.+)$/m);
  const templatePathMatch = requestText.match(/^- Template path:\s*(.+)$/m);
  const templateRelPathMatch = requestText.match(/^- Template relative path:\s*(.+)$/m);
  const formatMatch = requestText.match(/^- Format:\s*(.+)$/m);
  const pageCountMatch = requestText.match(/^- Page count:\s*(\d+)/m);
  let pageCount = null;
  if (hasOutput) {
    try {
      pageCount = countPptxSlides(await fs.readFile(outputPath));
    } catch {}
  }
  const merged = {
    ...(stateProject || {}),
    id: stateProject?.id || id,
    name: stateProject?.name || stateProject?.topic || trimText(titleMatch?.[1] || id, 100),
    topic: stateProject?.topic || trimText(titleMatch?.[1] || id, 100),
    template: stateProject?.template || trimText(templateIdMatch?.[1] || (templateNameMatch?.[1] === '自由设计' ? 'free' : '') || 'free', 120),
    template_name: stateProject?.template_name || trimText(templateNameMatch?.[1] || '', 120),
    template_kind_label: stateProject?.template_kind_label || trimText(templateKindMatch?.[1] || '', 120),
    template_path: stateProject?.template_path || trimText(templatePathMatch?.[1] || '', 500),
    template_rel_path: stateProject?.template_rel_path || trimText(templateRelPathMatch?.[1] || '', 240),
    format: stateProject?.format || trimText(formatMatch?.[1] || 'ppt169', 40),
    status,
    progress: hasOutput ? 100 : (status === 'processing' ? (stateProject?.progress ?? 0) : 0),
    created_at: stateProject?.created_at || stat.birthtime.toISOString(),
    updated_at: stateProject?.updated_at || stat.mtime.toISOString(),
    project_dir: projectDir,
    output_path: hasOutput ? outputPath : '',
    output_size: hasOutput ? stat.size : 0,
    output_url: hasOutput ? downloadPath(outputPath) : '',
    download_url: hasOutput ? downloadPath(outputPath) : '',
    page_count: stateProject?.page_count || pageCount || (pageCountMatch ? Number(pageCountMatch[1]) : null),
    source_kind: inferSourceKind(stateProject || {}),
    source_count: Math.max(
      Number(stateProject?.source_count || 0) || 0,
      Array.isArray(stateProject?.sources) ? stateProject.sources.length : 0,
      artifacts.sources.length,
    ),
    session_payload_path: stateProject?.session_payload_path || (await exists(path.join(projectDir, 'session-payload.json')) ? path.join(projectDir, 'session-payload.json') : ''),
    session_url: stateProject?.session_url || '',
    session_id: stateProject?.session_id || '',
    issue_id: stateProject?.issue_id || '',
    error: normalizeProjectError({ hasOutput, stateProject, status }),
    artifacts,
  };
  return shapeProject(merged);
}

async function listUserProjects(extDataDir, username, state) {
  const projectsDir = safeResolve(userRoot(extDataDir, username), 'projects');
  const byId = new Map();
  for (const project of state.projects || []) {
    if (project?.id) byId.set(String(project.id), project);
  }
  const rows = [];
  if (await exists(projectsDir)) {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, entry.name);
      const row = await readProjectFromDir(projectDir, byId.get(entry.name));
      if (row) rows.push(row);
    }
  }
  for (const project of state.projects || []) {
    if (!project?.id || rows.some((row) => row.id === project.id)) continue;
    rows.push(shapeProject(project));
  }
  rows.sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
  return rows.slice(0, MAX_OUTPUTS);
}

async function getOutputLink(extDataDir, username, state, projectId) {
  const projectDir = safeResolve(userRoot(extDataDir, username), 'projects', projectId);
  const project = await readProjectFromDir(
    projectDir,
    state.projects.find((item) => item.id === projectId),
  );
  if (!project) throw new Error('未找到项目');
  if (!project.output_path || !await exists(project.output_path)) throw new Error('输出文件不存在');
  const stat = await fs.stat(project.output_path);
  return {
    project: shapeProject({ ...project, output_size: stat.size }),
    output: {
      path: project.output_path,
      size: stat.size,
      mime_type: PPTX_MIME,
      download_url: `/api/download?path=${encodeURIComponent(project.output_path)}`,
    },
  };
}

async function getArtifactPreview(extDataDir, username, payload) {
  const projectId = String(payload.project_id || payload.projectId || '').trim();
  const relPath = String(payload.rel_path || payload.relPath || '').trim();
  if (!projectId) throw new Error('project_id 必填');
  if (!relPath) throw new Error('rel_path 必填');
  const projectDir = safeResolve(userRoot(extDataDir, username), 'projects', projectId);
  const filePath = safeResolve(projectDir, relPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('预览目标不是文件');
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_PREVIEW_EXTENSIONS.has(ext) || ext === '.json') {
    const limit = Math.min(stat.size, MAX_ARTIFACT_PREVIEW_BYTES);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      await handle.read(buffer, 0, limit, 0);
      return {
        preview_kind: 'text',
        name: path.basename(filePath),
        rel_path: relProjectPath(projectDir, filePath),
        size: stat.size,
        truncated: stat.size > MAX_ARTIFACT_PREVIEW_BYTES,
        content: buffer.toString('utf8'),
        mime_type: artifactMime(filePath),
        download_url: downloadPath(filePath),
      };
    } finally {
      await handle.close();
    }
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      preview_kind: 'image',
      name: path.basename(filePath),
      rel_path: relProjectPath(projectDir, filePath),
      size: stat.size,
      mime_type: artifactMime(filePath),
      download_url: downloadPath(filePath),
    };
  }
  return {
    preview_kind: '',
    name: path.basename(filePath),
    rel_path: relProjectPath(projectDir, filePath),
    size: stat.size,
    mime_type: artifactMime(filePath),
    download_url: downloadPath(filePath),
  };
}

async function getProjectPreview(extDataDir, username, projectId) {
  const projectDir = safeResolve(userRoot(extDataDir, username), 'projects', projectId);
  if (!await exists(projectDir)) throw new Error('项目不存在');

  let svgDir = path.join(projectDir, 'svg_final');
  if (!await exists(svgDir)) svgDir = path.join(projectDir, 'svg_output');

  if (!await exists(svgDir)) {
    return { available: false, reason: 'no_svg_dir', message: '该项目未保存 SVG 源文件，无法预览' };
  }

  const names = (await fs.readdir(svgDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.svg'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  if (!names.length) {
    return { available: false, reason: 'empty_svg_dir', message: '项目 SVG 目录为空' };
  }

  const pages = [];
  for (let i = 0; i < names.length; i += 1) {
    const fp = path.join(svgDir, names[i]);
    const content = await fs.readFile(fp, 'utf8');
    pages.push({
      index: i + 1,
      name: names[i],
      data_url: `data:image/svg+xml;base64,${Buffer.from(content, 'utf8').toString('base64')}`,
    });
  }

  return {
    available: true,
    project_id: projectId,
    total: pages.length,
    pages,
  };
}

async function registerUploadedSource(extDataDir, username, payload, state) {
  const raw = payload.file && typeof payload.file === 'object' ? payload.file : payload;
  if (!raw.path || typeof raw.path !== 'string') throw new Error('file.path 必填');
  const abs = path.resolve(raw.path);
  const root = path.resolve(userRoot(extDataDir, username));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('上传文件必须位于当前用户的拓展数据区');
  if (!await exists(abs)) throw new Error('上传文件不存在');
  const stat = await fs.stat(abs);
  const item = {
    id: crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12),
    name: sanitizeFilename(raw.name || path.basename(abs)),
    path: abs,
    size: stat.size,
    mime_type: String(raw.mime_type || raw.mimetype || ''),
    created_at: nowIso(),
  };
  state.uploads = state.uploads.filter((upload) => upload.id !== item.id);
  state.uploads.unshift(item);
  state.uploads = state.uploads.slice(0, 120);
  await saveState(extDataDir, username, state);
  return item;
}

function isUserUploadFile(extDataDir, username, filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const abs = path.resolve(filePath);
  const uploadRoot = path.resolve(userUploadRoot(extDataDir, username));
  return abs !== uploadRoot && abs.startsWith(uploadRoot + path.sep);
}

async function removeUploadFileIfOwned(extDataDir, username, upload, remainingUploads = []) {
  const filePath = upload?.path;
  if (!isUserUploadFile(extDataDir, username, filePath)) {
    return { path: filePath || '', deleted: false, reason: 'outside_uploads_dir' };
  }
  const abs = path.resolve(filePath);
  const stillReferenced = remainingUploads.some((item) => item?.path && path.resolve(item.path) === abs);
  if (stillReferenced) {
    return { path: abs, deleted: false, reason: 'still_referenced' };
  }
  try {
    await fs.unlink(abs);
    return { path: abs, deleted: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { path: abs, deleted: false, missing: true };
    return { path: abs, deleted: false, error: e.message || 'delete failed' };
  }
}

async function deleteUploadRecord(extDataDir, username, payload, state) {
  const uploadId = String(payload.upload_id || payload.uploadId || payload.id || '').trim();
  if (!uploadId) throw new Error('upload_id 必填');
  const upload = state.uploads.find((item) => String(item.id) === uploadId);
  if (!upload) throw new Error('上传记录不存在');
  const remainingUploads = state.uploads.filter((item) => String(item.id) !== uploadId);
  const file = await removeUploadFileIfOwned(extDataDir, username, upload, remainingUploads);
  state.uploads = remainingUploads;
  await saveState(extDataDir, username, state);
  return { upload, file };
}

async function clearUploadRecords(extDataDir, username, state) {
  const removedUploads = state.uploads;
  const fileResults = [];
  const seen = new Set();
  for (const upload of removedUploads) {
    const key = upload?.path && isUserUploadFile(extDataDir, username, upload.path)
      ? path.resolve(upload.path)
      : String(upload?.path || '');
    if (seen.has(key)) continue;
    seen.add(key);
    fileResults.push(await removeUploadFileIfOwned(extDataDir, username, upload, []));
  }
  state.uploads = [];
  await saveState(extDataDir, username, state);
  return { removedUploads, fileResults };
}

async function setProjectMainVisibility(extDataDir, username, payload, state, hidden) {
  const projectId = String(payload.project_id || payload.projectId || payload.id || '').trim();
  if (!projectId) throw new Error('project_id 必填');
  let found = false;
  const updatedProjects = (state.projects || []).map((project) => {
    if (String(project?.id || '') !== projectId) return project;
    found = true;
    return {
      ...project,
      hidden_from_main: hidden,
      hidden_at: hidden ? nowIso() : '',
    };
  });
  if (!found) {
    const projectDir = safeResolve(userRoot(extDataDir, username), 'projects', projectId);
    const project = await readProjectFromDir(projectDir, null);
    if (!project) throw new Error('未找到项目');
    updatedProjects.unshift({
      ...project,
      hidden_from_main: hidden,
      hidden_at: hidden ? nowIso() : '',
    });
  }
  state.projects = updatedProjects.slice(0, MAX_PROJECTS);
  await saveState(extDataDir, username, state);
  const row = await readProjectFromDir(
    safeResolve(userRoot(extDataDir, username), 'projects', projectId),
    state.projects.find((project) => String(project?.id || '') === projectId),
  );
  return row || shapeProject(state.projects.find((project) => String(project?.id || '') === projectId));
}

module.exports = async function ({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
  const action = payload.action || 'get_state';

  try {
    const skillStatus = await ensureUserSkillCopy(ext_data_dir, username, logger, action === 'get_skill_status');
    const state = await readState(ext_data_dir, username);

    if (action === 'whoami') {
      return {
        ok: true,
        extension_name: EXTENSION_NAME,
        username,
        display_name: display_name || username,
        ext_data_dir,
        skill: skillStatus,
      };
    }

    if (action === 'get_skill_status') {
      const shared = await inspectSkillDir(sharedSourceRoot(ext_data_dir), ext_data_dir, true);
      const user = await inspectSkillDir(userSkillRoot(ext_data_dir, username), ext_data_dir, true);
      return {
        ok: true,
        extension_name: EXTENSION_NAME,
        username,
        repo: PPT_MASTER_REPO,
        raw_base: PPT_MASTER_RAW_BASE,
        shared_source_dir: sharedSourceRoot(ext_data_dir),
        user_skill_dir: userSkillRoot(ext_data_dir, username),
        skill_dir: skillStatus.skill_dir,
        synced_from_shared: skillStatus.synced_from_shared,
        shared,
        user,
      };
    }

    if (action === 'get_state') {
      const library = await loadTemplateLibrary(skillStatus.skill_dir);
      return {
        ok: true,
        skill: skillStatus,
        templates: library.templates,
        featured: library.featured,
        assets: library.assets,
        uploads: state.uploads.map(shapeUpload),
        projects: await listUserProjects(ext_data_dir, username, state),
      };
    }

    if (action === 'list_templates') {
      return { ok: true, ...await loadTemplateLibrary(skillStatus.skill_dir) };
    }

    if (action === 'upload_source') {
      const upload = await registerUploadedSource(ext_data_dir, username, payload, state);
      return { ok: true, upload: shapeUpload(upload), uploads: state.uploads.map(shapeUpload) };
    }

    if (action === 'delete_upload') {
      const deleted = await deleteUploadRecord(ext_data_dir, username, payload, state);
      return {
        ok: true,
        upload: shapeUpload(deleted.upload),
        file: deleted.file,
        uploads: state.uploads.map(shapeUpload),
      };
    }

    if (action === 'clear_uploads') {
      const cleared = await clearUploadRecords(ext_data_dir, username, state);
      return {
        ok: true,
        removed_count: cleared.removedUploads.length,
        files: cleared.fileResults,
        uploads: state.uploads.map(shapeUpload),
      };
    }

    if (action === 'hide_project_from_main' || action === 'show_project_on_main') {
      const project = await setProjectMainVisibility(
        ext_data_dir,
        username,
        payload,
        state,
        action === 'hide_project_from_main',
      );
      return {
        ok: true,
        project,
        projects: await listUserProjects(ext_data_dir, username, state),
      };
    }

    if (action === 'list_projects') {
      return { ok: true, projects: await listUserProjects(ext_data_dir, username, state) };
    }

    if (action === 'list_user_projects') {
      return { ok: true, projects: await listUserProjects(ext_data_dir, username, state) };
    }

    if (action === 'start_generation') {
      const created = await createGeneration({
        extDataDir: ext_data_dir,
        username,
        displayName: display_name,
        payload,
        state,
        skillDir: skillStatus.skill_dir,
      });
      return {
        ok: true,
        __mobius_post_actions: created.postActions || [],
        project: shapeProject(created.project),
        output: created.project.output_path
          ? {
              path: created.project.output_path,
              size: created.project.output_size,
              mime_type: PPTX_MIME,
              download_url: created.project.download_url,
            }
          : null,
        session: created.mobius
          ? {
              session_id: created.project.session_id,
              issue_id: created.project.issue_id,
              session_url: created.project.session_url,
              model: created.mobius.session?.model || '',
              status: created.mobius.session?.status || '',
              started: false,
            }
          : null,
        backend_start: null,
        session_payload: created.sessionPayload,
        error: created.error || null,
      };
    }

    if (action === 'list_outputs') {
      return { ok: true, outputs: await listOutputs(ext_data_dir, username, state) };
    }

    if (action === 'get_output_link') {
      const projectId = String(payload.project_id || '').trim();
      return { ok: true, ...await getOutputLink(ext_data_dir, username, state, projectId) };
    }

    if (action === 'get_artifact_preview') {
      return { ok: true, ...await getArtifactPreview(ext_data_dir, username, payload) };
    }

    if (action === 'get_project_preview') {
      const projectId = String(payload.project_id || '').trim();
      if (!projectId) throw new Error('project_id 必填');
      return { ok: true, ...await getProjectPreview(ext_data_dir, username, projectId) };
    }

    if (action === 'api_contract') {
      return {
        ok: true,
        contract: {
          ext_endpoint: 'POST /api/ext',
          ext_payload: {
            extension_name: EXTENSION_NAME,
            ext_main_payload: {
	              action: 'start_generation',
	              source_files: ['absolute paths returned by upload_source or /api/extensions/ppt-maker/upload'],
	              source_input: 'https://example.com/source\\n# Core material\\nPaste Markdown or plain text here.',
	              source_urls: ['legacy/compatibility URL list; optional'],
	              markdown: 'legacy/compatibility Markdown or plain text; optional',
	              template: 'free | academic_defense | ai_ops | ...',
	              format: 'ppt169',
	              page_count: 6,
	              notes: 'additional requirements',
	              topic: 'presentation topic',
	            },
	          },
          template_actions: {
            list_templates: { action: 'list_templates' },
            list_user_projects: { action: 'list_user_projects' },
            hide_project_from_main: { action: 'hide_project_from_main', project_id: '<project_id>' },
            show_project_on_main: { action: 'show_project_on_main', project_id: '<project_id>' },
            get_project_preview: { action: 'get_project_preview', project_id: '<project_id>' },
            get_artifact_preview: { action: 'get_artifact_preview', project_id: '<project_id>', rel_path: '<artifact.rel_path>' },
	          },
	          generation_session: 'start_generation returns the created Mobius Session and the backend auto-start result for the full ppt-maker workflow.',
	          start_session_endpoint: 'backend auto-starts through internal session-message-runner; no browser-side POST is required',
	          start_message_body: {
	            content: '<session_payload.start_message_body.content is returned only for audit/manual compensation>',
          },
        },
      };
    }

    return { ok: false, error: `未知 action: ${action}` };
  } catch (e) {
    logger?.error?.('ppt-maker action failed', action, e.message);
    return { ok: false, error: e.message || 'PPT Maker handler failed' };
  }
};
