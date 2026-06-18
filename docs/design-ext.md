# Mobius AI extension system (prototype / architecture)

> Goal: run "special apps" as independent tabs with **zero runtime coupling** to the main app; backend uses unified `/api/ext`; handlers run in isolated workers with a 30s cap, stateless execution, and data under a dedicated directory.

---

## 1. Terminology

| Term | Description |
|---|---|
| `extension_name` | kebab-case slug, globally unique, matches `^[a-z][a-z0-9-]{0,31}$` |
| Extension project | `projects.kind='extension'` row: `bind_path=APP_DIR`, `default_use_worktree=0`, `research_enabled=0` |
| Special app | Frontend + backend under `mobius/extension/<name>/`, opened in a new tab |
| handler | `mobius/extension/<name>/backend/extension_backend_handler.js`, sole backend entry |
| `ext_data_dir` | `APP_DIR/protected_data/extension/<name>/`, sole writable area for the handler |

---

## 2. Directory layout

```
mobius/extension/<name>/
  extension.json                 # manifest
  frontend/
    package.json                 # extension-owned build stack (vite recommended)
    index.html                   # new-tab entry
    src/...
    dist/                        # build output (generated on first visit)
  backend/
    extension_backend_handler.js # CommonJS, single entry
APP_DIR/protected_data/extension/<name>/   # data
```

### `extension.json`

```json
{
  "name": "pacman",
  "display_name": "Pac-Man",
  "description": "Classic Pac-Man with leaderboard",
  "version": "0.1.0",
  "icon": "icon.svg",
  "min_mobius_version": "1.9"
}
```

> Entry and handler paths are **not** in the manifest — fixed by convention to prevent path injection.

---

## 3. Data model changes

### 3.1 Two new `projects` columns

```sql
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
-- 'normal' | 'extension'
ALTER TABLE projects ADD COLUMN extension_name TEXT;
-- set only when kind='extension'; UNIQUE enforced in app layer
CREATE INDEX IF NOT EXISTS idx_projects_extension ON projects(extension_name) WHERE kind='extension';
```

Repository hard rule: `kind='extension'` rows cannot change `bind_path` / `default_use_worktree` / `research_enabled` / `kind` / `extension_name` via normal project APIs.

### 3.2 Sync strategy

On startup + `POST /api/admin/extensions/reload`: scan `mobius/extension/*/extension.json` into an in-memory **registry**, diff with DB:

- New → upsert `id='ext_'+name`, `name=display_name`, `created_by=SYSTEM_USER_ID`, `bind_path=APP_DIR`, `kind='extension'`, `extension_name=name`, `default_use_worktree=0`, `research_enabled=0`
- Missing → mark `disabled=1` (**do not delete** — preserve user issues/sessions under that project)

> Not deleting rows matters: user data under an extension project must survive temporary removal of `mobius/extension/<name>/`.

---

## 4. Backend routes

`server.js` adds three mounts:

```js
const ext = require('./backend/routes/ext');
app.use('/api/extensions',  ext.metaRouter);    // list / manifest / build status
app.use('/api/ext',         ext.invokeRouter);  // unified invoke
app.use('/extension',       ext.staticRouter);  // /extension/<name>/* static assets
```

### 4.1 `/api/extensions`

- `GET /api/extensions` → `[{name, display_name, description, version, icon_url, disabled, entry_url}]`
- `GET /api/extensions/:name/build-status` → `{state:'idle'|'building'|'ready'|'error', log_tail}`
- `POST /api/admin/extensions/reload` (admin)

### 4.2 `/api/ext` (core)

```
POST /api/ext
auth: existing JWT middleware
body: {
  "extension_name": "pacman",
  "ext_main_payload": { ... arbitrary JSON, ≤1MB ... }
}
```

> `username` is **not** sent by the frontend; backend injects from `req.user.username`.

Processing order:

1. Validate `extension_name` slug.
2. Registry lookup: missing / disabled → 404.
3. Load handler (cache invalidated by mtime for dev hot reload).
4. Spawn **`worker_thread`** with `{ username, ext_main_payload, ext_data_dir, mobius_version }`.
5. 30s timer → `worker.terminate()` → `504 { ok:false, error:'timeout' }`.
6. Worker error → `500 { ok:false, error, code }`.
7. Response JSON > 5MB → `502 { ok:false, error:'payload too large' }`.
8. Rate limit: 5 req/s per user → 429.

**Why worker_thread**: main-process handlers can DoS the server; child_process has higher startup cost; worker_thread starts ~10ms, isolates require cache, `resourceLimits.maxOldGenerationSizeMb=256`, clean `terminate()`.

### 4.3 `/extension/<name>/*` static (on-demand build)

```
GET /extension/<name>/        → if dist/ exists: serve dist/index.html (inject window.__EXT_NAME__)
                                else: loading.html + background vite build
GET /extension/<name>/<asset> → serve dist/<asset> (mime allowlist)
GET /extension/_sdk/ext.js    → shared client SDK
```

On-demand build:

- First visit when `dist/index.html` missing → enqueue `extension-builder` (dedupe per name), `npm run build` in `mobius/extension/<name>/frontend/`.
- loading.html polls `/api/extensions/<name>/build-status`, reload on `ready`.
- Failure → last 50 log lines to `protected_data/extension/<name>/_build.log`.

