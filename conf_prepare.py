#!/usr/bin/env python3
"""Copy .env.default to .env and randomize the secrets in it.

  - JWT_SECRET                  -> a fresh random hex string.
  - IMAC_BOOTSTRAP_USERS        -> a fresh random password per bootstrap user.

Run this once before first start to materialize a real .env with non-default
credentials. Without it the backend refuses to start (see mobius/backend/config.js).
After writing .env, the changed key-value pairs are echoed to the console
(highlighted) so the operator can see the new values without opening the file.
"""
import re
import secrets
import sys
from pathlib import Path

# Both files live next to this script (project root), resolve via __file__ so the
# script works no matter the current working directory it is invoked from.
BASE_DIR = Path(__file__).resolve().parent
ENV_DEFAULT = BASE_DIR / ".env.default"
ENV = BASE_DIR / ".env"

# ANSI styles for highlighting the changed values in the console.
_RESET = "\033[0m"
_BOLD = "\033[1m"
_YELLOW = "\033[33m"
_GREEN = "\033[32m"


def _randomize_bootstrap_users(match):
    """Replace the password field of each IMAC_BOOTSTRAP_USERS entry.

    Each entry is "id:password:role:display_name" (entries separated by ";").
    Only the password field (index 1) is replaced; id / role / display_name are
    preserved verbatim. NOTE: assumes passwords contain no ":" — consistent with
    the documented format in .env.default.
    """
    value = match.group(1)
    entries = []
    for entry in value.split(";"):
        parts = entry.split(":")
        if len(parts) >= 2:
            # 18 random bytes -> ~24-char URL-safe string; strong and login-safe.
            parts[1] = secrets.token_urlsafe(18)
            entry = ":".join(parts)
        entries.append(entry)
    return f"IMAC_BOOTSTRAP_USERS={';'.join(entries)}"


def _find_value(content, key):
    """Return the value of `key=` in content, or None if the key is absent."""
    m = re.search(rf"^{re.escape(key)}=(.*)$", content, flags=re.MULTILINE)
    return m.group(1) if m else None


def _print_changed(key, value):
    """Print one changed key-value pair, highlighting the value when on a TTY."""
    if sys.stdout.isatty():
        line = f"  {_BOLD}{_YELLOW}{key}{_RESET}={_BOLD}{_GREEN}{value}{_RESET}"
    else:
        # Plain text when piped / not a console, to avoid raw escape codes in logs.
        line = f"  {key}={value}"
    print(line)


def main():
    # Start from the committed template; never mutate .env.default.
    content = ENV_DEFAULT.read_text(encoding="utf-8")

    # 32 random bytes -> 64-char hex string, matching the generation command
    # documented in .env.default (node crypto.randomBytes(32).toString('hex')).
    secret = secrets.token_hex(32)

    # Replace only the JWT_SECRET line (anchored at line start so we don't touch
    # any comments that happen to mention the key name).
    content = re.sub(r"^JWT_SECRET=.*$", f"JWT_SECRET={secret}", content, flags=re.MULTILINE)

    # Replace each bootstrap user's password; see _randomize_bootstrap_users.
    content = re.sub(
        r"^IMAC_BOOTSTRAP_USERS=(.*)$",
        _randomize_bootstrap_users,
        content,
        flags=re.MULTILINE,
    )

    ENV.write_text(content, encoding="utf-8")
    print(f"Copied {ENV_DEFAULT.name} -> {ENV.name} and randomized secrets.")

    # Echo the changed key-value pairs, highlighted, so the new values are
    # visible immediately. Pull them back out of the final content (single source
    # of truth) rather than re-deriving them here.
    print("Changed values:")
    for key in ("JWT_SECRET", "IMAC_BOOTSTRAP_USERS"):
        value = _find_value(content, key)
        if value is not None:
            _print_changed(key, value)


if __name__ == "__main__":
    main()
