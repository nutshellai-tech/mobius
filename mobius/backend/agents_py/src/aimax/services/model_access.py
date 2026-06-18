"""管理员导入的模型配置 (Claude Code + Codex).

镜像 Node 端 ``mobius/backend/services/model-access.js``:

* Claude Code: settings JSON 原样写入 ``~/.claude/settings-<key>.json``,
  管理员读到的就是写入的内容.
* Codex: TOML 配置原样写入 ``~/.codex/<channel>.config.toml`` (与 ``codex
  --profile <channel>`` 兼容), provider / base_url / model 都在 per-channel
  文件里; API key 不写 auth.json, 启动 tmux 时 export env_key 对应环境变量.

不做 secret 管理, 也不做 TOML 语法深度校验 — 写入时仅做非空 / key
文件安全检查, codex CLI 自身在 TUI 启动时会做最终校验.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
from typing import Any, Optional

from ..config import get_config

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude")
CODEX_DIR = os.path.join(HOME, ".claude")
SESSION_MODEL_PREFIX = "claude-code:"
SESSION_MODEL_PREFIX_CODEX = "codex:"

# Codex 渠道就是 --profile 的 plain name, 业务约束为纯英文字母.
CODEX_CHANNEL_RE = re.compile(r"^[A-Za-z]+$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CODEX_KEY_MAX = 80



def _model_access_path() -> str:
    return str(get_config().model_access_file())


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Default data
# ---------------------------------------------------------------------------
def _default_data() -> dict:
    return {
        "claudeCodeModels": [],
        "codexModels": [],
    }


# ---------------------------------------------------------------------------
# Key 规范化
# ---------------------------------------------------------------------------
def _normalize_key(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        raise ValueError("模型 Key 不能为空")
    return key


def _normalize_codex_key(value: Any) -> str:
    key = _normalize_key(value)
    if len(key) > CODEX_KEY_MAX:
        raise ValueError(f"Codex 渠道最多 {CODEX_KEY_MAX} 个字符")
    if not CODEX_CHANNEL_RE.match(key):
        raise ValueError("Codex 渠道只能包含英文字母, 例如 mobiusdefault")
    return key


def _normalize_secret_env_key(value: Any) -> str:
    key = _normalize_key(value)
    if len(key) > 120:
        raise ValueError("秘钥名最多 120 个字符")
    if not ENV_KEY_RE.match(key):
        raise ValueError("秘钥名必须是合法环境变量名, 例如 RIGHTCODE_API_KEY")
    return key


def _normalize_secret_value(value: Any) -> str:
    secret = str(value or "").strip()
    if not secret:
        raise ValueError("秘钥值不能为空")
    return secret


def _normalize_label(value: Any, fallback: str) -> str:
    label = (str(value or "").strip() if value is not None else "") or fallback
    if len(label) > 80:
        raise ValueError("显示名称最多 80 个字符")
    return label


# ---------------------------------------------------------------------------
# Claude Code path (与 Node 端 settingsFilenameForKey / settingsPathForKey 保持一致)
# ---------------------------------------------------------------------------
def _claude_settings_filename_for_key(key: str) -> str:
    from urllib.parse import quote
    return f"settings-{quote(_normalize_key(key), safe='')}.json"


def _claude_settings_path_for_key(key: str) -> str:
    return os.path.join(CLAUDE_DIR, _claude_settings_filename_for_key(key))


def _display_claude_settings_path_for_key(key: str) -> str:
    return f"~/.claude/{_claude_settings_filename_for_key(key)}"


def _session_model_for_key(key: str) -> str:
    return f"{SESSION_MODEL_PREFIX}{_normalize_key(key)}"


def _key_from_session_model(model: Any) -> Optional[str]:
    s = str(model or "").strip()
    if not s.startswith(SESSION_MODEL_PREFIX):
        return None
    try:
        return _normalize_key(s[len(SESSION_MODEL_PREFIX):])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Codex path
# ---------------------------------------------------------------------------
def _codex_config_filename_for_key(key: str) -> str:
    return f"{_normalize_codex_key(key)}.config.toml"


def _codex_config_path_for_key(key: str) -> str:
    return os.path.join(CODEX_DIR, _codex_config_filename_for_key(key))


def _display_codex_config_path_for_key(key: str) -> str:
    return f"~/.claude/{_codex_config_filename_for_key(key)}"


def _session_model_for_codex_key(key: str) -> str:
    return f"{SESSION_MODEL_PREFIX_CODEX}{_normalize_codex_key(key)}"


def _key_from_codex_session_model(model: Any) -> Optional[str]:
    s = str(model or "").strip()
    if not s.startswith(SESSION_MODEL_PREFIX_CODEX):
        return None
    try:
        return _normalize_codex_key(s[len(SESSION_MODEL_PREFIX_CODEX):])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# I/O 原子写
# ---------------------------------------------------------------------------
def _atomic_write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.imac-tmp-{os.getpid()}-{int(time.time() * 1000)}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _read_text(path: str, default: str = "") -> str:
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Claude Code I/O
# ---------------------------------------------------------------------------
def _read_claude_settings_json(key: str) -> str:
    return _read_text(_claude_settings_path_for_key(key), default="{}")


def _write_claude_settings_json(key: str, settings_obj: dict) -> str:
    path = _claude_settings_path_for_key(key)
    _atomic_write_text(path, json.dumps(settings_obj, indent=2, ensure_ascii=False))
    return path


def _parse_settings_json(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    text = value if isinstance(value, str) else json.dumps(value or {}, indent=2)
    try:
        parsed = json.loads(text)
    except Exception as e:
        raise ValueError(f"settings JSON 非法: {e}")
    if not isinstance(parsed, dict):
        raise ValueError("settings JSON 必须是对象")
    return parsed


def _infer_claude_model(input_obj: Any, parsed_settings: dict, key: str) -> str:
    explicit = str((input_obj or {}).get("claude_model") or "").strip()
    from_model = parsed_settings.get("model") if isinstance(parsed_settings.get("model"), str) else ""
    from_env = (
        parsed_settings.get("env", {}).get("ANTHROPIC_MODEL")
        if isinstance(parsed_settings.get("env"), dict) else None
    )
    from_env = from_env if isinstance(from_env, str) else ""
    model = explicit or (from_model or "").strip() or (from_env or "").strip()
    if not model:
        raise ValueError(
            f"请填写 Claude 模型名, 或在 settings JSON 中设置 model / env.ANTHROPIC_MODEL ({key})"
        )
    return model


# ---------------------------------------------------------------------------
# Codex I/O
# ---------------------------------------------------------------------------
def _read_codex_config_toml(key: str) -> str:
    return _read_text(_codex_config_path_for_key(key), default="")


def _write_codex_config_toml(key: str, toml_text: str) -> str:
    path = _codex_config_path_for_key(key)
    _atomic_write_text(path, toml_text)
    return path


def _normalize_config_toml(value: Any) -> str:
    text = "" if value is None else str(value)
    if not text.strip():
        raise ValueError("config_toml 不能为空")
    return text if text.endswith("\n") else text + "\n"


def _env_key_from_config_toml(toml_text: str) -> str:
    m = re.search(r"(?:^|\n)\s*env_key\s*=\s*(['\"])([^'\"]+)\1", str(toml_text or ""))
    return m.group(2).strip() if m else ""


def _api_key_from_config_toml(toml_text: str) -> str:
    m = re.search(r"(?:^|\n)\s*api_key\s*=\s*(['\"])([^'\"]+)\1", str(toml_text or ""))
    return m.group(2).strip() if m else ""


def _assert_config_env_key_matches(toml_text: str, secret_env_key: str, key: str) -> None:
    env_key = _env_key_from_config_toml(toml_text)
    if not env_key:
        return
    if env_key != secret_env_key:
        raise ValueError(f"config_toml 的 env_key ({env_key}) 必须和秘钥名 ({secret_env_key}) 一致")
    if not _api_key_from_config_toml(toml_text):
        raise ValueError(f"config_toml 必须包含 api_key ({key})")


def _infer_codex_model(input_obj: Any, key: str) -> str:
    explicit = str((input_obj or {}).get("codex_model") or "").strip()
    if not explicit:
        raise ValueError(f"请填写 Codex 模型名 ({key})")
    return explicit


# ---------------------------------------------------------------------------
# Load / Save
# ---------------------------------------------------------------------------
def _load_data() -> dict:
    path = _model_access_path()
    if not os.path.exists(path):
        return _default_data()
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except Exception as e:
        print(f"[model-access] 读取失败, 回退空配置: {e}")
        return _default_data()
    data = _default_data()
    for row in (parsed or {}).get("claudeCodeModels") or []:
        if not isinstance(row, dict):
            continue
        try:
            key = _normalize_key(row.get("key"))
            data["claudeCodeModels"].append({
                "key": key,
                "label": _normalize_label(row.get("label"), key),
                "claude_model": str(row.get("claude_model") or "").strip(),
                "settings_file": _display_claude_settings_path_for_key(key),
                "enabled": row.get("enabled") is not False,
                "imported": True,
                "backend": "tmux-claude-code",
                "use_proxy": False,
                "created_at": row.get("created_at") or _now_iso(),
                "updated_at": row.get("updated_at") or row.get("created_at") or _now_iso(),
            })
        except Exception as e:
            print(f"[model-access] 跳过非法模型配置: {e}")
    for row in (parsed or {}).get("codexModels") or []:
        if not isinstance(row, dict):
            continue
        try:
            key = _normalize_codex_key(row.get("channel") or row.get("key"))
            data["codexModels"].append({
                "key": key,
                "channel": key,
                "label": _normalize_label(row.get("label"), key),
                "codex_model": str(row.get("codex_model") or "").strip(),
                "secret_env_key": str(
                    row.get("secret_env_key")
                    or row.get("secretEnvKey")
                    or row.get("env_key")
                    or row.get("envKey")
                    or ""
                ).strip(),
                "secret_value": str(row.get("secret_value") or row.get("secretValue") or "").strip(),
                "config_file": _display_codex_config_path_for_key(key),
                "enabled": row.get("enabled") is not False,
                "use_proxy": row.get("use_proxy") is True,
                "imported": True,
                "backend": "tmux-codex",
                "created_at": row.get("created_at") or _now_iso(),
                "updated_at": row.get("updated_at") or row.get("created_at") or _now_iso(),
            })
        except Exception as e:
            print(f"[model-access] 跳过非法 codex 模型配置: {e}")
    return data


def _save_data(data: dict) -> None:
    path = _model_access_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.imac-tmp-{os.getpid()}-{int(time.time() * 1000)}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Public: Claude Code
# ---------------------------------------------------------------------------
def _public_claude(row: dict, include_settings: bool = False) -> dict:
    key = _normalize_key(row["key"])
    path = _claude_settings_path_for_key(key)
    out = {
        "key": key,
        "session_model": _session_model_for_key(key),
        "label": row["label"],
        "claude_model": row.get("claude_model") or "",
        "settings_file": _display_claude_settings_path_for_key(key),
        "settings_path": path,
        "settings_exists": os.path.exists(path),
        "enabled": row.get("enabled") is not False,
        "imported": True,
        "backend": "tmux-claude-code",
        "use_proxy": False,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    if include_settings:
        out["settings_json"] = _read_claude_settings_json(key)
    return out


def list_claude_code_models(enabled_only: bool = False, include_settings: bool = False):
    rows = _load_data()["claudeCodeModels"]
    return [
        _public_claude(r, include_settings=include_settings)
        for r in rows
        if not enabled_only or r.get("enabled") is not False
    ]


def find_claude_code_model(key_or_session_model, include_settings: bool = False):
    try:
        key = _key_from_session_model(key_or_session_model) or _normalize_key(key_or_session_model)
    except Exception:
        return None
    for r in _load_data()["claudeCodeModels"]:
        if r["key"] == key:
            return _public_claude(r, include_settings=include_settings)
    return None


def upsert_claude_code_model(input_obj: dict, existing_key: Optional[str] = None):
    key = _normalize_codex_key(existing_key) if existing_key else _normalize_key((input_obj or {}).get("key"))
    data = _load_data()
    idx = next((i for i, m in enumerate(data["claudeCodeModels"]) if m["key"] == key), -1)
    existing = data["claudeCodeModels"][idx] if idx >= 0 else None
    has_settings = any(k in (input_obj or {}) for k in ("settings_json", "settingsJson", "settings"))
    settings_json = (input_obj or {}).get("settings_json") or (input_obj or {}).get("settingsJson") or (input_obj or {}).get("settings")
    parsed = _parse_settings_json(settings_json) if has_settings else _parse_settings_json(_read_claude_settings_json(key))
    next_row = {
        "key": key,
        "label": _normalize_label((input_obj or {}).get("label") or (existing or {}).get("label"), key),
        "claude_model": _infer_claude_model(input_obj, parsed, key),
        "settings_file": _display_claude_settings_path_for_key(key),
        "enabled": (input_obj or {}).get("enabled") if isinstance((input_obj or {}).get("enabled"), bool) else (existing or {}).get("enabled", True),
        "imported": True,
        "backend": "tmux-claude-code",
        "use_proxy": False,
        "created_at": (existing or {}).get("created_at") or _now_iso(),
        "updated_at": _now_iso(),
    }
    _write_claude_settings_json(key, parsed)
    if idx >= 0:
        data["claudeCodeModels"][idx] = next_row
    else:
        data["claudeCodeModels"].append(next_row)
    data["claudeCodeModels"].sort(key=lambda m: m["key"])
    _save_data(data)
    return _public_claude(next_row, include_settings=True)


def delete_claude_code_model(key_or_session_model) -> bool:
    try:
        key = _key_from_session_model(key_or_session_model) or _normalize_key(key_or_session_model)
    except Exception:
        return False
    data = _load_data()
    before = len(data["claudeCodeModels"])
    data["claudeCodeModels"] = [m for m in data["claudeCodeModels"] if m["key"] != key]
    if len(data["claudeCodeModels"]) == before:
        return False
    _save_data(data)
    path = _claude_settings_path_for_key(key)
    try:
        if os.path.exists(path):
            os.unlink(path)
    except Exception as e:
        print(f"[model-access] 删除 settings 文件失败 ({path}): {e}")
    return True


# ---------------------------------------------------------------------------
# Public: Codex
# ---------------------------------------------------------------------------
def _public_codex(row: dict, include_config: bool = False, include_secret: bool = False) -> dict:
    key = _normalize_codex_key(row.get("channel") or row["key"])
    path = _codex_config_path_for_key(key)
    out = {
        "key": key,
        "channel": key,
        "session_model": _session_model_for_codex_key(key),
        "label": row["label"],
        "codex_model": row.get("codex_model") or "",
        "secret_env_key": row.get("secret_env_key") or "",
        "secret_value_set": bool(row.get("secret_value")),
        "config_file": _display_codex_config_path_for_key(key),
        "config_path": path,
        "config_exists": os.path.exists(path),
        "enabled": row.get("enabled") is not False,
        "use_proxy": row.get("use_proxy") is True,
        "imported": True,
        "backend": "tmux-codex",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    if include_config:
        out["config_toml"] = _read_codex_config_toml(key)
    if include_secret:
        out["secret_value"] = row.get("secret_value") or ""
    return out


def list_codex_models(enabled_only: bool = False, include_config: bool = False, include_secret: bool = False):
    rows = _load_data()["codexModels"]
    return [
        _public_codex(r, include_config=include_config, include_secret=include_secret)
        for r in rows
        if not enabled_only or r.get("enabled") is not False
    ]


def find_codex_model(key_or_session_model, include_config: bool = False, include_secret: bool = False):
    try:
        key = _key_from_codex_session_model(key_or_session_model) or _normalize_codex_key(key_or_session_model)
    except Exception:
        return None
    for r in _load_data()["codexModels"]:
        if r["key"] == key:
            return _public_codex(r, include_config=include_config, include_secret=include_secret)
    return None


def upsert_codex_model(input_obj: dict, existing_key: Optional[str] = None):
    key = (
        _normalize_codex_key(existing_key)
        if existing_key
        else _normalize_codex_key((input_obj or {}).get("channel") or (input_obj or {}).get("key"))
    )
    data = _load_data()
    idx = next((i for i, m in enumerate(data["codexModels"]) if m["key"] == key), -1)
    existing = data["codexModels"][idx] if idx >= 0 else None
    has_secret_value = any(k in (input_obj or {}) for k in ("secret_value", "secretValue"))
    raw_secret_value = (input_obj or {}).get("secret_value") or (input_obj or {}).get("secretValue")
    has_config = any(k in (input_obj or {}) for k in ("config_toml", "configToml"))
    config_text = (input_obj or {}).get("config_toml") or (input_obj or {}).get("configToml")
    toml = _normalize_config_toml(config_text) if has_config else _read_codex_config_toml(key)
    if not toml.strip():
        raise ValueError(f"config_toml 不能为空, 请填写 TOML 配置 ({key})")
    config_env_key = _env_key_from_config_toml(toml)
    secret_env_key = (
        _normalize_secret_env_key(
            (input_obj or {}).get("secret_env_key")
            or (input_obj or {}).get("secretEnvKey")
            or (input_obj or {}).get("env_key")
            or (input_obj or {}).get("envKey")
            or (existing or {}).get("secret_env_key")
            or config_env_key
        )
        if config_env_key
        else ""
    )
    _assert_config_env_key_matches(toml, secret_env_key, key)
    config_api_key = _api_key_from_config_toml(toml)
    secret_value = (
        _normalize_secret_value(raw_secret_value)
        if has_secret_value and str(raw_secret_value or "").strip()
        else (config_api_key or (existing or {}).get("secret_value", ""))
    )
    if config_env_key and not secret_value:
        raise ValueError(f"请填写秘钥值或在 config_toml 中填写 api_key ({secret_env_key})")
    use_proxy_in = (input_obj or {}).get("use_proxy")
    if use_proxy_in is None:
        use_proxy_in = (input_obj or {}).get("useProxy")
    next_row = {
        "key": key,
        "channel": key,
        "label": _normalize_label((input_obj or {}).get("label") or (existing or {}).get("label"), key),
        "codex_model": _infer_codex_model(input_obj, key),
        "secret_env_key": secret_env_key,
        "secret_value": secret_value,
        "config_file": _display_codex_config_path_for_key(key),
        "enabled": (input_obj or {}).get("enabled") if isinstance((input_obj or {}).get("enabled"), bool) else (existing or {}).get("enabled", True),
        "use_proxy": use_proxy_in if isinstance(use_proxy_in, bool) else (existing or {}).get("use_proxy", False),
        "imported": True,
        "backend": "tmux-codex",
        "created_at": (existing or {}).get("created_at") or _now_iso(),
        "updated_at": _now_iso(),
    }
    _write_codex_config_toml(key, toml)
    if idx >= 0:
        data["codexModels"][idx] = next_row
    else:
        data["codexModels"].append(next_row)
    data["codexModels"].sort(key=lambda m: m["key"])
    _save_data(data)
    return _public_codex(next_row, include_config=True)


def delete_codex_model(key_or_session_model) -> bool:
    try:
        key = _key_from_codex_session_model(key_or_session_model) or _normalize_codex_key(key_or_session_model)
    except Exception:
        return False
    data = _load_data()
    before = len(data["codexModels"])
    data["codexModels"] = [m for m in data["codexModels"] if m["key"] != key]
    if len(data["codexModels"]) == before:
        return False
    _save_data(data)
    path = _codex_config_path_for_key(key)
    try:
        if os.path.exists(path):
            os.unlink(path)
    except Exception as e:
        print(f"[model-access] 删除 codex config 文件失败 ({path}): {e}")
    return True


# ---------------------------------------------------------------------------
# Seed (首次启动): 已禁用, picker 里的 Codex 默认项由内置 ``codex`` 兜底.
# 管理员如要自定义 Codex 模型 (独立 profile-v2), 在管理中心 Codex tab 加.
# ---------------------------------------------------------------------------


__all__ = [
    "SESSION_MODEL_PREFIX",
    "SESSION_MODEL_PREFIX_CODEX",
    # Claude Code
    "list_claude_code_models",
    "find_claude_code_model",
    "upsert_claude_code_model",
    "delete_claude_code_model",
    # Codex
    "list_codex_models",
    "find_codex_model",
    "upsert_codex_model",
    "delete_codex_model",
    "codex_config_path_for_key",
    "display_codex_config_path_for_key",
]


def codex_config_path_for_key(key: str) -> str:
    return _codex_config_path_for_key(key)


def display_codex_config_path_for_key(key: str) -> str:
    return _display_codex_config_path_for_key(key)
