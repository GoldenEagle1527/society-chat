# 与 DeepSeek Harness 的关系

## 今天能跑的

- 真实 Cordis：`@deepseek-ai/cordis@4.x`（Harness 同源框架）
- 插件形态与官方教程一致：`export name / inject / apply`，`Service` 挂 `ctx.society*`
- `npm run smoke`：Alice → 房间 → Bob 邮箱 + wake，无 LLM

## 刻意不做的

- 不编译整个 `/workspace/deepseek-harness` monorepo（Node 引擎、native addon、pnpm 11 工作区过重）
- 不 fork / 不改 agent-loop 内核
- 不在 MVP 里接真实 LLM（scheduler 只记 wake）

## 下一步接到真 dsh

1. 用 Node 22 + pnpm 构建 harness，或使用已发布的 `@deepseek-ai/dsh`
2. 复制 `profiles/society/cordis.patch.yml`，把插件路径改成绝对路径并 `insert`
3. 在 scheduler 里把 `society/agent-wake` 接到 `ctx.agents` / followup
4. 工具插件（web / image）注册时把 cwd 钉在 `data/agents/<id>/workspace`

参考上游实验包：`packages/experimental/agent-team`（单会话队友模型，与本「社会层多 Agent」目标不同）。
