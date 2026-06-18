# Mobius backend HTTP endpoints

> Code: `mobius/server.js` + `mobius/backend/routes/*`  
> Port: `45614` (HTTP), see `mobius/backend/config.js → PORT`  
> Start: `python3 start_debug.py` / `python3 start_product.py`  
> Base path: most APIs under `/api/*`; Code-Server proxy under `/code-server/*`; extension static assets under `/extension/*`

## Conventions

| Item | Convention |
| --- | --- |
| Auth | `auth` middleware: `Authorization: Bearer <token>` or logged-in cookie (`cc-token`). `adminAuth` also requires `user.role === 'admin'`. `downloadAuth` supports `?token=...` for native browser downloads |
| Body | `application/json`, `express.json({ limit: '10mb' })` |
| Auth exemptions | `/api/auth/config`, `/api/auth/login`, `/api/health/*`, `/api/v2/health|hello|db-check`, `/api/research-blackboard/*`, `/api/research-graph/:researchId` (read graph only), `/api/extensions` (GET `/` and `/:name`, `/:name/build-status` require auth) |
| Errors | `{ "error": "<message>" }`, sometimes `code`, `usage`, `raw_reason`, etc. |
| IDs | Resource IDs default to `uuid().slice(0, 8)` short strings |

---

## 1. Top-level / health

