"""Session 可选模型统一解析 (Python 镜像).

镜像 Node 端 ``mobius/backend/services/model-registry.js``:

* 内置 ``opus`` 来自 ``aimax.config`` (默认 ``opus-4.8``).
* 没有明确配置文件的模型不进入系统, 也不能启动.
* 管理员导入的 Claude Code 模型走 ``--settings <path>`` + ``--model <claude_model>``.
* 管理员导入的 Codex 模型走 ``--profile <channel>`` + ``-m <codex_model>`` +
  每模型独立 ``use_proxy`` 和秘钥环境变量.
"""

from __future__ import annotations

import os
from typing import Optional

from ..config import get_config
from . import model_access


# 内置模型硬编码 (镜像 Node config.js 的 MODEL_OPTIONS)
# built-in codex 也必须显式指定纯英文字母渠道.
BUILTIN_MODELS = {
    "opus": {"id": "opus-4.8", "backend": "tmux-claude-code", "label": "Opus"},
    "codex": {
        "id": "gpt-5.5",
        "profileKey": "mobiusdefault",
        "secretEnvKey": "RIGHTCODE_API_KEY",
        "backend": "tmux-codex",
        "label": "GPT-5.5 (Codex)",
    },
}
BUILTIN_ORDER = ("codex", "opus")
DEFAULT_MODEL_KEY = "codex"
DEFAULT_AGENT_BACKEND = "tmux-codex"
LEGACY_MODEL_KEY_ALIASES = {
    "codex:gpt-5.5": "codex",
    "claude-opus-4-7": "opus",
}


def _canonical_model_key(model_or_key) -> str:
    raw = str(model_or_key or "").strip()
    return LEGACY_MODEL_KEY_ALIASES.get(raw, raw)


def _builtin_entry(model_or_key: str) -> Optional[dict]:
    normalized = _canonical_model_key(model_or_key)
    key = normalized if normalized in BUILTIN_MODELS else None
    if key is None:
        for k, opt in BUILTIN_MODELS.items():
            if opt["id"] == normalized:
                key = k
                break
    if key is None:
        return None
    opt = BUILTIN_MODELS[key]
    settings_path = os.path.expanduser("~/.claude/mobiusdefault.settings.json") if opt["backend"] == "tmux-claude-code" else None
    codex_config_path = (
        os.path.expanduser(f"~/.codex/{opt['profileKey']}.config.toml")
        if opt["backend"] == "tmux-codex" and opt.get("profileKey")
        else None
    )
    config_path = codex_config_path or settings_path
    if not config_path or not os.path.exists(config_path):
        return None
    return {
        "key": key,
        "value": key,
        "sessionModelValue": opt["id"],
        "model": opt["id"],
        "label": opt["label"],
        "title": _title_for_builtin(key, opt),
        "sub": _sub_for_builtin(key),
        "backend": opt["backend"],
        "imported": False,
        "useProxy": False,
        "settingsPath": settings_path,
        "codexProfileKey": opt.get("profileKey"),
        "codexChannel": opt.get("profileKey"),
        "codexConfigPath": codex_config_path,
        "codexSecretEnvKey": opt.get("secretEnvKey"),
        "codexSecretValue": None,
        "codexModel": None,
        "claudeModel": opt["id"],
    }


def _title_for_builtin(key: str, opt: dict) -> str:
    if key == "codex":
        return "GPT-5.5"
    return opt["label"]


def _sub_for_builtin(key: str) -> str:
    if key == "codex":
        return "Codex · 强力"
    if key == "opus":
        return "Claude Code · 强力"
    return "内置模型"


def _dynamic_claude_entry(model_or_key: str) -> Optional[dict]:
    m = model_access.find_claude_code_model(model_or_key)
    if not m or not m.get("enabled"):
        return None
    if not os.path.exists(str(m.get("settings_path") or "")):
        return None
    return {
        "key": m["session_model"],
        "value": m["session_model"],
        "sessionModelValue": m["session_model"],
        "model": m["session_model"],
        "label": m["label"],
        "title": m["label"],
        "sub": "Claude Code · 自定义",
        "backend": "tmux-claude-code",
        "imported": True,
        "useProxy": False,
        "settingsPath": m.get("settings_path"),
        "settingsFile": m.get("settings_file"),
        "settingsExists": m.get("settings_exists"),
        "codexConfigPath": None,
        "codexSecretEnvKey": None,
        "codexSecretValue": None,
        "codexModel": None,
        "claudeModel": m.get("claude_model"),
    }


def _dynamic_codex_entry(model_or_key: str) -> Optional[dict]:
    m = model_access.find_codex_model(model_or_key, include_secret=True)
    if not m or not m.get("enabled"):
        return None
    if not os.path.exists(str(m.get("config_path") or "")):
        return None
    return {
        "key": m["session_model"],
        "value": m["session_model"],
        "sessionModelValue": m["session_model"],
        "model": m.get("channel") or m["key"],
        "label": m["label"],
        "title": m["label"],
        "sub": "Codex · 自定义",
        "backend": "tmux-codex",
        "imported": True,
        "useProxy": False,
        "settingsPath": None,
        "codexConfigPath": m.get("config_path"),
        "codexSecretEnvKey": m.get("secret_env_key"),
        "codexSecretValue": m.get("secret_value"),
        "codexModel": m.get("codex_model"),
        "claudeModel": None,
    }


