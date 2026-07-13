// =====================================================================
// Electron 启动欢迎向导 (/welcome)
//
// 桌面端 bootDesktop() 登录后统一 loadURL(${server}/welcome) 进此页 (electron 特殊机制)。
// 浏览器端也可访问 /welcome, 但桌面端独有字段 (本地路径 / 本机信息) 会优雅降级隐藏。
//
// 页面 1: 欢迎语 + 5 个去向 (从上次结束处继续 / 接入已有项目 / 创建全新项目 /
//         导入零散文件 / 进入已创建项目) + 本机信息 & mobius 连接信息小字。
// 页面 2: 项目创建菜单 (接入已有项目 / 创建全新项目 共用, 仅"本地路径"可见性不同)。
//         必填: 项目名称; 接入模式另必填本地路径。其余字段折叠在「高级选项」。
//
// 本地路径 = 用户本机工作目录 (桌面端 project-paths.json, 不上传服务器), 创建项目后
//   调 mobiusDesktop.confirmProjectPath 绑定; 默认 ~/Desktop/MobiusOS/<项目名> (对齐
//   mobius/desktop main.ts project:bind-status 的 defaultPath)。
// 绑定路径 = mobius 中枢 agent 工作目录 (服务器侧 user.work_dir/<随机 slug>)。
// =====================================================================
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  History, FolderInput, Plus, FileText, FolderOpen, ChevronLeft, ChevronDown,
  ChevronRight, FolderOpen as FolderBrowse, Dices, Loader2, Sparkles,
} from 'lucide-react'
import { useStore, api } from '../store'
import { MobiusLogo } from '../components/mobius-logo'
import { ErrBanner, PathPickerModal } from '../components/modals'
import { ToggleSwitch } from '../components/toggle-switch'
import { ExpandableTextarea } from '../components/expandable-textarea'

// --- 桌面端 bridge (preload 注入 window.mobiusDesktop) ---
interface BootData {
  platform?: string
  osVersion?: string
  arch?: string
  hostname?: string
  ips?: string[]
  cpuModel?: string
  cpuCount?: number
  totalMemGB?: number
  aimuxIdentifier?: string
  serverOrigin?: string
  appVersion?: string
  desktopPath?: string
}
interface DesktopBridge {
  isDesktop?: boolean
  getBootData?: () => Promise<BootData>
  getLastRoute?: () => Promise<string | null>
  pickDirectory?: () => Promise<string | null>
  confirmProjectPath?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string } | null>
}
function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: DesktopBridge }).mobiusDesktop
    : undefined
}

// --- 可见性选项 (对齐 global-create.tsx VISIBILITY_OPTIONS) ---
type Visibility = 'private' | 'team' | 'public' | 'allowlist'
const VISIBILITY_OPTIONS: { value: Visibility; label: string; desc: string }[] = [
  { value: 'private', label: '仅自己', desc: '仅创建者可见' },
  { value: 'team', label: '同组', desc: '同一用户组可见' },
  { value: 'public', label: '公开', desc: '所有登录用户可见' },
  { value: 'allowlist', label: '指定用户', desc: '仅指定用户/组可见' },
]

