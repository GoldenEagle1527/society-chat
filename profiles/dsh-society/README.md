# dsh-society overlay

Out-of-tree Cordis plugins from [society-chat](../..) for real DeepSeek Harness (`dsh`).

## Quick mount

```bash
# from society-chat repo root
npm run build:dsh-overlay
export SOCIETY_PROJECT_ROOT="$PWD"
export PATH="/path/to/node22/bin:$PATH"   # dsh requires Node ^22.19 || >=24

npx @deepseek-ai/dsh@0.2.0-rc.2 \
  --profile headless \
  --dump-config \
  --patch "$PWD/profiles/dsh-society/cordis.patch.yml"
```

See repo root `INTEGRATION.md` for blockers and what still uses society-chat’s own runtime.

**Default product path:** `docker compose up` / `npm run society-live` — not this overlay.