> No extension dev-server proxy (unlike code-server). Developers run `npm run build` locally or `POST /api/admin/extensions/<name>/rebuild`.

---

## 5. Handler contract

```js
// mobius/extension/<name>/backend/extension_backend_handler.js
module.exports = async function extension_backend_handler({
  username,           // string, injected by backend, trusted
  ext_main_payload,   // any JSON
  ext_data_dir,       // string, mkdir -p done
  logger,             // { info, warn, error } → _handler.log
}) {
  // resolve within 30s or terminate
  return { ok: true, data: { /* ... */ } };
};
```

| Item | Rule | Enforcement |
|---|---|---|
| Stateless | No connections / timers / in-memory cache at module top | new worker per call (no pool v1) |
| File IO | Only under `ext_data_dir` | `process.chdir(ext_data_dir)` at worker boot; docs + review |
| Network | Unrestricted v1 | whitelist later if needed |
| Duration | ≤30s | `worker.terminate()` |
| Return value | JSON ≤5MB | post-serialize size check |
| Module size | handler ≤512KB | stat before load |

---

## 6. Frontend loading and isolation

### 6.1 Entry

Main frontend `UserPage.tsx` card branch:

```tsx
{p.kind === 'extension' && (
  <div className="px-4 py-2 border-t flex justify-end">
    <button
      onClick={(e) => {
        e.stopPropagation();
        window.open(`/extension/${p.extension_name}/`, '_blank');
      }}
      className="h-7 px-3 rounded text-[12px] btn-primary">
      Open
    </button>
  </div>
)}
```

- Card click elsewhere → project home (same as normal projects).
- Project home hides worktree / research for `kind=extension`.

### 6.2 Isolation

| Risk | Mitigation |
|---|---|
| Extension JS in main bundle | Main frontend never imports `mobius/extension/**` |
| Extension crash affects main | Separate browser tab → separate JS heap |
| Extension memory leak | Close tab releases memory |
| Build failure drags main build | On-demand build decoupled from main `npm run build` |
| Forged username | `/api/ext` reads JWT only |
| Cross-extension calls | `extension_name` validated; handler path not injectable |

### 6.3 Client SDK

`/extension/_sdk/ext.js`:

```js
export async function extCall(payload) {
  const r = await fetch('/api/ext', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      extension_name: window.__EXT_NAME__,
      ext_main_payload: payload,
    }),
  });
  if (!r.ok) throw new Error(`ext call ${r.status}`);
  return r.json();
}
```

Backend injects `<script>window.__EXT_NAME__='<name>'</script>` into `index.html`.

---

## 7. Security checklist

- Strict `extension_name` slug validation (path traversal).
- Fixed handler path `backend/extension_backend_handler.js`.
- Worker `resourceLimits.maxOldGenerationSizeMb=256`, `stackSizeMb=4`.
- `/api/ext` rate limit 5 rps/user.
- Static mime allowlist; SVG CSP hardening.
- `ext_data_dir` mkdir with `chmod 700`.

---

## 8. End-to-end example: Pac-Man + leaderboard

### 8.1 Tree

```
mobius/extension/pacman/
├── extension.json
├── frontend/ ...
└── backend/extension_backend_handler.js
APP_DIR/protected_data/extension/pacman/leaderboard.json
```

### 8.2 Handler (abbreviated)

Supports `get_leaderboard` and `submit_score`; persists top 100 in `leaderboard.json`.

### 8.3 Frontend

```js
import { extCall } from '/extension/_sdk/ext.js';
export async function submit(score) {
  return extCall({ action: 'submit_score', score });
}
```

### 8.4 Sample data

```json
[
  { "username": "alice", "score": 12450, "ts": 1717488000000 },
  { "username": "bob", "score": 11020, "ts": 1717487800000 }
]
```

### 8.5 User flow

1. Project list shows Pac-Man with `kind:'extension'`.
2. Click **Open** → new tab `/extension/pacman/`.
3. First visit triggers build + loading page.
4. Game calls `extCall({ action:'submit_score', score })`.
5. Backend worker returns `{ ok:true, rank:1 }`.
6. Close tab; main app unaffected.

---

## 9. Developer workflow

| Action | How |
|---|---|
| New extension | Add `mobius/extension/<name>/`; `POST /api/admin/extensions/reload` |
| Change handler | Edit and call; mtime invalidates require cache |
| Change frontend | `npm run build` in frontend/ or admin rebuild endpoint |
| Remove extension | Delete dir → reload; DB row disabled, user data kept |

---

## 10. Out of scope (later)

- Extension ACL
- Per-extension quotas
- Multi-language handlers
- Extension marketplace
- Worker pool

---

## 11. Minimal implementation slice

1. Schema + repository constraints.
2. `extension-registry` + `/api/extensions` + startup DB diff.
3. `/api/ext` + worker invoker + 30s/5MB limits.
4. Static routes + on-demand build + loading page.
5. SDK + UserPage **Open** button + hide worktree/research on extension projects.
6. Pac-Man sample end-to-end.