def resolve_session_model(model_or_key) -> Optional[dict]:
    """把 session.model 解析成统一结构; 不做缺省模型 fallback."""
    codex = _dynamic_codex_entry(model_or_key)
    if codex:
        return codex
    dynamic = _dynamic_claude_entry(model_or_key)
    if dynamic:
        return dynamic
    builtin = _builtin_entry(model_or_key)
    if builtin:
        return builtin
    return None


def resolve_session_model_for_create(model_or_key) -> dict:
    return resolve_session_model(model_or_key or DEFAULT_MODEL_KEY)


def backend_name_for_session_model(model_or_key) -> str:
    resolved = resolve_session_model(model_or_key)
    if not resolved:
        raise ValueError(f"模型未配置或配置文件缺失: {model_or_key or DEFAULT_MODEL_KEY}")
    return resolved.get("backend") or DEFAULT_AGENT_BACKEND


def label_for_session_model(model_or_key) -> str:
    resolved = resolve_session_model(model_or_key)
    return (resolved or {}).get("label") or str(model_or_key or "")


def is_imported_claude_code_model(model_or_key) -> bool:
    return _dynamic_claude_entry(model_or_key) is not None


def is_imported_codex_model(model_or_key) -> bool:
    return _dynamic_codex_entry(model_or_key) is not None


def list_session_model_options() -> list:
    """返回 picker 用的模型选项, 与 Node 端 listSessionModelOptions 行为一致."""
    builtins = [_builtin_entry(k) for k in BUILTIN_ORDER if k in BUILTIN_MODELS]
    builtins = [m for m in builtins if m]
    codex_dynamics = [
        _dynamic_codex_entry(m["session_model"])
        for m in model_access.list_codex_models(enabled_only=True)
    ]
    codex_dynamics = [m for m in codex_dynamics if m]
    claude_dynamics = [
        _dynamic_claude_entry(m["session_model"])
        for m in model_access.list_claude_code_models(enabled_only=True)
    ]
    claude_dynamics = [m for m in claude_dynamics if m]

    builtin_codex = [m for m in builtins if m["key"] == "codex"]
    builtin_claude = [m for m in builtins if m["key"] != "codex"]

    ordered = builtin_codex + codex_dynamics + claude_dynamics + builtin_claude
    return [
        {
            "key": m["key"],
            "value": m["value"],
            "model": m["model"],
            "label": m["label"],
            "title": m["title"],
            "sub": m["sub"],
            "backend": m["backend"],
            "imported": m["imported"],
            "use_proxy": 0 if m["useProxy"] is False else (1 if m["useProxy"] is True else None),
            "codex_config_path": m.get("codexConfigPath"),
            "codex_channel": m.get("codexChannel") or (m.get("model") if m.get("backend") == "tmux-codex" else None),
            "codex_secret_env_key": m.get("codexSecretEnvKey"),
            "settings_path": m.get("settingsPath"),
        }
        for m in ordered
    ]


def launch_options_for_session(session) -> dict:
    """返回 spawn 用的统一结构; 镜像 Node 端同名函数."""
    resolved = resolve_session_model((session or {}).get("model") if hasattr(session, "get") else None)
    if not resolved:
        raise ValueError(f"模型未配置或配置文件缺失: {((session or {}).get('model') if hasattr(session, 'get') else None) or DEFAULT_MODEL_KEY}")
    if resolved["backend"] == "tmux-codex" and resolved["imported"]:
        return {
            "backend": "tmux-codex",
            "model": resolved["codexModel"],
            "codexProfileKey": resolved["model"],
            "codexChannel": resolved["model"],
            "codexConfigPath": resolved["codexConfigPath"],
            "codexSecretEnvKey": resolved.get("codexSecretEnvKey"),
            "codexSecretValue": resolved.get("codexSecretValue"),
            "useProxy": resolved["useProxy"],
            "forceNoProxy": False,
            "imported": True,
            "label": resolved["label"],
        }
    if resolved["imported"]:
        return {
            "backend": resolved["backend"],
            "model": resolved["claudeModel"],
            "settingsPath": resolved["settingsPath"],
            "useProxy": resolved["useProxy"],
            "forceNoProxy": False,
            "imported": True,
            "label": resolved["label"],
        }
    return {
        "backend": resolved["backend"],
        "model": resolved["model"],
        "settingsPath": resolved.get("settingsPath"),
        "useProxy": resolved.get("useProxy"),
        "codexProfileKey": resolved.get("codexProfileKey"),
        "codexChannel": resolved.get("codexChannel") or resolved.get("codexProfileKey"),
        "codexConfigPath": resolved.get("codexConfigPath"),
        "codexSecretEnvKey": resolved.get("codexSecretEnvKey"),
        "codexSecretValue": resolved.get("codexSecretValue"),
        "forceNoProxy": False,
        "imported": False,
        "label": resolved["label"],
    }


__all__ = [
    "DEFAULT_MODEL_KEY",
    "DEFAULT_AGENT_BACKEND",
    "BUILTIN_MODELS",
    "BUILTIN_ORDER",
    "list_session_model_options",
    "resolve_session_model",
    "resolve_session_model_for_create",
    "backend_name_for_session_model",
    "label_for_session_model",
    "is_imported_claude_code_model",
    "is_imported_codex_model",
    "launch_options_for_session",
]
