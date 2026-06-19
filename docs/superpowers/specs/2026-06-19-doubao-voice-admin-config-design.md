# 豆包语音配置 in 管理中心 — Design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)
**Owner:** mobius

## 1. Goal

Make the 11 Doubao ASR/TTS env vars editable from the 管理中心 → 管理员小莫配置 tab, with per-service test buttons. `admin-settings.json` becomes the single source of truth at runtime; `process.env` remains as a deployment-time fallback only.

### Non-goals

- Per-user voice overrides.
- Multi-tenant credentials (one set per install).
- External scheduler rotation of credentials.
- Bulk import / export of the 11 values.

## 2. Background

Today the runtime resolves Doubao credentials from three sources in `mobius/backend/services/doubao-{tts,asr}.js`:

1. `process.env.DOUBAO_*`
2. Secret env files at `~/.codex/secrets/doubao-{tts,asr}.env` (and the `DOUBAO_*_ENV_FILE` env var pointing at a custom path).
3. User memory extraction (regex over an admin user's saved memories).

The user has decided sources (2) and (3) are wrong and must be deleted. Source (1) stays as a deployment-time fallback; a new source — `admin-settings.json` — takes precedence over it.

## 3. Data model

A new top-level key `doubaoVoice` is added to `MOBIUS_DATA_PATH/admin-settings.json`:

```json
{
  "doubaoVoice": {
    "asr": {
      "appId": "",
      "accessToken": "",
      "secretKey": "",
      "resourceId": "volc.seedasr.sauc.duration",
      "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream"
    },
    "tts": {
      "appId": "",
      "accessToken": "",
      "secretKey": "",
      "resourceId": "seed-tts-2.0",
      "endpoint": "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
      "voiceType": "zh_female_vv_uranus_bigtts"
    }
  }
}
```

All 11 fields are stored. The 5 non-secret fields use the existing `.env.default` values as defaults. The 6 secret fields default to empty string.

`secretKey` is currently not consumed by either `doubao-*.js` file, but it appears in `.env.default` and the user listed it among the 11 configurable values. Storing it now means the UI is complete; wiring it into the SDK calls is a follow-up if/when Doubao requires it.

## 4. Backend changes

### 4.1 `mobius/backend/services/admin-settings.js`

Add `doubaoVoice` to `DEFAULTS`, and add normalize + accessor functions following the existing `normalizeModelPromptLimitsForRead` pattern.

**Constants** (mirror `.env.default`):

```js
const DOUBAO_ASR_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const DOUBAO_ASR_DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const DOUBAO_TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const DOUBAO_TTS_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DOUBAO_TTS_DEFAULT_VOICE_TYPE = 'zh_female_vv_uranus_bigtts';
```

**Add to `DEFAULTS`:**

```js
doubaoVoice: {
  asr: { appId: '', accessToken: '', secretKey: '', resourceId: DOUBAO_ASR_DEFAULT_RESOURCE_ID, endpoint: DOUBAO_ASR_DEFAULT_ENDPOINT },
  tts: { appId: '', accessToken: '', secretKey: '', resourceId: DOUBAO_TTS_DEFAULT_RESOURCE_ID, endpoint: DOUBAO_TTS_DEFAULT_ENDPOINT, voiceType: DOUBAO_TTS_DEFAULT_VOICE_TYPE },
},
```

**New normalize functions:**

- `normalizeDoubaoVoiceForRead(value)` — coerces shape, fills missing fields from `DEFAULTS.doubaoVoice`, validates endpoint URLs (`wss://` for ASR, `https://` for TTS).
- `normalizeDoubaoVoiceForWrite(value)` — strips whitespace, throws on malformed endpoints (caller returns 400).
- `maskDoubaoVoice(value)` — returns the same shape, but each of the 6 secret fields is replaced with `{ isSet: boolean, preview: '••••' + last4chars }`. The 5 non-secret fields are returned in full.

**New accessors:**

- `getDoubaoVoice()` — full plaintext, normalized.
- `getDoubaoVoiceMasked()` — masked shape.
- `setDoubaoVoiceAsr(payload)` — writes only `doubaoVoice.asr`, leaves `tts` untouched. Returns masked shape.
- `setDoubaoVoiceTts(payload)` — writes only `doubaoVoice.tts`, leaves `asr` untouched. Returns masked shape.

`loadSettings()` is extended to merge `parsed.doubaoVoice` via `normalizeDoubaoVoiceForRead`.

### 4.2 `mobius/backend/services/doubao-tts.js` and `mobius/backend/services/doubao-asr.js`

**Delete** (both files):

- `parseEnvFile`
- `loadSecretEnv`
- `cleanCredentialValue`
- `credentialEnvValue`
- `firstCredentialMatch`
- `extractDoubao*CredentialsFromText`
- `resolveCredentialsFromUserMemory`
- The `user` parameter from `resolveCredentials` and its callers in `routes/assistant.js`.
- `fs`, `os`, `path` imports if no longer used (verify per-file).
- All references to `DOUBAO_*_ENV_FILE`.

**Rewrite `resolveCredentials`** (TTS shown; ASR is analogous):

```js
const adminSettings = require('./admin-settings');

function resolveCredentials() {
  const stored = adminSettings.getDoubaoVoice().tts;
  const get = (storedKey, envKey) => {
    const fromAdmin = stored?.[storedKey];
    if (fromAdmin && !/^replace-me(?:-|$)/i.test(fromAdmin)) return fromAdmin;
    return process.env[envKey] || '';
  };
  const appId = get('appId', 'DOUBAO_TTS_APP_ID');
  const accessToken = get('accessToken', 'DOUBAO_TTS_ACCESS_TOKEN');
  return {
    appId,
    accessToken,
    resourceId: get('resourceId', 'DOUBAO_TTS_RESOURCE_ID') || DEFAULT_RESOURCE_ID,
    endpoint: get('endpoint', 'DOUBAO_TTS_ENDPOINT') || DEFAULT_ENDPOINT,
  };
}
```

Precedence (admin-saved wins, env is fallback) is enforced inside `get()`.

**Test injection:** expose an additional internal `resolveCredentialsFromPayload(payload)` that builds the same shape from a caller-supplied object. The new admin test endpoint uses this so it can validate draft credentials without persisting.

### 4.3 `mobius/backend/routes/admin.js`

Five new endpoints, all `adminAuth`, all logged via `AdminAuditLog`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/settings/doubao-voice` | Returns masked shape. |
| `GET` | `/api/admin/settings/doubao-voice/reveal` | Returns full plaintext. Admin-only (already gated by `adminAuth`). |
| `PUT` | `/api/admin/settings/doubao-voice/asr` | Body: `{ appId, accessToken, secretKey, resourceId, endpoint }`. Writes ASR sub-object, returns masked. |
| `PUT` | `/api/admin/settings/doubao-voice/tts` | Body: `{ appId, accessToken, secretKey, resourceId, endpoint, voiceType }`. Writes TTS sub-object, returns masked. |
| `POST` | `/api/admin/settings/doubao-voice/test` | Body: `{ service: 'asr'\|'tts', appId, accessToken, secretKey, resourceId, endpoint, voiceType? }`. Runs a one-shot smoke test using `resolveCredentialsFromPayload(payload)`. Returns `{ ok: true }` or `{ ok: false, error: string }`. |

**Test semantics:**

- ASR test: feed a small hardcoded wav fixture (a few hundred ms of silence) into `transcribeBrowserAudio`. Pass if no `AsrError` thrown.
- TTS test: call `synthesizeSpeech` with text `"测试"` and the provided `voiceType`. Pass if non-empty audio buffer returned.

The test endpoint **does not persist** the supplied credentials — it validates only.

### 4.4 `mobius/backend/routes/assistant.js`

Update callers of `resolveCredentials` to drop the `user` argument.

## 5. Frontend changes

### 5.1 `mobius/frontend/src/components/panels.tsx`

Extend `AdminAssistantCallbacksPanel` to render two cards stacked vertically:

1. **Existing callbacks toggle** (unchanged).
2. **New `AdminDoubaoVoiceCard`** — two sub-cards side-by-side on wide screens (`md:grid-cols-2`), single column on narrow:

**Each sub-card (ASR / TTS):**

- Text inputs for each non-secret field (`resourceId`, `endpoint`; TTS adds `voiceType`).
- Password inputs for each secret field (`appId`, `accessToken`, `secretKey`) with an eye-toggle to reveal locally.
- A "查看明文" link per secret field that calls `GET /api/admin/settings/doubao-voice/reveal` once and swaps all secret inputs to plaintext for 30 seconds (then re-masks).
- A "保存" button — disabled while saving; on success shows a brief "已保存" toast/text and refreshes the masked state.
- A "测试连接" button — disabled while testing; on click POSTs the current form values to `/test` and shows inline pass/fail with the error message on failure.

**Voice type input:** `<select>` populated from `GET /api/assistant/tts/voices` (existing route that wraps `getTtsVoices`). Default to `zh_female_vv_uranus_bigtts`.

### 5.2 Subtitle update

Below the existing "当前管理员的小莫可接收其他用户 Session 完成与失败信号" subtitle on the assistant tab, add a second line: "并配置豆包 ASR / TTS 凭证与测试连接".

## 6. `.env.default` cleanup

The 11 `DOUBAO_*` vars stay (they seed `DEFAULTS` and document the env fallback), but the comment block above them updates:

```
# Assistant voice: Doubao ASR / TTS
# These are FALLBACK ONLY. Configure via 管理中心 → 管理员小莫配置 in production.
# Values saved in the admin UI take precedence over these env vars.
```

## 7. Testing

### 7.1 Automated — new file `mobius/tests/admin-doubao-voice.js`

Mirrors the `assistant-tts-cache.js` pattern. Cases:

1. Masked round-trip: save ASR via PUT, GET returns masked shape with `isSet: true` and last-4 preview.
2. Reveal returns plaintext matching what was saved.
3. Admin-saved wins over env: set `process.env.DOUBAO_TTS_APP_ID='env-value'`, save `appId='admin-value'` via PUT, call `resolveCredentials()`, assert returned `appId === 'admin-value'`.
4. Env fallback: PUT `appId=''` (empty string), set `process.env.DOUBAO_TTS_APP_ID='env-value'`, call `resolveCredentials()`, assert returned `appId === 'env-value'`. (Empty admin value is falsy and falls through to env in `get()`.)
5. Test endpoint rejects bad credentials: POST `/test` with `appId='garbage'`, assert `{ ok: false, error: ... }` and that `admin-settings.json` was not modified.
6. Per-card PUT isolation: PUT ASR, assert TTS sub-object unchanged.

### 7.2 Manual smoke

1. Log in as admin.
2. Open 管理中心 → 管理员小莫配置.
3. See callbacks toggle (top) and new Doubao card (below).
4. Fill ASR fields, click 测试 ASR, see green check.
5. Click 保存 ASR.
6. Repeat for TTS.
7. Click 查看明文 on a secret field, see value for 30s, then re-mask.
8. Reload page, confirm values persisted (masked).
9. Verify a real voice conversation still works end-to-end.

## 8. Files touched

| File | Change |
|---|---|
| `mobius/backend/services/admin-settings.js` | Add `doubaoVoice` section: constants, defaults, normalize, accessors. |
| `mobius/backend/services/doubao-tts.js` | Simplify `resolveCredentials`; delete 7 helper functions + `~/.codex` reads; add `resolveCredentialsFromPayload`. |
| `mobius/backend/services/doubao-asr.js` | Same as TTS. |
| `mobius/backend/routes/admin.js` | 5 new routes; audit log each. |
| `mobius/backend/routes/assistant.js` | Drop `user` arg from `resolveCredentials` callers. |
| `mobius/frontend/src/components/panels.tsx` | Add `AdminDoubaoVoiceCard`; mount in existing `assistant` tab below callbacks toggle. |
| `mobius/tests/admin-doubao-voice.js` | New test file. |
| `.env.default` | Comment update on Doubao block. |

## 9. Decisions made without explicit user sign-off

1. **`voiceType` is a `<select>`** populated from `getTtsVoices()` — not free text. The backend already validates against this set in `normalizeVoice`, so a free-text field would just produce silent fallback to the default.
2. **Test endpoint accepts draft credentials** (POST body) rather than testing only stored values. Lets the admin validate before saving — saves a round trip.
3. **Reveal endpoint returns all secrets at once** rather than per-field. One network call, the 30-second re-mask is client-side only.
4. **`secretKey` is stored but not yet consumed** by the runtime. The field exists in `.env.default` and is likely a forward-compat wire-up for future Doubao SDK changes.
