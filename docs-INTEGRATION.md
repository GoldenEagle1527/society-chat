# 与 DeepSeek Harness 的关系

完整说明见根目录 **[INTEGRATION.md](./INTEGRATION.md)**。

摘要：

- 今日默认产品路径：`docker compose` / `npm run society-live`（自建 Cordis boot）。
- 可选：`npm run build:dsh-overlay` 后用官方 `dsh --patch profiles/dsh-society/cordis.patch.yml` 挂载同一套 `society-*` 服务（已在 `@deepseek-ai/dsh@0.2.0-rc.2` 验证 `--dump-config` 与 `--help` 加载）。
- 多 Agent 对话循环与电报风 UI **仍**由 society-chat 进程提供，尚未接到官方 `ctx.agents` loop。
