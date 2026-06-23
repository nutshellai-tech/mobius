#!/usr/bin/env python3
"""Validate .env before startup.

Three checks:
  1. JWT_SECRET must be set and not the default placeholder.
  2. IMAC_BOOTSTRAP_USERS passwords must not be the default placeholder.
  3. APP_DIR must exist on disk — UNLESS --docker is passed, because inside the
     container APP_DIR is an absolute container path (/app) that is correct by
     construction and should not be checked against the host filesystem.

Exits non-zero on any failure so callers (e.g. start.py / CI) can abort cleanly.
"""
import argparse
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ENV = BASE_DIR / ".env"
# The placeholder shipped in .env.default; treat it (and empty) as "unset".
DEFAULT_JWT_SECRET = "change-me-please-generate-a-random-secret"
# Default placeholder password inside IMAC_BOOTSTRAP_USERS (id:password:role:name).
DEFAULT_BOOTSTRAP_PASSWORD = "change-me-strong-password"


def parse_env(path):
    """Parse a simple KEY=VALUE .env file into a dict.

    Skips blank lines and comments. Does not handle quoting/expansion — the
    template uses plain values, and that's all we need to read here.
    """
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker", action="store_true", help="skip APP_DIR existence check")
    args = parser.parse_args()

    # No .env yet -> the operator has not run prepare_conf.py.
    if not ENV.exists():
        print("ERROR: .env not found. Run prepare_conf.py first.", file=sys.stderr)
        sys.exit(1)

    env = parse_env(ENV)

    # Check 1: JWT_SECRET must be a real, per-deployment secret.
    jwt_secret = env.get("JWT_SECRET", "")
    if not jwt_secret or jwt_secret == DEFAULT_JWT_SECRET:
        print("ERROR: JWT_SECRET is still the default value. Run prepare_conf.py.", file=sys.stderr)
        sys.exit(1)

    # Check 2: every IMAC_BOOTSTRAP_USERS entry is "id:password:role:name" (multiple
    # entries separated by ";"). The password field must not be the default placeholder.
    # NOTE: this assumes passwords contain no ":" or ";" — consistent with the format
    # documented in .env.default.
    bootstrap_users = env.get("IMAC_BOOTSTRAP_USERS", "")
    if bootstrap_users:
        for entry in bootstrap_users.split(";"):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split(":")
            if len(parts) >= 2 and parts[1] == DEFAULT_BOOTSTRAP_PASSWORD:
                print(
                    "ERROR: IMAC_BOOTSTRAP_USERS still has the default password "
                    f"for user '{parts[0]}'. Set a strong password.",
                    file=sys.stderr,
                )
                sys.exit(1)

    # Check 3: APP_DIR must point at a real directory on the host. In Docker the
    # path is container-local, so skip the check there.
    if not args.docker:
        app_dir = Path(env.get("APP_DIR", ""))
        if not app_dir.exists():
            print(f"ERROR: APP_DIR ({app_dir}) does not exist.", file=sys.stderr)
            sys.exit(1)

    print("Configuration OK")


if __name__ == "__main__":
    main()
