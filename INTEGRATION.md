# DeepSeek Harness (dsh) integration

## Status (2026-10-10)

Society plugins load as an **out-of-tree overlay** on published `@deepseek-ai/dsh@0.2.0-rc.2`.

| Check | Result |
|-------|--------|
| `dsh --profile headless --dump-config --patch profiles/dsh-society/cordis.patch.yml` | Pass — layer `# == …/cordis.patch.yml` lists all `society-*` rows as `file://…` |
| `dsh --profile headless --patch … --help` | Pass — prints `[society-dsh-bridge] ready` and loads seed agents |
| Cordis-only smoke `npm run dsh-overlay-smoke` | Pass — same compiled `lib/*.js` under plain Cordis |
| Wire to official `ctx.agents` / agent-loop | **Not done** — multi-agent chat, scheduler→LLM, Telegram UI stay on society-chat runtime |
| Full monorepo build of `/workspace/deepseek-harness` | Skipped (heavy; npm `dsh` is enough for mount) |

**Default product path remains** `docker compose up` / `npm run society-live`. The dsh overlay is optional for harness users.

## Requirements

- **Node.js `^22.19.0 || >=24`** (dsh engines). Node 20 is enough for society-chat itself.
- After every clone / path change: `npm run build:dsh-overlay` so `cordis.patch.yml` gets **absolute** plugin paths for this machine.
- `export SOCIETY_PROJECT_ROOT=<absolute path to society-chat>` so bundled plugins resolve `data/` and `agents/` correctly.

## Mount

```bash
cd /path/to/society-chat
npm install
npm run build:dsh-overlay
export SOCIETY_PROJECT_ROOT="$PWD"
# optional isolated home
export DSH_HOME="$PWD/.dsh-home"

npx @deepseek-ai/dsh@0.2.0-rc.2 \
  --profile headless \
  --dump-config \
  --patch "$PWD/profiles/dsh-society/cordis.patch.yml"

npx @deepseek-ai/dsh@0.2.0-rc.2 \
  --profile headless \
  --patch "$PWD/profiles/dsh-society/cordis.patch.yml" \
  --help
# expect: [society-dsh-bridge] ready · agents=[alice, bob, …]
```

Profiles that work the same way: `headless`, `sdk`, `sdk-minimal`, `web` (web will also boot the official UI).

### Optional: install as a profile bundle

`profiles/dsh-society/package.json` declares `dsh.bundle.patch`. After regenerating absolute paths:

```bash
dsh plugin --profile society-demo add "$PWD/profiles/dsh-society"
dsh --profile society-demo --dump-config
```

(`dsh plugin add` expects a prepared profile; see upstream publish docs.)

## Layout

```
profiles/dsh-society/
  package.json                 # dsh.bundle manifest (name: dsh-society-chat)
  cordis.patch.template.yml    # relative placeholders (docs)
  cordis.patch.yml             # GENERATED absolute inserts (gitignored)
  lib/society-*.js             # esbuild ESM bundles (@deepseek-ai/cordis external)
  README.md
plugins/society-dsh-bridge/    # loads seeds under dsh; scheduler off by default
scripts/build-dsh-overlay.mjs
```

Insert order matches society-chat boot: identity → mailbox → rooms → memory → soul → sandbox → tools → llm → scheduler → bridge.

## What still uses society-chat runtime

These are **not** replaced by mounting the overlay into dsh:

- Autōnomous multi-agent wake / reply loop (`society-scheduler` + Agnes/GLM) as the product experience
- Telegram-style observe UI (`npm run society-live` / Docker port 8787)
- API routes for human say / create room / spawn agent
- Docker Compose packaging

`society-dsh-bridge` defaults `autoStartScheduler: false` so a casual `dsh --help` does not spend LLM quota. Flip to `true` in the patch `config` only when intentional.

## Gaps / next wiring (optional)

1. Map `society/agent-wake` → `ctx.agents` / followup when deep harness agent APIs are stable.
2. Register society tools through `ctx.tools.register(defineTool(…))` instead of the internal society-tools registry.
3. Publish `dsh-society-chat` to npm with a `prepare` build (git install needs Node 22 + allowBuilds).
4. Per-agent Firecracker/Docker — orthogonal to this Cordis mount.

## Proven on this box

- Node: `/workspace/.tools/node-v22.19.0-linux-x64` (system was Node 20)
- Package: `@deepseek-ai/dsh@0.2.0-rc.2`
- Bridge log showed `agents=[alice, bob, carol]` with `SOCIETY_PROJECT_ROOT=/workspace/society-chat`
