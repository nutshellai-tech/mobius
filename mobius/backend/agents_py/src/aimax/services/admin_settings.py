"""Persistent admin-level model settings.

Network proxy decisions are owned by the per-model registry entry. Old
per-backend defaults may still exist on disk, but they are ignored and
reported as empty so no backend can become the proxy source of truth.

This module ports that schema. The file's location is controlled by
:func:`aimax.config.get_config().admin_settings_file()`, so you
can point it at any directory by setting ``AIMAX_DATA_DIR``.

Schema
------

::

    {
      "modelNetworkProxy": { "perModel": {} }
    }

Unknown keys (including ``tmux-codex`` from older deployments) are
preserved on disk but ignored by the reader — the Codex ``useProxy``
flag is now owned by the per-model entry in the registry, not by
admin-settings. New sessions of the Codex backend therefore read the
``useProxy`` flag straight from the model registry.

Concurrency
-----------

Writes are atomic: write a temp file in the same directory, then
:func:`os.replace` it onto the target. Readers do a single
:func:`open` + :func:`json.load`, so a partial file from a crashed
writer is impossible.
"""

from __future__ import annotations

import copy
import json
import os

from ..config import get_config


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
# Per-backend proxy defaults have been removed.
KNOWN_BACKENDS = ()

DEFAULTS = {
    "modelNetworkProxy": {"perModel": {}},
}


def _defaults_clone() -> dict:
    return copy.deepcopy(DEFAULTS)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def load_settings() -> dict:
    """Return the on-disk settings, falling back to :data:`DEFAULTS`.

    Unknown / malformed values are silently replaced by the default for
    that field.
    """
    path = str(get_config().admin_settings_file())
    if not os.path.exists(path):
        return _defaults_clone()
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
        merged = _defaults_clone()
        if isinstance(parsed, dict) and isinstance(parsed.get("modelNetworkProxy"), dict):
            per_model = parsed["modelNetworkProxy"].get("perModel")
            if isinstance(per_model, dict):
                merged["modelNetworkProxy"]["perModel"] = {
                    str(k): bool(v) for k, v in per_model.items() if isinstance(v, bool)
                }
        return merged
    except Exception as e:  # pragma: no cover — defensive
        print(f"[admin-settings] read failed, falling back to defaults: {e}")
        return _defaults_clone()


__all__ = [
    "KNOWN_BACKENDS",
    "DEFAULTS",
    "load_settings",
]
