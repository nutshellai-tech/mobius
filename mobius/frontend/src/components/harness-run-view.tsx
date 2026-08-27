import { useState } from 'react'
import { AlertTriangle, Check, CircleDollarSign, Clock3, FileSearch, Loader2, Network, X } from 'lucide-react'
import {
  cancelHarnessNode,
  cancelHarnessRun,
  retryHarnessNode,
  waiveHarnessNode,
  type HarnessEvent,
  type HarnessMemberSnapshot,
  type HarnessNodeSnapshot,
  type HarnessRunSnapshot,
} from '../services/harness'
/*
 * Control calls are intentionally user-authenticated. Main may recommend a
 * retry or waiver, but cannot impersonate the user for lifecycle decisions.
 */

const STATUS_LABEL: Record<string, string> = {
  created: '已创建', planning: '规划中', queued: '等待调度', starting: '正在启动', running: '执行中',
  waiting_input: '等待输入', submitted: '已提交', verifying: '验收中', succeeded: '已通过',
  completed: '已完成', failed: '失败', cancelled: '已取消', uncertain: '投递待确认', blocked: '已阻塞',
  timed_out: '已超时', interrupted: '已中断', orphaned: '待恢复', cancelling: '取消中', ready: '可调度',
}

const EVENT_LABEL: Record<string, string> = {
  'run.created': 'Run 已创建', 'run.roster_locked': '阵容已锁定', 'run.started': 'Run 已开始',
  'run.completed': 'Run 已完成', 'run.failed': 'Run 失败', 'node.created': 'Sub 任务已创建',
  'node.queued': '节点进入队列', 'node.starting': '节点正在启动', 'node.started': '节点开始执行',
  'node.progress': '节点进度', 'node.submitted': '节点提交结果', 'node.succeeded': '节点验收通过',
  'node.failed': '节点失败', 'node.transition_rejected': '状态转换被拒绝',
  'node.batch_created': '批量任务已创建', 'node.dependency_blocked': '依赖已阻塞',
  'node.resource_blocked': '等待调度容量',
  'member.task_assigned': '任务已分派', 'dispatch.queued': '投递已排队',
  'dispatch.delivered': '投递已确认', 'dispatch.uncertain': '投递结果不确定', 'dispatch.failed': '投递失败',
}

