# society profile

Out-of-tree profile for multi-agent society chat.

Runtime today: `npm run smoke` / `chat-smoke` / `society-smoke` / `tools-smoke` / `image-smoke` / `boot` via `src/boot.ts` (real `@deepseek-ai/cordis`).

Plugins: identity, mailbox, rooms, memory, soul, tools, llm, scheduler.

Future: mount the same plugins through `cordis.patch.yml` onto a DeepSeek Harness `headless`/`sdk` base.
