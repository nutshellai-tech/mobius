import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Calculator, Check, ChevronDown, Loader2, Play, RefreshCw, Users } from 'lucide-react'
import { pollRecursive } from '../services/polling'
import {
  MAX_HARNESS_AGENTS,
  createHarnessRun,
  estimateHarnessRun,
  getHarnessFeatures,
  getHarnessRun,
  isHarnessRunTerminal,
  listHarnessProfiles,
  listHarnessRuns,
  type HarnessEstimate,
  type HarnessCollaborationShape,
  type HarnessExecutionMode,
  type HarnessFeatures,
  type HarnessProfile,
  type HarnessRosterMemberDraft,
  type HarnessRunDraft,
  type HarnessRunRecord,
  type HarnessRunSnapshot,
} from '../services/harness'
import { HarnessRunView } from './harness-run-view'

function memberKey(profileId: string): string {
  let hash = 2166136261
  for (let index = 0; index < profileId.length; index += 1) {
    hash = Math.imul(hash ^ profileId.charCodeAt(index), 16777619)
  }
  const suffix = profileId.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(-12)
  return `member_${(hash >>> 0).toString(36)}_${suffix}`.slice(0, 32)
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
}

function backendLabel(backend: HarnessProfile['backend']): string {
  if (backend === 'claude-code') return 'Claude'
  if (backend === 'deepseek-harness') return 'DeepSeek Harness'
  return 'Codex'
}

