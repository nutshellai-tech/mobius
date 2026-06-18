# RFC · Long-running task completion notifications

> Proposed: 2026-05-16  
> Status: Under review  
> Related: tmux-agent-hub + jsonl-watcher stack  
> Motivation: Users report Claude says "I'll notify you when done" but Mobius never notifies

---

## 1. Problem

### User-visible symptom

User gives Claude a long task (e.g. 22-page PDF OCR, tens of minutes to hours). Claude starts a background script and replies:

> "Script started; you'll be notified when it finishes."

Mobius has **no automatic notification**. The user must poll manually:

```
User: How's it going?
Claude: (grep progress) 17/22, ~10 min left
User: (5 min later) How's it going?
...
```

**Essence**: the user does what the machine should do (polling). Each check costs tokens and attention.

### Example (2026-05-16)

22-page PDF → MusicXML via Audiveris, then LilyPond. Script:

```bash
bash /tmp/process_all_pages.sh > /tmp/process_pages_console.log 2>&1
```

Claude used `until grep ... sleep 4 ... done` but Bash tool timeout (~120s) cut it off before completion. Claude said **"Batch running (~6–7 min). Wait for notification."** — no notification ever arrived.

---

## 2. Root cause (three layers)

### 2.1 Bash tool timeout

`Bash` timeout ~120s. Blocking `until grep; sleep; done`:

- ≤2 min: loop completes, Claude reports
- \>2 min: timeout; task may still run → "wait for notification"
- Hours: impossible to block

### 2.2 Turn-based architecture has no external wake

```
user message → context → Claude streams → turn ends → idle
                                              ↑
                                    next turn needs user input
```

No hook for **external event → new Claude turn** after idle.

`jsonl-watcher` tails Claude's own JSONL, not user script logs like `/tmp/process.log`.

### 2.3 Claude expectation vs Mobius reality

Claude Code has `/loop`, `/goal`, etc. Saying "wait for notification" is reasonable there. Mobius does not wire `/loop` — optimistic mismatch.

---

## 3. Existing mechanisms

| Mechanism | Can solve? | Blocker |
|-----------|------------|---------|
| `until grep; sleep` | Partial | 2 min Bash timeout |
| `nohup &` + user polling | No | Manual only |
| Claude `/loop` | Yes* | Not integrated in Mobius |
| jsonl-watcher | Partial | Watches Claude JSONL only |
| Browser Notification API | Notify UI only | Does not wake agent |
| Chat bot push | Notify only | Same |

---

## 4. Proposal: Watch Daemon + dual modes

### 4.1 Overview

```
Claude (in Bash):
  1. nohup long_task.sh > /tmp/x.log &
  2. mobius-watch register --session=$CC_SESSION_ID \
       --file=/tmp/x.log --pattern='ALL DONE|FAILED' \
       --mode=notify  # or notify-wake
  3. Turn ends without blocking

Watch Daemon (Node, same process as Mobius):
  - Scan ~/.imac/watches/
  - fs.watch + tail per watch
  - On pattern match → notify (+ optional wake)
```

### 4.2 Mode A: notify-only (default)

- Insert `role='system'` message (`completion_notification`)
- WebSocket push to session subscribers
- Browser Notification API if permitted
- Title/badge flash

Does **not** auto-wake Claude. User returns and asks to continue.

### 4.3 Mode B: notify + wake (opt-in)

Also inject a user message with tail output so Claude continues automatically.

Trade-offs: token cost, possible interruption, abuse risk.

**Recommendation**: default `notify`; opt-in `notify-wake` with per-session cap (e.g. 3 active wake watches).

---

## 5. Claude-side CLI

```bash
mobius-watch register \
  --file=/tmp/process.log \
  --pattern='ALL DONE|FAILED|EXIT=1' \
  --message='OCR finished 22/22 pages' \
  --mode=notify \
  --ttl=3h

mobius-watch list
mobius-watch cancel <watch_id>
```

Watch file: `~/.imac/watches/<session_id>/<uuid>.json`

Inject at spawn:

```bash
export CC_SESSION_ID=abc12345
export CC_USER_ID=<user_id>
```

---

## 6. Companion Skill

Shared Skill `imac-long-running/SKILL.md` teaches:

- Tasks ≥1.5 min → `nohup` + `mobius-watch register`
- Do **not** use blocking `until grep` for long jobs
- Do **not** say "wait for notification" without registering a watch

---

## 7. Effort estimate

| Module | ~lines | ~days |
|--------|--------|-------|
| watch-daemon.js | 300 | 1 |
| watch-store.js | 80 | 0.5 |
| watch-admin routes | 60 | 0.5 |
| CLI `mobius-watch` | 150 | 0.5 |
| WS + frontend cards | 180 | 1 |
| Skill doc | 120 | 0.5 |
| CC_SESSION_ID injection | 10 | 0.1 |
| Test/docs | — | 1 |
| **Total** | **~780** | **~5** |

---

## 8. Risks

| Risk | Mitigation |
|------|------------|
| Daemon crash | Persist watches; reload on restart |
| Wake abuse | Per-session/global quotas |
| Zombie watches | Required `--ttl`, default 6h |
| fs.watch on NFS | Polling fallback |
| False positive patterns | Use explicit markers; `--anchor=last-line` |
| Cross-user access | Validate session ownership |

---

## 9. Relation to Claude `/loop`

- `/loop`: active periodic repeat
- `mobius-watch`: passive event trigger (one turn on completion)

Complementary; watch is more token-efficient for long one-shot jobs.

---

## 10. Decision options

| Option | Scope | Effort |
|--------|-------|--------|
| A | notify-only | ~4 days |
| B | notify + opt-in wake | ~5 days |
| C | Skill only (no daemon) | 0.5 day |
| D | Wait for `/loop` upstream | 0 |

**Recommended: B** — wake is opt-in; Skill needed in all cases.

---

## 11. Implementation sequence (if B approved)

```
Day 1  CC_SESSION_ID env + watch-store + CLI skeleton
Day 2  watch-daemon + DB system messages
Day 3  WS events + frontend notification UI
Day 4  wake mode + quotas + admin endpoints
Day 5  Skill + end-to-end test + docs
```

---

## 12. Fit with current architecture

`jsonl-watcher` and `watch-daemon` share the same file-tail pattern; consider shared `services/file-tail-watcher.js`.

---

> Maintainers: append review comments to this document or open a GitHub discussion.