> Mounted directly on `app` (`mobius/server.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v2/health` | No | Liveness: `version` / `git_commit` / `uptime_ms` / `port` |
| GET | `/api/v2/hello` | No | `{ msg, t }` |
| GET | `/api/v2/db-check` | No | Row counts for `users` / `projects` / `issues` / `researches` / `sessions`(v1+v2) / `messages`(v1+v2) |

---

## 2. `/api/auth` — login and accounts

> Source: `mobius/backend/routes/auth.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | No | Login page bootstrap config |
| POST | `/api/auth/login` | No | Username/password login, issues JWT |
| GET | `/api/auth/me` | auth | Current user |
| POST | `/api/auth/change-password` | auth | Change password |

---

## 3. `/api/health` — health and metrics

> Source: `mobius/backend/routes/health.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health/` | No | `{ status, agent_backend, timestamp }` |
| GET | `/api/health/memory` | No | Server memory, 60s cache: `totalMb/usedMb/availMb/usedPercent/sampledAt/cached` |

---

## 4. `/api/tasks` — Issue v1 compatibility

> Source: `mobius/backend/routes/tasks.js` — legacy frontend, shared `issues` table

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/tasks/` | auth | List visible tasks, `?status=...` |
| POST | `/api/tasks/` | auth | Create task |
| GET | `/api/tasks/:id` | auth | Get task |
| PATCH | `/api/tasks/:id` | auth | Update title / description / status / pinned |
| DELETE | `/api/tasks/:id` | auth | Soft delete (trash) |
| POST | `/api/tasks/:id/restore` | auth | Restore from trash |
| DELETE | `/api/tasks/:id/permanent` | auth | Permanent delete |
| GET | `/api/tasks/:id/messages` | auth | All session messages for task |
| GET | `/api/tasks/:id/bookmarks` | auth | Bookmarked messages |
| GET | `/api/tasks/:id/risk` | No | Risk assessment (public) |

---

## 5. `/api/messages` — messages

> Source: `mobius/backend/routes/messages.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| PATCH | `/api/messages/:id/bookmark` | auth | Toggle bookmark (`{ id, bookmarked: 0|1 }`) |

---

## 6. `/api/projects` — projects

> Source: `mobius/backend/routes/projects.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/projects/` | auth | List visible projects |
| POST | `/api/projects/` | auth | Create project |
| DELETE | `/api/projects/:id` | adminAuth | Hard delete (admin only) |
| POST | `/api/projects/:id/hide` | auth | Hide for current user |
| POST | `/api/projects/:id/unhide` | auth | Unhide |
| POST | `/api/projects/:id/purge` | auth | Clear project workspace |
| PATCH | `/api/projects/:id/star` | auth | Toggle star |
| PATCH | `/api/projects/:id` | auth | Update name / description / bind_path / worktree / kind / research / templates |
| GET | `/api/projects/:id/git-tracking` | auth | Git tracking state |
| POST | `/api/projects/:id/deploy-version` | auth | Deploy version (commit/branch) |
| POST | `/api/projects/:id/hard-reset-version` | auth | Hard reset to version |
| GET | `/api/projects/:id/todos` | auth | List project todos |
| POST | `/api/projects/:id/todos` | auth | Add todo |
| PATCH | `/api/projects/:id/todos/:todoId` | auth | Update todo |
| DELETE | `/api/projects/:id/todos/:todoId` | auth | Delete todo |
| PUT | `/api/projects/:id/todos/reorder` | auth | Reorder todos |
| GET | `/api/projects/:id/architecture-session-preset/context-preview` | auth | Architecture session context preview (GET) |
| POST | `/api/projects/:id/architecture-session-preset/context-preview` | auth | Same (POST body) |
| GET | `/api/projects/:id/architecture-session-preset/session-selection-defaults` | auth | Architecture session selection defaults |
| POST | `/api/projects/:id/architecture-issue` | auth | Create issue from architecture diagram |
| GET | `/api/projects/:id/architecture-figure` | auth | Read architecture figure |
| GET | `/api/projects/:id/user-context-whitelist` | auth | User context whitelist |
| PATCH | `/api/projects/:id/user-context-whitelist` | auth | Update whitelist |
| POST | `/api/projects/:id/guided-demo/import/clear-upload-sample` | auth | Clear guided demo upload sample |
| GET | `/api/projects/:id/files` | auth | List project directory files |

---

## 7. `/api/issues` — issues

> Source: `mobius/backend/routes/issues.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/issues/:id` | auth | Issue detail |
| GET | `/api/issues/:id/skills` | auth | Effective skills for issue |
| PATCH | `/api/issues/:id` | auth | Update issue |
| GET | `/api/issues/:id/context-preview` | auth | Context preview (GET) |
| POST | `/api/issues/:id/context-preview` | auth | Context preview (POST) |
| GET | `/api/issues/:id/session-selection-defaults` | auth | Session selection defaults |
| POST | `/api/issues/:id/complete` | auth | Mark issue complete |
| DELETE | `/api/issues/:id` | auth | Delete issue |

Project-scoped (`/api/projects/:projectId/issues`):

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/projects/:projectId/issues/` | auth | List issues, `?status=` |
| POST | `/api/projects/:projectId/issues/` | auth | Create issue |

---

## 8. `/api/sessions` — sessions

> Source: `mobius/backend/routes/sessions.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/sessions/prompt-stats` | auth | Prompt usage stats |
| GET | `/api/sessions/model-options` | auth | Available models (whitelist filtered) |
| PATCH | `/api/sessions/:id` | auth | Update session |
| DELETE | `/api/sessions/:id` | auth | Soft delete |
| DELETE | `/api/sessions/:id/permanent` | auth | Permanent delete |
| POST | `/api/sessions/:id/terminate` | auth | Graceful agent terminate |
| POST | `/api/sessions/:id/stop` | auth | Force stop agent |
| GET | `/api/sessions/:id/events` | authOrQuery | SSE event stream |
| GET | `/api/sessions/:id/status` | auth | Run status |
| GET | `/api/sessions/:id/turns` | auth | List turns |
| GET | `/api/sessions/:id/inputs` | auth | List user inputs |
| GET | `/api/sessions/:id/context-preview` | auth | Context preview |
| GET | `/api/sessions/:id/selection-snapshot` | auth | Skill/Memory snapshot at creation |
| POST | `/api/sessions/:id/messages` | auth | Send message / start turn |

Issue-scoped (`/api/issues/:issueId/sessions`):

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/issues/:issueId/sessions/` | auth | List sessions with `job_accomplished` / `job_failed` |
| POST | `/api/issues/:issueId/sessions/` | auth | Create session (does not auto-start) |

---

## 9. `/api/researches` — research

> Source: `mobius/backend/routes/researches.js`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/researches/:id` | auth | Research detail |
| PATCH | `/api/researches/:id` | auth | Update research |
| GET | `/api/researches/:id/context-preview` | auth | Context preview (GET/POST) |
| POST | `/api/researches/:id/context-preview` | auth | Context preview (POST) |
| GET | `/api/researches/:id/session-selection-defaults` | auth | Session defaults |
| GET | `/api/researches/:id/research-agent-skills` | auth | `research-*` agent skills |
| POST | `/api/researches/:id/complete` | auth | Mark complete |

Project-scoped: `GET/POST /api/projects/:projectId/researches/`

Research sessions: `GET/POST /api/researches/:researchId/sessions/` — `role` ∈ `chief_researcher` / `research_assistant`

---

## 10. `/api/research-blackboard` and `/api/research-graph`

> No auth — agents can curl directly

### Blackboard

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/research-blackboard/:researchId` | No | NDJSON stream of all records |
| POST | `/api/research-blackboard/:researchId` | No | Append `{ author, content, metadata? }` |

### Research graph

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/research-graph/:researchId` | No | Parsed `research-graph.yml` |
| GET | `/api/research-graph/:researchId/image` | downloadAuth | Embedded image `?path=...` |

---

## 11. `/api/skills` — skills

User: `/api/skills/*` (`scope=user`). Project: `/api/projects/:projectId/skills/*`.

Key routes: list, catalog, copy, import-local, CRUD, move between user/project scopes.

---

## 12. `/api/memories` — memories

User: `/api/memories/*`. Project: `/api/projects/:projectId/memories/*`.

Notable project routes:

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/projects/:projectId/memories/project-knowledge/refresh` | Refresh `<bind_path>/.imac/project_knowledge.md` → memory |
| POST | `/api/projects/:projectId/memories/project-knowledge/upload` | Upload markdown as project knowledge |

---

## 13. `/api/files`, `/api/upload`, `/api/download`

> Source: `mobius/backend/routes/files.js`, mounted at `/api`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/upload` | auth | Multipart single file |
| GET | `/api/download` | downloadAuth | Download with optional `?token=` |
| GET | `/api/files` | auth | List directory `?path=` |
| POST | `/api/files/mkdir` | auth | Create directory |
| GET | `/api/files/read` | auth | Read file |
| PUT | `/api/files/write` | auth | Write file `{ path, content }` |

---

## 14. `/api/assistant` — Momo assistant

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/assistant/sessions` | List Momo sessions |
| GET | `/api/assistant/workspace` | Get/create Momo project+issue |
| GET/POST | `/api/assistant/preset` | Momo preset (model/skills/memories) |
| GET/POST | `/api/assistant/preset/context-preview` | Preset context preview |
| GET | `/api/assistant/preset/session-selection-defaults` | Selection defaults |
| GET | `/api/assistant/sessions/:id` | Session detail |
| POST | `/api/assistant/transcribe` | Speech-to-text |
| GET | `/api/assistant/tts/voices` | TTS voices |
| POST | `/api/assistant/speak` | TTS synthesis |
| POST | `/api/assistant/messages` | Send Momo message |

---

## 15. `/api/aimux` — remote compute

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/aimux/remotes` | List remotes |
| POST | `/api/aimux/remotes/test` | Connectivity test |
| POST | `/api/aimux/remotes/hardware` | Hardware info |
| POST | `/api/aimux/remotes/browse` | Browse remote directory |
| POST | `/api/aimux/remotes` | Add/update remote |

---

## 16. `/api/admin` — admin (all `adminAuth`)

Sections: user groups, users, tasks/stats/tmux, agent defaults, model access, skill/memory bulk ops, code-server pool (`GET /api/admin/code-server/list`).

---

## 17. `/code-server` — Code-Server proxy

Path: `/code-server/<userId>__<projectId>/<rest>`. Auth via `cc_cs_jwt` cookie or `?_jwt=`. WebSocket upgrade on same path.

---

## 18. Extensions — `/api/extensions`, `/api/ext`, `/extension`

### Meta (`/api/extensions`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/extensions/` | List extensions |
| GET | `/api/extensions/:name` | Manifest |
| GET | `/api/extensions/:name/build-status` | Build status |
| POST | `/api/extensions/reload` | admin: rescan |
| POST | `/api/extensions/:name/rebuild` | admin: rebuild frontend |

### Invoke (`/api/ext`)

`POST /api/ext` — body `{ extension_name, ext_main_payload? }`, worker_thread, 30s cap, 1 rps/user limit.

### Static (`/extension`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/extension/_sdk/ext.js` | Shared SDK |
| GET | `/extension/:name/` | Loading page or `index.html` |
| GET | `/extension/:name/<asset>` | `dist/<asset>` |

---

## 19. Integration — changes / conflicts / queue

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/sessions/:id/changes` | Session change scan |
| POST | `/api/sessions/:id/changes/scan` | Rescan |
| POST | `/api/sessions/:id/changes/check` | Run checks |
| GET | `/api/issues/:id/integration` | Issue integration state |
| POST | `/api/issues/:id/integration/check` | Scan all active sessions |
| POST | `/api/issues/:id/integration/accept` | Accept/reject with `release_note` |
| POST | `/api/issues/:id/integration/enqueue` | Enqueue merge |
| GET | `/api/projects/:id/integration-queue` | Project queue |
| POST | `/api/projects/:id/integration-queue/reorder` | admin: reorder |
| POST | `/api/projects/:id/integration-queue/run` | admin: run queue |
| GET | `/api/conflicts` | List conflicts `?project_id=` |
| PATCH | `/api/conflicts/:id` | admin: resolve conflict |

---

## 20. Static frontend and SPA fallback

- `mobius/public` served via `express.static`; unmatched non-API routes → `index.html`.
- WebSocket: only `/code-server/*`; otherwise SSE + HTTP POST.

---

## 21. `/aimux_bridge` — aimux bridge reverse proxy

> Source: `mobius/backend/routes/aimux-bridge-proxy.js`  
> Upstream: `http://127.0.0.1:${AIMUX_BRIDGE_PORT:-45615}`  
> Auth: Mobius JWT; bridge Bearer token from `runtime.json`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/aimux_bridge/api/health` | Bridge heartbeat |
| GET | `/aimux_bridge/api/remotes` | Connected remotes |
| GET | `/aimux_bridge/api/sessions` | Bridge sessions |
| POST | `/aimux_bridge/api/sessions` | Create session on remote |
| POST | `/aimux_bridge/api/sessions/:remote/:name/send-keys` | Send keys |
| POST | `/aimux_bridge/api/sessions/:remote/:name/capture` | Capture screen |
| POST | `/aimux_bridge/api/sessions/:remote/:name/kill` | Kill session |
| POST | `/aimux_bridge/api/remotes/:remote/files/:action` | `stat|read|write|mkdir|list` |
| POST | `/aimux_bridge/client/register` | Client register |
| GET | `/aimux_bridge/client/events` | SSE (`?identifier=`) |
| POST | `/aimux_bridge/client/result` | Client result |

See aimux `docs/bridge-protocol.md` for error codes and field semantics.

---

## 22. Middleware appendix

- `mobius/backend/middleware/auth.js`: `auth` / `adminAuth` / `downloadAuth`.
- Extension invoke: `mobius/backend/services/extension-invoker.js` via `worker_threads`.

---

> Maintenance: when adding endpoints, update this doc and `mobius/server.js` `app.use(...)` mounts. Default auth is `auth`; admin routes must use `adminAuth`.
