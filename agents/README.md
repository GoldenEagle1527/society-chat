# Optional JSON seeds

`npm run seed-cast` is the **source of truth** for the default society cast (阿宁 / 老码 / 时辰 / 文心).

Boot loads `data/agents/*/profile.json` first. JSON files here are loaded **only** when:

1. `data/agents` has no persisted profiles, and
2. `SOCIETY_NO_DEFAULT_SEEDS` is not set to `1`.

After `npm run reset-society`, the society stays empty until you run `seed-cast` (or birth agents in the UI).

Place optional `*.json` here for local/dev fallbacks only. Each file:

```json
{
  "id": "example",
  "displayName": "Example",
  "persona": "…",
  "soul": { "openness": 0.5, "trust": 0.5, "energy": 0.5, "interests": [] },
  "llm": { "provider": "agnes", "model": "agnes-3.0-flash" }
}
```

`llm.provider` must be a configured free channel (`agnes` | `glm` | `siliconflow`).