export function HarnessRosterPicker({ issueId, projectId, defaultGoal }: {
  issueId: string
  projectId: string
  defaultGoal: string
}) {
  const [profiles, setProfiles] = useState<HarnessProfile[]>([])
  const [runs, setRuns] = useState<HarnessRunRecord[]>([])
  const [mode, setMode] = useState<HarnessExecutionMode>('single')
  const [features, setFeatures] = useState<HarnessFeatures>({ adaptive_scheduling_enabled: true, batch_create_enabled: true, max_parallel_subs: 4, root_result_wake_enabled: true, result_ack_required: true, notification_digest_enabled: false })
  const [goal, setGoal] = useState(defaultGoal)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mainId, setMainId] = useState('')
  const [purposes, setPurposes] = useState<Record<string, 'worker' | 'evaluator'>>({})
  const [estimate, setEstimate] = useState<HarnessEstimate | null>(null)
  const [estimateConfirmed, setEstimateConfirmed] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState('')
  const [snapshot, setSnapshot] = useState<HarnessRunSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [estimating, setEstimating] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const loadProfilesAndRuns = useCallback(async (signal?: AbortSignal) => {
    const [profileRows, runRows, featureFlags] = await Promise.all([
      listHarnessProfiles(projectId, signal),
      listHarnessRuns(issueId, signal),
      getHarnessFeatures(signal),
    ])
    setProfiles(profileRows)
    setRuns(runRows)
    setFeatures(featureFlags)
    setSelectedIds((current) => current.length ? current.filter((id) => profileRows.some((profile) => profile.id === id)) : (profileRows[0] ? [profileRows[0].id] : []))
    setMainId((current) => current && profileRows.some((profile) => profile.id === current) ? current : (profileRows.find((profile) => profile.definition.capabilities.can_main)?.id || ''))
    setSelectedRunId((current) => current || runRows[0]?.id || '')
  }, [issueId, projectId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    loadProfilesAndRuns(controller.signal)
      .catch((cause: any) => { if (cause?.name !== 'AbortError') setError(cause?.message || 'Harness 配置加载失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [loadProfilesAndRuns])

  useEffect(() => {
    if (!selectedRunId) { setSnapshot(null); return }
    const stop = pollRecursive(async (signal) => {
      const next = await getHarnessRun(selectedRunId, signal)
      setSnapshot(next)
      if (isHarnessRunTerminal(next.run.status)) {
        setRuns((current) => current.map((run) => run.id === next.run.id ? { ...run, ...next.run, node_count: next.nodes.length, succeeded_node_count: next.nodes.filter((node) => node.status === 'succeeded').length } : run))
      }
    }, 2_000, 10_000)
    return stop
  }, [selectedRunId])

  useEffect(() => {
    setGoal(defaultGoal)
  }, [defaultGoal, issueId])

  const selectedProfiles = useMemo(() => selectedIds.map((id) => profiles.find((profile) => profile.id === id)).filter(Boolean) as HarnessProfile[], [profiles, selectedIds])
  // Multi mode reserves an adaptive Worker instance pool server-side. Profile
  // selection chooses models/capabilities; it no longer caps Agent instances.
  const concurrencyLimit = Math.max(1, Math.min(4, features.max_parallel_subs, MAX_HARNESS_AGENTS - 1))
  const effectiveShape: HarnessCollaborationShape = mode === 'multi' ? 'adaptive' : 'pipeline'
  const effectiveConcurrency = (effectiveShape === 'pipeline' ? 1 : concurrencyLimit) as 1 | 2 | 3 | 4
  const draft = useMemo<HarnessRunDraft>(() => ({
    anchor_type: 'issue',
    issue_id: issueId,
    goal: goal.trim(),
    execution_mode: mode,
    roster: {
      main_member_key: memberKey(mainId),
      ...(mode === 'multi' ? { auto_expand: true } : {}),
      members: selectedProfiles.map<HarnessRosterMemberDraft>((profile) => ({
        member_key: memberKey(profile.id),
        profile_id: profile.id,
        ...(profile.id !== mainId ? { purpose: purposes[profile.id] || 'worker' } : {}),
      })),
    },
    ...(mode === 'multi' ? {
      policy: {
        schema_version: '1.1',
        topology_selection_mode: 'auto_safe',
        collaboration_shape: 'adaptive',
        max_concurrent_subharnesses: effectiveConcurrency,
        parallel_read_only_only: true,
      },
    } : {}),
  }), [effectiveConcurrency, goal, issueId, mainId, mode, purposes, selectedProfiles])

  const invalidateEstimate = () => {
    setEstimate(null)
    setEstimateConfirmed(false)
    setError('')
  }

  const selectMode = (next: HarnessExecutionMode) => {
    if (next === mode) return
    setMode(next)
    if (next === 'single') {
      const keep = selectedIds.includes(mainId) ? mainId : selectedIds[0] || profiles.find((profile) => profile.definition.capabilities.can_main)?.id || ''
      setSelectedIds(keep ? [keep] : [])
      setMainId(keep)
    }
    invalidateEstimate()
  }

  const toggleProfile = (profile: HarnessProfile) => {
    if (mode === 'single') {
      if (!profile.definition.capabilities.can_main) return
      setSelectedIds([profile.id])
      setMainId(profile.id)
      invalidateEstimate()
      return
    }
    if (selectedIds.includes(profile.id)) {
      if (selectedIds.length <= 1) return
      const next = selectedIds.filter((id) => id !== profile.id)
      setSelectedIds(next)
      if (mainId === profile.id) setMainId(next.find((id) => profiles.find((item) => item.id === id)?.definition.capabilities.can_main) || '')
    } else if (selectedIds.length < MAX_HARNESS_AGENTS) {
      setSelectedIds([...selectedIds, profile.id])
      if (!mainId && profile.definition.capabilities.can_main) setMainId(profile.id)
    }
    invalidateEstimate()
  }

  const setMain = (profile: HarnessProfile) => {
    if (!selectedIds.includes(profile.id) || !profile.definition.capabilities.can_main) return
    setMainId(profile.id)
    invalidateEstimate()
  }

  const validRoster = !!mainId && selectedIds.includes(mainId)
    && (mode === 'single' ? selectedIds.length === 1 : selectedIds.length >= 1 && selectedIds.length <= MAX_HARNESS_AGENTS)
  const canSubmit = !!goal.trim() && validRoster && !creating && (mode === 'single' || (!!estimate && estimateConfirmed))

  const handleEstimate = async () => {
    if (!goal.trim() || !validRoster) return
    setEstimating(true)
    setError('')
    try {
      const next = await estimateHarnessRun(draft)
      setEstimate(next)
      setEstimateConfirmed(false)
    } catch (cause: any) {
      setError(cause?.message || '无法生成成本预估')
    } finally {
      setEstimating(false)
    }
  }

  const handleCreate = async () => {
    if (!canSubmit) return
    setCreating(true)
    setError('')
    try {
      const next = await createHarnessRun(draft, mode === 'multi' ? estimate || undefined : undefined)
      setSnapshot(next)
      setSelectedRunId(next.run.id)
      setRuns((current) => [next.run, ...current.filter((run) => run.id !== next.run.id)])
      setEstimate(null)
      setEstimateConfirmed(false)
    } catch (cause: any) {
      setError(cause?.message || '无法创建 Harness Run')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="mt-6" aria-labelledby="harness-heading">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
            <h2 id="harness-heading" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Main/Sub Harness</h2>
          </div>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>多 Harness 始终由 AI 智能调度；低风险、只读且相互独立的任务会自动并行</p>
        </div>
        {runs.length > 0 && (
          <label className="relative min-w-[190px]">
            <span className="sr-only">选择 Harness Run</span>
            <select value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}
              className="h-11 w-full appearance-none rounded-md border bg-transparent pl-3 pr-8 text-[11px] outline-none focus:ring-2 focus:ring-sky-500/25"
              style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)', background: 'var(--input-bg)' }}>
              {runs.map((run) => <option key={run.id} value={run.id}>{run.execution_mode === 'multi' ? '多' : '单'} · {run.goal.slice(0, 24)} · {run.status}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-3.5 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
          </label>
        )}
      </div>

      <div className="rounded-md border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-w-0">
            <label className="block text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }} htmlFor="harness-goal">执行目标</label>
            <textarea id="harness-goal" value={goal} rows={3}
              onChange={(event) => { setGoal(event.target.value); invalidateEstimate() }}
              className="mt-1.5 w-full resize-y rounded-md border px-3 py-2 text-[12px] leading-5 outline-none transition-colors focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/15"
              style={{ borderColor: 'var(--input-border)', color: 'var(--text-primary)', background: 'var(--input-bg)' }} />
          </div>
          <fieldset>
            <legend className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>执行模式</legend>
            <div className="mt-1.5 grid grid-cols-2 rounded-md border p-1" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
              {(['single', 'multi'] as const).map((value) => (
                <button key={value} type="button" aria-pressed={mode === value} onClick={() => selectMode(value)}
                  className="min-h-11 rounded px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
                  style={{ color: mode === value ? 'var(--text-primary)' : 'var(--text-muted)', background: mode === value ? 'var(--bg-active)' : 'transparent' }}>
                  {value === 'single' ? '单 Harness' : '多 Harness'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>{mode === 'single' ? '一个 Main 独立完成任务' : 'Main 自动决定任务拓扑与并行度'}</p>
          </fieldset>
        </div>

        <fieldset className="mt-4">
          <legend className="flex items-center justify-between gap-3 text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            <span>模型与唯一 Main</span>
            <span className="font-normal" style={{ color: 'var(--text-muted)' }}>{selectedIds.length} 个模型</span>
          </legend>
          {loading ? (
            <div className="mt-2 flex h-20 items-center justify-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}><Loader2 className="h-4 w-4 animate-spin" />加载 Profile</div>
          ) : profiles.length === 0 ? (
            <div className="mt-2 rounded-md border border-dashed p-4 text-[11px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>当前项目没有可用的只读 Harness Profile。</div>
          ) : (
            <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {profiles.map((profile) => {
                const selected = selectedIds.includes(profile.id)
                const isMain = mainId === profile.id
                const capabilities = profile.definition.capabilities
                return (
                  <div key={profile.id} className="rounded-md border p-3 transition-colors"
                    style={{ borderColor: selected ? 'rgba(56,189,248,.45)' : 'var(--border-color)', background: selected ? 'var(--bg-active)' : 'var(--bg-card)' }}>
                    <button type="button" onClick={() => toggleProfile(profile)}
                      className="flex min-h-11 w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border"
                        style={{ borderColor: selected ? '#38bdf8' : 'var(--border-color-strong)', color: selected ? '#38bdf8' : 'transparent' }}>
                        <Check className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <Bot className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{profile.name}</span>
                        </span>
                        <span className="mt-1 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{backendLabel(profile.backend)} · {profile.default_model}</span>
                      </span>
                    </button>
                    {selected && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2" style={{ borderColor: 'var(--border-color)' }}>
                        <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-[10px]" style={{ color: capabilities.can_main ? 'var(--text-secondary)' : 'var(--text-dimmed)' }}>
                          <input type="radio" name="harness-main" checked={isMain} disabled={!capabilities.can_main} onChange={() => setMain(profile)} className="accent-sky-500" />Main
                        </label>
                        {!isMain && capabilities.can_evaluate && (
                          <select aria-label={`${profile.name} 的角色`} value={purposes[profile.id] || 'worker'}
                            onChange={(event) => { setPurposes((current) => ({ ...current, [profile.id]: event.target.value as 'worker' | 'evaluator' })); invalidateEstimate() }}
                            className="ml-auto h-11 rounded border bg-transparent px-2 text-[10px] outline-none"
                            style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                            <option value="worker">Worker</option>
                            <option value="evaluator">Evaluator</option>
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </fieldset>

        {mode === 'multi' && (
          <div className="mt-4 rounded-md border p-3" style={{ borderColor: estimate ? 'rgba(45,212,191,.3)' : 'var(--border-color)', background: 'var(--bg-card)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}><Calculator className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />创建前预估</div>
              <button type="button" onClick={handleEstimate} disabled={estimating || !goal.trim() || !validRoster}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-[11px] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: 'var(--border-color-strong)', color: 'var(--text-secondary)' }}>
                {estimating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : estimate ? <RefreshCw className="h-3.5 w-3.5" /> : <Calculator className="h-3.5 w-3.5" />}
                {estimate ? '重新预估' : '生成预估'}
              </button>
            </div>
            {estimate ? (
              <div className="mt-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-color)' }}><div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>预计时长</div><div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatDuration(estimate.estimated_duration_seconds_range[0])} - {formatDuration(estimate.estimated_duration_seconds_range[1])}</div></div>
                  <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-color)' }}><div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>预计成本</div><div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>${estimate.estimated_cost_usd_range[0].toFixed(2)} - ${estimate.estimated_cost_usd_range[1].toFixed(2)}</div></div>
                </div>
                {estimate.estimated_parallel_speedup > 1 && (
                  <p className="mt-2 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
                    串行基线约 {formatDuration(estimate.estimated_serial_duration_seconds_range[0])} - {formatDuration(estimate.estimated_serial_duration_seconds_range[1])}；当前策略预计最高约 {estimate.estimated_parallel_speedup.toFixed(2)}× 加速，并包含额外综合与重复上下文成本。
                  </p>
                )}
                <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={estimateConfirmed} onChange={(event) => setEstimateConfirmed(event.target.checked)} className="mt-1 accent-sky-500" />
                  <span>我已查看本次只读 {effectiveShape === 'pipeline' ? '流水线' : '智能调度'}的时长、成本与系统并发上限，并确认按当前阵容创建。</span>
                </label>
              </div>
            ) : <p className="mt-2 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>选定 Main 和可用模型后生成预估。系统会自动预留最多 {Math.min(4, features.max_parallel_subs)} 个 Worker 实例，Main 决定实际启用数量。</p>}
          </div>
        )}

        {error && <div role="alert" className="mt-3 text-[11px] leading-5" style={{ color: '#f87171' }}>{error}</div>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>权限边界由服务端 Roster 与 scoped token 执行</span>
          <button type="button" onClick={handleCreate} disabled={!canSubmit}
            className="btn-primary inline-flex min-h-11 items-center gap-2 rounded-md px-4 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            创建 Harness Run
          </button>
        </div>
      </div>

      {snapshot && <HarnessRunView snapshot={snapshot} />}
    </section>
  )
}
