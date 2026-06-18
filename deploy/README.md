
# imac-deployment (minimal)
```bash
# build from v1
podman build -t imac-mobius:v0 -f deploy/DockerfileV0 .

```


```bash
cd /root/imac && git pull
# at project root
podman build -t imac-mobius:local .

# copy config for a new /data-based deployment, then review ports/secrets
cp .env.default ./deploy/.env

# at deploy
cd deploy
podman compose down
podman compose up
```

## Persistent data (host bind mounts)

`docker-compose.yml` currently keeps the legacy bind mounts used by the existing
deployment. The checked-in `deploy/.env` pins those legacy paths so current data
does not need to move. New deployments can use `.env.default` values, which put
runtime state under `/data`.

| host path                        | container path         | what                                      |
|----------------------------------|------------------------|-------------------------------------------|
| `host-data/data`                 | `/data`                | DB, turn-summaries, `model-access.json`, agent runtime/archive JSON, admin settings |
| `host-data/workspace`            | `/workspace`           | legacy user projects / session work dirs / user uploads |
| `host-data/protected_data`       | `/app/protected_data`  | legacy `CORE_DATA_PATH`                   |
| `host-data/imac`                 | `/root/.imac`          | legacy code-server per-user data & extensions (`cs-data`, `cs-ext`) |
| `host-data/codex`                | `/root/.codex`         | codex credentials/config (seeded on first boot, see below) |
| `host-data/claude`               | `/root/.claude`        | claude-code agent runtime config (`settings.api.json`) |

Key env mappings:

- New-container defaults: `WORKSPACE_ROOT=/data/workspace`,
  `CORE_DATA_PATH=/data/protected_data`, `CODE_SERVER_DATA_ROOT=/data/code_server`,
  `CS_DATA_ROOT=/data/code_server/cs-data`, `CS_EXT_ROOT=/data/code_server/cs-ext`.
- Current compose compatibility: `WORKSPACE_ROOT=/workspace`,
  `CORE_DATA_PATH=/app/protected_data`, `CODE_SERVER_DATA_ROOT=/root/.imac`,
  `CS_DATA_ROOT=/root/.imac/cs-data`, `CS_EXT_ROOT=/root/.imac/cs-ext`.

If you change those env paths, update the mounts to match. The directories are
created automatically on first `up`; to wipe all state, stop the stack and delete
`./deploy/host-data/`.

**codex credentials seeding:** `/root/.codex` is now a host mount, so the build
can't bake credentials straight into it (the mount would hide them). Instead the
image copies `deploy/codex` to `/opt/codex-seed`, and `docker-entrypoint.sh` copies
that into `$HOME/.codex` on first boot only (when the host dir is empty). Runtime
token refreshes then persist to the host. To re-seed, empty `host-data/codex` and
restart.

**Application source staging:** the image stores built source at `/app_image`.
At runtime, `docker-entrypoint.sh` copies `/app_image` into `/app` when
`/app/mobius` is missing, then starts the application from `/app`.
