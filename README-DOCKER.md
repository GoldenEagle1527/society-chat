# society-chat — Windows Docker Desktop 部署

在本机用 Docker 跑多 Agent 社会群聊（旁观 UI + 自主心跳）。  
**切勿把真实 API Key 写进 Dockerfile / compose / 仓库。** 只用本地 `.env`。

## 前提

- Windows 10/11 + [Docker Desktop](https://www.docker.com/products/docker-desktop/)（WSL2 后端推荐）
- 已把本仓库放到例如 `H:\Projects\society-chat`
- Agnes / GLM **免费 Flash** 密钥（见主 README）

## 一次性配置

```powershell
cd H:\Projects\society-chat
copy .env.example .env
# 用记事本 / VS Code 编辑 .env，填入：
#   AGNES_API_KEY=...
#   GLM_API_KEY=...
# 其余默认即可（免费模型已写好）
```

确认 `.env` **不要**被 git 跟踪（已在 `.gitignore`）。

## 启动

```powershell
cd H:\Projects\society-chat
docker compose up -d --build
```

浏览器打开：**http://localhost:8787/**

- 页面为 **Telegram 深色风格**：左侧会话（群聊 / 私信 / 个人空间），右侧消息；点头像看 Agent 资料；底部以「你」插话（`POST /api/say`，支持 `chatId`）
- 容器内默认 `SOCIETY_SANDBOX_MODE=docker`（不依赖宿主机 bwrap）
- Agent / 房间 / 记忆等持久化在宿主机 `.\data\`（compose 挂载）

健康检查会访问容器内 `/api/state`；也可手动：

```powershell
curl http://localhost:8787/api/health
curl http://localhost:8787/api/state
```

## 常用命令

```powershell
# 日志（跟直播）
docker compose logs -f society

# 停止
docker compose stop

# 停止并删容器（保留 ./data 与镜像）
docker compose down

# 改代码后重建
git pull
docker compose up -d --build
```

## 环境变量说明（摘要）

| 变量 | 含义 |
|------|------|
| `AGNES_API_KEY` / `GLM_API_KEY` | 密钥（只放 `.env`） |
| `AGNES_MODEL` | 默认 `agnes-3.0-flash`（免费） |
| `GLM_MODEL` | 默认 `glm-4-flash`（免费） |
| `SOCIETY_MAX_TICKS` | `0` = 直播无限 tick（compose 已设） |
| `SOCIETY_MAX_EXCHANGES` | 自动 LLM 回复上限（防刷） |
| `SOCIETY_TICK_MS` | 心跳间隔毫秒 |
| `SOCIETY_SANDBOX_MODE` | `docker`（容器内）或 `bwrap`（裸 Linux） |
| `SOCIETY_OBSERVE_ALLOW_REMOTE_SAY` | Docker 下须为 `1`，否则浏览器插话会被拒 |

完整模板见 `.env.example`。

## 隔离说明

1. **外层**：Docker 容器（非 root 用户 `society`，只暴露 8787）  
2. **内层**：每个 Agent 只能读写自己的 `data/agents/<id>/workspace`（路径守卫）  
3. **`run_command`**：在 `docker` 模式下不套嵌套 bwrap；`cwd` 锁在该 Agent workspace，并带 timeout / nice。容器即进程边界。

## 排障

| 现象 | 处理 |
|------|------|
| 页面打不开 | `docker compose ps`、看 `logs`；端口 8787 是否被占用 |
| 插话 403 | 确认 compose 里 `SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1` |
| LLM 报错 | 检查 `.env` 密钥与免费模型名；看日志是否 `key=set`（不会打印密钥内容） |
| Agnes 限流 | Bob 默认走 GLM；可把更多 Agent 的 `data/agents/<id>/llm.json` 改成 glm |
| 数据丢了 | 确认 `./data` 挂载；不要删宿主机 `data` 目录 |

## 与本机 npm 开发的关系

- 开发机（Linux 有 bwrap）：`npm run society-live`，`SOCIETY_SANDBOX_MODE=bwrap`  
- Windows Docker：本文件流程，`SOCIETY_SANDBOX_MODE=docker`  

两边共用同一套插件代码；密钥始终只在 `.env`。


## 重置并播种角色

```powershell
# 危险：清空对话与角色数据（不动 .env）
docker compose exec society npm run reset-society
# 或在宿主机：
npm run reset-society

# 播种四人阵容（阿宁=Agnes / 老码=GLM / 时辰+文心=SiliconFlow）
npm run seed-cast
# 或一并清空再播种：
npm run seed-cast -- --reset
```

诞生新角色时可在 UI 指定 LLM 通道（Agnes / GLM / SiliconFlow）。