// --- 随机绑定路径 (对齐 global-create.tsx, 中枢 agent 工作目录) ---
const RANDOM_ADJECTIVES = ['bright', 'calm', 'clever', 'cozy', 'fresh', 'gentle', 'lively', 'lovely', 'lucky', 'merry', 'neat', 'quiet', 'rapid', 'smart', 'sunny', 'tidy', 'warm', 'wise']
const RANDOM_NOUNS = ['bird', 'brook', 'cloud', 'field', 'forest', 'garden', 'harbor', 'lake', 'leaf', 'meadow', 'moon', 'mountain', 'river', 'seed', 'snake', 'spark', 'star', 'stone', 'sun', 'tree', 'valley', 'wave', 'wind']
function randomSlug(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)] || arr[0]
  return `${pick(RANDOM_ADJECTIVES)}_${pick(RANDOM_NOUNS)}`
}
function randomBindPath(workDir?: string | null): string {
  const root = (workDir || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return `${root}/${randomSlug()}`.replace(/\/{2,}/g, '/')
}

// --- 本地路径默认值: 对齐 desktop main.ts 的 join(desktop, "MobiusOS", sanitizeName(name)) ---
function sanitizeName(name: string): string {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim()
  return s || 'project'
}
function defaultLocalPath(desktopPath: string | undefined, name: string): string {
  if (!desktopPath) return ''
  return `${desktopPath}/MobiusOS/${sanitizeName(name)}`
}

type Step = 'menu' | 'create'
type CreateMode = 'connect' | 'new'

export default function Welcome() {
  const { user, theme } = useStore()
  const navigate = useNavigate()
  const dark = theme !== 'light'

  const md = getDesktopBridge()
  const isDesktop = !!md?.isDesktop

  const [step, setStep] = useState<Step>('menu')
  const [boot, setBoot] = useState<BootData | null>(null)
  const [lastRoute, setLastRoute] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<CreateMode>('new')

  useEffect(() => {
    md?.getBootData?.().then(b => setBoot(b || null)).catch(() => {})
    md?.getLastRoute?.().then(r => setLastRoute(r || null)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!user) return null

  if (step === 'create') {
    return (
      <WelcomeCreate
        mode={createMode}
        dark={dark}
        isDesktop={isDesktop}
        desktopPath={boot?.desktopPath}
        onBack={() => setStep('menu')}
      />
    )
  }

  // ---- 页面 1: 欢迎菜单 ----
  const options: Array<{
    key: string
    icon: typeof History
    title: string
    desc: string
    onClick: () => void
    hidden?: boolean
    disabled?: boolean
    badge?: string
  }> = [
    {
      key: 'resume',
      icon: History,
      title: '从上次结束处继续',
      desc: '回到您上次退出时所在的页面',
      onClick: () => { if (lastRoute) navigate(lastRoute) },
      hidden: !lastRoute,
    },
    {
      key: 'connect',
      icon: FolderInput,
      title: '接入一个您计算机中的已有项目',
      desc: '指定本地路径, 把磁盘上已有的项目接入 Mobius',
      onClick: () => { setCreateMode('connect'); setStep('create') },
    },
    {
      key: 'new',
      icon: Plus,
      title: '创建一个全新项目',
      desc: '从零开始一个新项目, 本地路径自动生成',
      onClick: () => { setCreateMode('new'); setStep('create') },
    },
    {
      key: 'import',
      icon: FileText,
      title: '导入一些零散文件，随便聊聊',
      desc: '丢几个文件进来, 和小莫自由对话',
      onClick: () => {},
      disabled: true,
      badge: '即将推出',
    },
    {
      key: 'enter',
      icon: FolderOpen,
      title: '进入已创建的 Mobius 项目',
      desc: '浏览我已有的项目列表',
      onClick: () => navigate(`/u/${user.id}`),
    },
  ]

  // 本机信息小字
  const machineLines: string[] = []
  if (boot) {
    const platformLabel = boot.platform === 'win32' ? 'Windows' : boot.platform === 'darwin' ? 'macOS' : boot.platform === 'linux' ? 'Linux' : (boot.platform || '')
    const parts = [platformLabel, boot.arch, boot.hostname].filter(Boolean)
    if (parts.length) machineLines.push(parts.join(' · '))
    if (boot.cpuModel) machineLines.push(`${boot.cpuCount || 0} 核 · ${boot.cpuModel}`)
    if (typeof boot.totalMemGB === 'number') machineLines.push(`${boot.totalMemGB} GB 内存`)
    if (boot.ips && boot.ips.length) machineLines.push(`IP: ${boot.ips.join(', ')}`)
    if (boot.appVersion) machineLines.push(`Mobius Desktop v${boot.appVersion}`)
  }
  // mobius 连接信息小字
  const mobiusUrl = boot?.serverOrigin || (typeof window !== 'undefined' ? window.location.origin : '')
  const connectLine = mobiusUrl ? `${mobiusUrl} · ${user.display_name || user.id}` : (user.display_name || user.id)

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[640px] relative z-10">
        {/* 标题 */}
        <div className="text-center mb-8">
          <div className="inline-block mb-5">
            <MobiusLogo size={56} />
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
            欢迎使用 Mobius
          </h1>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            链接一切的自进化 Agent 操作系统
          </p>
        </div>

        {/* 选项列表 */}
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          {options.filter(o => !o.hidden).map((o, i) => {
            const Icon = o.icon
            return (
              <button
                key={o.key}
                type="button"
                disabled={o.disabled}
                onClick={o.onClick}
                className={`group flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors ${o.disabled ? 'cursor-not-allowed opacity-55' : 'hover:bg-[var(--bg-hover)]'} ${i > 0 ? 'border-t' : ''}`}
                style={i > 0 ? { borderColor: 'var(--border-color)' } : undefined}
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                  <Icon className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>{o.title}</span>
                    {o.badge && (
                      <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>{o.badge}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--text-muted)' }}>{o.desc}</span>
                </span>
                {!o.disabled && (
                  <ChevronRight className="h-4 w-4 flex-shrink-0 opacity-40 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--text-muted)' }} />
                )}
              </button>
            )
          })}
        </div>

        {/* 小字: 本机信息 */}
        {machineLines.length > 0 && (
          <div className="mt-5 px-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {machineLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {/* 小字: mobius 连接信息 */}
        <div className="mt-1.5 px-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {connectLine}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 页面 2: 项目创建菜单 (接入已有 / 创建全新 共用)
// =====================================================================
function WelcomeCreate({ mode, dark, isDesktop, desktopPath, onBack }: {
  mode: CreateMode
  dark: boolean
  isDesktop: boolean
  desktopPath?: string
  onBack: () => void
}) {
  const { user } = useStore()
  const navigate = useNavigate()

  const isConnect = mode === 'connect'
  const [name, setName] = useState('')
  // 本地路径: 接入模式可见且必填; 创建模式折叠在高级选项, 默认随项目名联动。
  const [localPath, setLocalPath] = useState('')
  const [localPathTouched, setLocalPathTouched] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [desc, setDesc] = useState('一个新项目')
  const [bindPath, setBindPath] = useState(() => randomBindPath(user?.work_dir))
  const [bindPathManual, setBindPathManual] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [researchEnabled, setResearchEnabled] = useState(false)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // 本地路径默认值随项目名联动 (未手动改过时)
  useEffect(() => {
    if (!isDesktop) return
    if (localPathTouched) return
    setLocalPath(defaultLocalPath(desktopPath, name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, desktopPath, isDesktop, localPathTouched])

  const refreshBindPath = () => {
    const next = randomBindPath(user?.work_dir)
    if (!next) { setErr('当前用户尚未配置工作目录，无法生成随机绑定路径'); return }
    setBindPath(next); setBindPathManual(false); setErr('')
  }

  const browseLocal = async () => {
    const md = getDesktopBridge()
    if (!md?.pickDirectory) return
    const picked = await md.pickDirectory()
    if (picked) { setLocalPath(picked); setLocalPathTouched(true); setErr('') }
  }

  const submit = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (isDesktop && isConnect && !localPath.trim()) { setErr('请选择本地路径'); return }
    if (!bindPath.trim()) { setErr('绑定路径生成失败，请在高级选项中手动填写'); return }
    setLoading(true); setErr('')
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: desc || '一个新项目',
        visibility,
        bindPath,
        bindPathManual,
        defaultUseWorktree: researchEnabled ? false : defaultUseWorktree,
        researchEnabled,
        can_post_issue: false,
        can_run_session: false,
      }
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) })
      if (p?.error) { setErr(p.error); return }
      // 绑定本地路径 (桌面端, 不上传服务器): 创建成功拿到 projectId 后调 confirmProjectPath。
      if (isDesktop && localPath.trim() && p?.id) {
        const md = getDesktopBridge()
        try { await md?.confirmProjectPath?.(p.id, localPath.trim()) } catch { /* 绑定失败不阻断进项目 */ }
      }
      const dest = p?.id && p?.created_by ? `/u/${p.created_by}/p/${p.id}` : `/u/${user?.id}`
      navigate(dest)
    } catch (e) {
      setErr((e as Error)?.message || '创建失败')
    } finally {
      setLoading(false)
    }
  }

  const visibilityOption = VISIBILITY_OPTIONS.find(o => o.value === visibility) || VISIBILITY_OPTIONS[0]

  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }
  const inputCls = 'w-full h-10 px-3 rounded-xl text-[13px] outline-none focus:border-blue-500/40 transition-colors'

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[560px] relative z-10">
        {/* 顶栏: 返回 + 标题 */}
        <div className="flex items-center gap-2 mb-5">
          <button type="button" onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }} title="返回">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isConnect ? '接入一个已有项目' : '创建一个全新项目'}
          </h1>
        </div>

        <div className="rounded-2xl p-5" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          <div className="space-y-4">
            {/* 项目名称: 必填, 无默认 */}
            <div>
              <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>项目名称 <span style={{ color: '#ef4444' }}>*</span></label>
              <input
                type="text"
                value={name}
                autoFocus
                onChange={e => { setName(e.target.value); setErr('') }}
                placeholder="例如：营销活动策划"
                className={inputCls}
                style={inputStyle}
              />
            </div>

            {/* 本地路径: 接入模式可见且必填; 创建模式折叠进高级选项 */}
            {isDesktop && isConnect && (
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  本地路径 <span style={{ color: '#ef4444' }}>*</span>
                  <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>· 本机工作目录, 不上传服务器</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localPath}
                    onChange={e => { setLocalPath(e.target.value); setLocalPathTouched(true); setErr('') }}
                    placeholder="选择或输入本机绝对路径"
                    className={`${inputCls} font-mono`}
                    style={inputStyle}
                  />
                  <button type="button" onClick={browseLocal} title="浏览…"
                    className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
                    style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                    <FolderBrowse className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* 高级选项 (折叠) */}
            <div className="rounded-xl" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <button type="button" onClick={() => setAdvancedOpen(v => !v)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] font-medium"
                style={{ color: 'var(--text-secondary)' }}>
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                  高级选项
                </span>
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} style={{ color: 'var(--text-muted)' }} />
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 pt-1 space-y-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
                  {/* 本地路径 (创建模式在此, 接入模式已在上方) */}
                  {isDesktop && !isConnect && (
                    <div>
                      <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                        本地路径
                        <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>· 本机工作目录, 不上传服务器</span>
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={localPath}
                          onChange={e => { setLocalPath(e.target.value); setLocalPathTouched(true); setErr('') }}
                          placeholder="选择或输入本机绝对路径"
                          className={`${inputCls} font-mono`}
                          style={inputStyle}
                        />
                        <button type="button" onClick={browseLocal} title="浏览…"
                          className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
                          style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                          <FolderBrowse className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                  {/* 项目描述 */}
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>项目描述</label>
                    <ExpandableTextarea
                      value={desc}
                      onValueChange={setDesc}
                      placeholder="一句话描述这个项目"
                      overlayTitle="编辑项目描述"
                      className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40 resize-none"
                      style={inputStyle}
                    />
                  </div>
                  {/* 绑定路径 (Mobius 中枢 agent 工作目录, 随机) */}
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      绑定路径
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>· Mobius 中枢 agent 工作目录</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={bindPath}
                        onChange={e => { setBindPath(e.target.value); setBindPathManual(true); setErr('') }}
                        placeholder="点击右侧选择, 或手动输入"
                        className={`${inputCls} font-mono`}
                        style={inputStyle}
                      />
                      <button type="button" onClick={() => setPickerOpen(true)} title="选择路径"
                        className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        <FolderBrowse className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={refreshBindPath} title="换一个随机路径"
                        className="h-10 w-10 shrink-0 rounded-xl border flex items-center justify-center hover:bg-[var(--bg-card-hover)]"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        <Dices className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {/* 可见性 */}
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>可见性</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {VISIBILITY_OPTIONS.map(opt => {
                        const active = visibility === opt.value
                        return (
                          <button key={opt.value} type="button" onClick={() => { setVisibility(opt.value); setErr('') }} title={opt.desc}
                            className="h-9 rounded-lg border text-[12px] transition-colors"
                            style={active
                              ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                              : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                            {opt.label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{visibilityOption.desc}</p>
                  </div>
                  {/* 启动 Research 系统 */}
                  <ToggleSwitch
                    checked={researchEnabled}
                    onChange={enabled => { setResearchEnabled(enabled); if (enabled) setDefaultUseWorktree(false) }}
                    className="flex items-start gap-3 text-[13px]"
                    style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                    <span><span className="font-medium">启动 Research 系统</span><span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>开启后可在本项目中创建 Research Agent 团队</span></span>
                  </ToggleSwitch>
                  {/* 默认使用 git worktree */}
                  {!researchEnabled && (
                    <ToggleSwitch
                      checked={defaultUseWorktree}
                      onChange={setDefaultUseWorktree}
                      className="flex items-center gap-3 text-[13px]"
                      style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                      <span>默认使用 git worktree（新建 Issue 时开独立工作区）</span>
                    </ToggleSwitch>
                  )}
                </div>
              )}
            </div>

            {err && <ErrBanner>{err}</ErrBanner>}
          </div>

          {/* 操作栏 */}
          <div className="flex justify-end gap-2 mt-5 pt-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
            <button type="button" onClick={onBack}
              className="h-9 px-4 rounded-xl text-[13px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-secondary)' }}>
              返回
            </button>
            <button type="button" onClick={submit} disabled={loading}
              className="h-9 px-5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60 flex items-center gap-1.5 transition-colors"
              style={{ background: '#3b82f6' }}>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {loading ? '创建中…' : (isConnect ? '接入项目' : '创建项目')}
            </button>
          </div>
        </div>

        {pickerOpen && (
          <PathPickerModal
            initialPath={user?.work_dir}
            onClose={() => setPickerOpen(false)}
            onPick={(_abs, rel, manual) => { setBindPath(rel || _abs); setBindPathManual(!!manual); setPickerOpen(false) }}
          />
        )}
      </div>
    </div>
  )
}
