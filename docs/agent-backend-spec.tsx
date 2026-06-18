/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ ✅ LIVE — agent abstraction layer is in production                          ║
   ║                                                                          ║
   ║  Implementations:                                                         ║
   ║    - Production: backend/agents/tmux-claude-code.js (TUI + tmux)          ║
   ║    - DEAD: backend/agents/claude-code.js (stream-json direct spawn)       ║
   ║    - DEAD: backend/agents/opencode.js (stub)                              ║
   ║  Callers: chat.js / sessions.js /status / bridge/instance.js              ║
   ║  Instance: require('../agents').get('tmux-claude-code')                   ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
/**
 * communication.tsx — Mobius ↔ coding agent communication abstraction
 *
 * All agent interaction (claude-code / opencode / ...) exposes five methods:
 *
 *   createNewSession                          New session, spawn agent, send first user message
 *   pauseCurrentAndResumeFromSession          Interrupt generation, send new prompt on same history
 *   noPauseCurrentAndQueueQueryAtSession      Queue prompt; current turn finishes first
 *   terminateSession                          Kill process, clear runtime
 *   getAgentRawThoughtStream                  Subscribe to JSON-parsed stdout lines from agent
 *
 * Upper layers call only these five methods; backends map them to CLI operations.
 *
 * Output: each stdout line is JSON.parse'd and forwarded raw. Protocols differ per backend;
 * upper layers branch on backend.name. No normalization — would lose information.
 */

// ============================================================
// 1. Input types
// ============================================================

export type SessionId = string                  // Mobius session_id, upper-layer primary key
export type AgentSessionId = string             // Agent-native session id (Claude uses UUID)

export interface SessionOpts {
  sessionId: SessionId
  cwd: string                                   // Agent working directory
  model?: string                                // 'opus' | 'sonnet' | ... backend-specific
  displayName?: string
  addDirs?: string[]                            // Extra authorized directories
  env?: Record<string, string>                  // Extra env injection
}

export interface CreateSessionOpts extends SessionOpts {
  initialPrompt: string
  agentSessionId?: AgentSessionId               // Resume with given id; else capture from stdout
}

export interface ResumeOpts {
  sessionId: SessionId
  prompt: string
}

export interface SessionHandle {
  sessionId: SessionId
  agentSessionId: AgentSessionId
  startedAt: number
}

export type RawListener = (raw: unknown) => void
export type Unsubscribe = () => void


// ============================================================
// 2. Abstract interface
// ============================================================

export interface AgentBackend {
  /** Unique id: 'claude-code' / 'opencode' / ... */
  readonly name: string

  /**
   * New session: spawn child, wait ready, send first user message.
   * Throw if sessionId already has a live process (caller should terminate first).
   */
  createNewSession(opts: CreateSessionOpts): Promise<SessionHandle>

  /**
   * Interrupt current generation, send new prompt — same history, current turn aborted.
   * Respawn with --resume if child died.
   * Empty prompt = interrupt only, no new prompt (lazy respawn).
   */
  pauseCurrentAndResumeFromSession(opts: ResumeOpts): Promise<void>

  /**
   * Queue prompt without interrupt — runs after current turn completes.
   */
  noPauseCurrentAndQueueQueryAtSession(opts: ResumeOpts): Promise<void>

  /** Kill process + clear runtime. Not resumable in-process (agent jsonl remains on disk). */
  terminateSession(sessionId: SessionId): Promise<void>

  /**
   * Subscribe to raw thought stream: JSON-parsed stdout lines, protocol passthrough.
   */
  getAgentRawThoughtStream(sessionId: SessionId, listener: RawListener): Unsubscribe

  /** True if runtime entry exists and child has not exited. */
  isAlive(sessionId: SessionId): boolean

  /** List active sessions (ops / debug). */
  listSessions(): Array<{ sessionId: SessionId; agentSessionId: AgentSessionId; pid: number | null }>
}


// ============================================================
// 3. ClaudeCodeBackend — long-lived stream-json child
// ============================================================
//
// See backend/agents/claude-code.md for details.
//
// Launch:
//   proxychains -q -f ~/proxy_claude.conf claude
//     --output-format stream-json
//     --input-format stream-json
//     --verbose
//     --dangerously-skip-permissions
//     [--resume <agentSessionId>] [--model M] [--name N]
//
// Protocol:
//   stdin:  one JSON line per user message
//   stdout: stream-json events (system/init, assistant, result, ...)
//
// Method mapping:
//   createNewSession                      spawn → write initialPrompt → wait system/init
//   noPauseCurrentAndQueueQueryAtSession  (alive) stdin write / (dead) --resume respawn
//   pauseCurrentAndResumeFromSession      SIGTERM→SIGKILL → --resume → stdin write
//   terminateSession                      stdin.end() → graceful wait → SIGTERM/SIGKILL
//
// Observed Claude behavior:
//   - stream-json needs first stdin user message before system/init
//   - system/init re-emits each turn
//   - result = turn end, not process end
//   - agentSessionId appears in system/init and result


// ============================================================
// 4. OpencodeBackend — placeholder
// ============================================================
//
// opencode CLI: one process per turn
//   opencode run --format json --session <chatID> ...
//
// Mapping differences documented in implementation notes.


// ============================================================
// 5. Factory + usage pattern
// ============================================================

export type BackendName = 'claude-code' | 'opencode'

export interface BackendRegistry {
  get(name: BackendName): AgentBackend
}

//
// Upper-layer chat pattern (sketch):
//
//   const backend = registry.get(session.backend ?? 'claude-code')
//   // onUserSend → createNewSession or pause/queue based on alive + interrupt flag
//   // getAgentRawThoughtStream → ws + jsonl append


// ============================================================
// 6. Call matrix (Mobius scenario → abstract method)
// ============================================================
//
//   Scenario                              Method
//   ─────────────────────────────────────────────────────────
//   First prompt in new session           createNewSession
//   Follow-up while generating (queue)    noPauseCurrentAndQueueQueryAtSession
//   Follow-up with explicit interrupt       pauseCurrentAndResumeFromSession
//   Follow-up when idle                     noPauseCurrentAndQueueQueryAtSession
//   User stop (no new prompt)               pauseCurrentAndResumeFromSession({prompt:''})
//   Delete session                          terminateSession


export {}