function statusTone(status: string): { dot: string; text: string } {
  if (['completed', 'succeeded'].includes(status)) return { dot: '#22c55e', text: '#4ade80' }
  if (['failed', 'cancelled', 'timed_out', 'interrupted'].includes(status)) return { dot: '#ef4444', text: '#f87171' }
  if (['uncertain', 'waiting_input', 'blocked', 'orphaned', 'cancelling'].includes(status)) return { dot: '#f59e0b', text: '#fbbf24' }
  if (['planning', 'queued', 'starting', 'running', 'submitted', 'verifying'].includes(status)) return { dot: '#38bdf8', text: '#7dd3fc' }
  return { dot: 'var(--text-muted)', text: 'var(--text-secondary)' }
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status)
  const active = ['planning', 'queued', 'starting', 'running', 'submitted', 'verifying'].includes(status)
  return (
    <span className="inline-flex min-h-6 items-center gap-1.5 rounded border px-2 text-[11px] font-medium"
      style={{ color: tone.text, borderColor: 'var(--border-color-strong)', background: 'var(--bg-card)' }}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'animate-pulse' : ''}`} style={{ background: tone.dot }} />
      {STATUS_LABEL[status] || status}
    </span>
  )
}

function elapsedLabel(start?: string | null, end?: string | null): string {
  if (!start) return '尚未开始'
  const ms = Math.max(0, new Date(end || Date.now()).getTime() - new Date(start).getTime())
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function eventDetail(event: HarnessEvent): string {
  const payload = event.payload || {}
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.reason === 'string') return payload.reason
  if (typeof payload.path === 'string') return payload.path
  if (typeof payload.kind === 'string') return String(payload.kind)
  return ''
}

function NodeStage({ node, member, index, total, showConnector, dependencyLabels }: {
  node: HarnessNodeSnapshot
  member?: HarnessMemberSnapshot
  index: number
  total: number
  showConnector?: boolean
  dependencyLabels?: string[]
}) {
  const displayStatus = node.blocked_by.length > 0 ? 'blocked' : node.ready ? 'ready' : node.status
  const failed = node.status === 'failed'
  const done = node.status === 'succeeded'
  const active = ['queued', 'starting', 'running', 'submitted', 'verifying'].includes(node.status)
  return (
    <div className="relative min-w-0 flex-1">
      {showConnector && index < total - 1 && (
        <div aria-hidden="true" className="absolute left-6 top-6 hidden h-px w-[calc(100%-1.5rem)] sm:block"
          style={{ background: done ? 'rgba(34,197,94,.55)' : 'var(--border-color-strong)', transform: 'translateX(1.5rem)' }} />
      )}
      <div className="relative flex min-h-[126px] flex-col rounded-md border p-3"
        style={{ borderColor: active ? 'rgba(56,189,248,.42)' : failed ? 'rgba(239,68,68,.38)' : 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="flex items-start gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
            style={{ borderColor: done ? 'rgba(34,197,94,.55)' : failed ? 'rgba(239,68,68,.5)' : 'var(--border-color-strong)', color: done ? '#4ade80' : failed ? '#f87171' : 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
            {done ? <Check className="h-3.5 w-3.5" /> : failed ? <X className="h-3.5 w-3.5" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="text-[10px] font-semibold">{index + 1}</span>}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{member?.display_name || node.model}</span>
              <span className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{node.node_type}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-dimmed)' }}>{node.path}</div>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>{node.task_contract.objective}</p>
        {dependencyLabels && dependencyLabels.length > 0 && (
          <p className="mt-1 text-[10px] leading-4" style={{ color: '#fbbf24' }}>等待：{dependencyLabels.join('、')}</p>
        )}
        {node.waiting_reason?.startsWith('resource:') && (
          <p className="mt-1 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>容量等待：{node.waiting_reason.replace('resource:', '')}</p>
        )}
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <StatusBadge status={displayStatus} />
          <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{elapsedLabel(node.started_at, node.completed_at)}</span>
        </div>
      </div>
    </div>
  )
}

export function HarnessRunView({ snapshot }: { snapshot: HarnessRunSnapshot }) {
  const [controlPending, setControlPending] = useState('')
  const [controlNotice, setControlNotice] = useState('')
  const memberById = new Map(snapshot.members.map((member) => [member.id, member]))
  const result = snapshot.run.final_result || snapshot.nodes.find((node) => node.node_type === 'root')?.result
  const events = [...snapshot.events].reverse().slice(0, 12)
  const costLabel = snapshot.run.cost_telemetry_status === 'not_started'
    ? '尚未产生'
    : snapshot.run.cost_telemetry_status === 'zero_or_unreported'
      ? '$0.000 或未上报'
      : `$${Number(snapshot.run.actual_cost_usd || 0).toFixed(3)}`
  const subNodes = snapshot.nodes.filter((node) => node.node_type !== 'root')
  const activeStates = ['queued', 'starting', 'running', 'waiting_input', 'submitted', 'verifying']
  const activeCount = subNodes.filter((node) => activeStates.includes(node.status)).length
  const readyCount = subNodes.filter((node) => node.ready).length
  const blockedCount = subNodes.filter((node) => node.blocked_by.length > 0).length
  const maxConcurrency = Number(snapshot.run.policy.max_concurrent_subharnesses || 1)
  const topologyLabel = snapshot.run.policy.collaboration_shape === 'fanout'
    ? '并行探索'
    : snapshot.run.policy.collaboration_shape === 'adaptive' ? '智能调度' : '流水线'
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const activeNodeByMember = new Map(subNodes.filter((node) => activeStates.includes(node.status)).map((node) => [node.assignee_member_id, node]))
  const lifecycleNodes = subNodes.filter((node) => (
    activeStates.includes(node.status)
    || ['created', 'failed', 'timed_out', 'interrupted', 'orphaned', 'cancelled'].includes(node.status)
  ))
  const runTerminal = ['completed', 'failed', 'cancelled'].includes(snapshot.run.status)

  const askReason = (label: string) => {
    const reason = window.prompt(`${label}原因（至少 3 个字符）`)?.trim() || ''
    return reason.length >= 3 ? reason : ''
  }

  const runControl = async (key: string, action: () => Promise<unknown>) => {
    setControlPending(key)
    setControlNotice('')
    try {
      await action()
      setControlNotice('操作已提交，状态将在下一次刷新后更新。')
    } catch (cause: any) {
      setControlNotice(cause?.message || 'Harness 控制操作失败')
    } finally {
      setControlPending('')
    }
  }

  return (
    <section className="mt-3 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>主 Thread</h3>
            <StatusBadge status={snapshot.run.status} />
            <span className="inline-flex min-h-6 items-center gap-1 rounded border px-2 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
              <FileSearch className="h-3 w-3" />prompt_enforced 只读
            </span>
            <span className="inline-flex min-h-6 items-center rounded border px-2 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
              {topologyLabel} · {activeCount}/{maxConcurrency} 并发
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>{snapshot.run.goal}</p>
        </div>
        <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="inline-flex items-center gap-1"><Network className="h-3 w-3" />{snapshot.nodes.length} 个节点</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{elapsedLabel(snapshot.run.started_at || snapshot.run.created_at, snapshot.run.completed_at)}</span>
          <span className="inline-flex items-center gap-1" title="来自节点 Session 的 total_cost_usd；零值可能表示 backend 尚未上报成本"><CircleDollarSign className="h-3 w-3" />{costLabel}</span>
          {!runTerminal && (
            <button type="button" disabled={!!controlPending} onClick={() => {
              const reason = askReason('取消整个 Run 的')
              if (reason) void runControl('run:cancel', () => cancelHarnessRun(snapshot.run.id, reason))
            }} className="min-h-7 rounded border px-2 text-[10px] disabled:opacity-50"
              style={{ borderColor: 'rgba(239,68,68,.35)', color: '#f87171' }}>
              {controlPending === 'run:cancel' ? '取消中…' : '取消 Run'}
            </button>
          )}
        </div>
      </div>

      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span>运行/预留 {activeCount}</span><span>可调度 {readyCount}</span><span>依赖阻塞 {blockedCount}</span>
          {snapshot.members.filter((member) => member.role !== 'main').map((member) => (
            <span key={member.id} className="rounded border px-2 py-1" style={{ borderColor: 'var(--border-color)' }}>
              {member.display_name} · {activeNodeByMember.has(member.id) ? '占用' : '空闲'}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={snapshot.run.policy.collaboration_shape === 'pipeline' ? 'Harness 流水线' : 'Harness DAG'}>
          {snapshot.nodes.map((node, index) => (
            <NodeStage key={node.id} node={node} member={memberById.get(node.assignee_member_id)} index={index} total={snapshot.nodes.length}
              showConnector={snapshot.run.policy.collaboration_shape === 'pipeline'}
              dependencyLabels={node.blocked_by.map((nodeId) => nodeById.get(nodeId)?.path || nodeId)} />
          ))}
        </div>

        {lifecycleNodes.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
            <span className="mr-1 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>节点恢复</span>
            {lifecycleNodes.map((node) => {
              const name = memberById.get(node.assignee_member_id)?.display_name || node.path
              const retryable = ['failed', 'timed_out', 'interrupted'].includes(node.status)
                && !node.waived_at && Number(node.attempt) < Number(node.max_attempts)
              const waivable = ['failed', 'timed_out', 'interrupted', 'orphaned', 'cancelled'].includes(node.status)
                && !node.waived_at
              const cancellable = ['created', ...activeStates].includes(node.status)
              return (
                <span key={node.id} className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
                  <span className="max-w-[140px] truncate">{name}</span>
                  {retryable && <button type="button" disabled={!!controlPending} className="rounded px-1 text-sky-400 disabled:opacity-50" onClick={() => {
                    const reason = askReason(`重试 ${name} 的`)
                    if (reason) void runControl(`${node.id}:retry`, () => retryHarnessNode(snapshot.run.id, node.id, reason))
                  }}>重试</button>}
                  {cancellable && <button type="button" disabled={!!controlPending} className="rounded px-1 text-red-400 disabled:opacity-50" onClick={() => {
                    const reason = askReason(`取消 ${name} 的`)
                    if (reason) void runControl(`${node.id}:cancel`, () => cancelHarnessNode(snapshot.run.id, node.id, reason))
                  }}>取消</button>}
                  {waivable && <button type="button" disabled={!!controlPending} className="rounded px-1 text-amber-400 disabled:opacity-50" onClick={() => {
                    const reason = askReason(`豁免 ${name} 的`)
                    if (reason) void runControl(`${node.id}:waive`, () => waiveHarnessNode(snapshot.run.id, node.id, reason))
                  }}>豁免</button>}
                  {node.waived_at && <span className="px-1 text-emerald-400">已豁免</span>}
                </span>
              )
            })}
            {controlNotice && <span className="basis-full text-[10px]" style={{ color: 'var(--text-muted)' }}>{controlNotice}</span>}
          </div>
        )}

        {result && (
          <div className="mt-4 border-l-2 py-1 pl-3" style={{ borderColor: result.status === 'succeeded' ? '#22c55e' : '#f59e0b' }}>
            <div className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>最终结果</div>
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{result.summary}</p>
            {(result.unresolved?.length > 0 || result.risks?.length > 0) && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-5" style={{ color: '#fbbf24' }}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{[...(result.risks || []), ...(result.unresolved || [])].join('；')}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="mb-2 text-[10px] font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>结构化事件</div>
          {events.length === 0 ? (
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无事件</div>
          ) : (
            <ol className="space-y-1.5">
              {events.map((event) => (
                <li key={event.event_id} className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-start gap-2 text-[11px]">
                  <span className="font-mono tabular-nums" style={{ color: 'var(--text-dimmed)' }}>#{event.seq}</span>
                  <span className="min-w-0" style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text-primary)' }}>{EVENT_LABEL[event.type] || event.type}</span>
                    {eventDetail(event) && <span className="ml-2 break-words" style={{ color: 'var(--text-muted)' }}>{eventDetail(event)}</span>}
                  </span>
                  <time className="whitespace-nowrap tabular-nums text-[10px]" style={{ color: 'var(--text-dimmed)' }}>
                    {new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  )
}
