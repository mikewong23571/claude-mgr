# claude-mgr

个人用 **Claude Code OAuth 网关**：复用 Claude Code 登录得到的 Claude.ai 订阅凭证，
把本人多个 Claude Code 兼容客户端的接入收敛到一个本地、可审计、可解释的 TypeScript 服务。

这是单人本地服务，**不是多租户产品**。它不绕过服务端限额、不隐藏账号、不伪造订阅或设备指纹。

## 能做什么

- 通过 Claude Code 的 OAuth 2.0（Authorization Code + PKCE）登录，持久化 Claude.ai 订阅 token。
- 管理多个 Claude.ai 账号、账号池与 token，按用途隔离用量与审计。
- 代理 `POST /v1/messages`（non-streaming JSON 与 SSE streaming），补齐 Claude Code 兼容的
  headers / metadata / betas，并保留上游 quota header 与 request id。
- 区分上游 Anthropic 错误（保留 status/type/message/request id）与本地网关错误（`gateway_*`）。
- 提供本地登录 + RBAC 的管理台（React + Ant Design），管理账号、池、本地客户端与凭证。
- 记录本地审计事件（默认只记元数据，不记 prompt / completion 正文）。

## 技术栈

| 方面 | 选择 |
| --- | --- |
| 语言 / 运行时 | TypeScript，Node.js ≥ 24 |
| HTTP 层 | Hono 路由模块（`src/http/`） |
| 持久化 | SQLite（`node:sqlite`），OAuth token 按项目决定**明文**存储 |
| 上游调用 | 轻量 raw `fetch` 适配层（`src/upstream/`） |
| 校验 | Zod schema（`src/http/validation.ts`） |
| 管理台 | React + Ant Design + Vite（`frontend/`，构建产物在 `public/admin/`） |

`@anthropic-ai/sdk` 与 `@anthropic-ai/claude-code` 仅作为 dev / spike / 参考兼容验证依赖。

## 快速开始

需要 Node.js ≥ 24。

```bash
npm install
```

首次启动时，如果数据库中没有本地 app user，用环境变量创建 owner（后续启动可移除）：

```bash
CLAUDE_MGR_BOOTSTRAP_OWNER=owner \
CLAUDE_MGR_BOOTSTRAP_PASSWORD='<strong-password>' \
HOST=127.0.0.1 PORT=8787 CLAUDE_MGR_DB=data/claude-mgr.sqlite \
npm run dev
```

服务启动后会确保存在一个 `default` 账号池和一个指向它的 `default` 本地客户端。
随后在管理台完成 Claude Code OAuth 登录、创建本地客户端 secret（secret 只显示一次）。

让 Claude Code 兼容客户端走本网关：

```bash
ANTHROPIC_BASE_URL="http://localhost:8787" \
ANTHROPIC_API_KEY="<local-client-secret>"
```

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `HOST` | 监听地址 | `127.0.0.1` |
| `PORT` | 监听端口 | `8787` |
| `CLAUDE_MGR_DB` | SQLite 路径 | `data/claude-mgr.sqlite` |
| `CLAUDE_MGR_BOOTSTRAP_OWNER` | 首次启动创建的 owner 用户名 | — |
| `CLAUDE_MGR_BOOTSTRAP_PASSWORD` | 首次启动的 owner 密码 | — |
| `CLAUDE_MGR_DEBUG_TRAFFIC` | 设为 `1` 开启脱敏 traffic debug | 关闭 |

### Docker

```bash
docker build -t claude-mgr:local .
docker volume create claude-mgr-data
docker run --rm -p 8787:8787 \
  -v claude-mgr-data:/app/data \
  -e CLAUDE_MGR_BOOTSTRAP_OWNER=owner \
  -e CLAUDE_MGR_BOOTSTRAP_PASSWORD='<strong-password>' \
  claude-mgr:local
```

镜像默认监听 `0.0.0.0:8787`，SQLite 默认写到 `/app/data/claude-mgr.sqlite`。

## 常用命令

```bash
npm run dev                # 启动本地网关
npm run dev:frontend       # 启动管理台 Vite 开发服务器
npm run build:frontend     # 构建 public/admin/ 管理台产物
npm run typecheck          # 服务端 + 前端 TS 类型检查
npm test                   # Vitest（含 governance 检查）
npm run probe:claude-code  # 探测已安装 Claude Code 包的协议行为
npm run smoke:live -- --dry-run --host localhost   # 不等 OAuth callback 的冒烟
```

完整的 live smoke、Messages 端到端、debug traffic 用法见 [`AGENTS.md`](AGENTS.md)。
注意：带 `--messages` 的 live smoke 会消耗真实 Claude.ai 账号额度。

## 代码结构

```text
src/index.ts        运行时装配与服务启动
src/http/           Hono app、路由模块、响应与校验
src/auth/           本地登录、会话、RBAC、本地客户端 secret
src/oauth/          OAuth PKCE、token 交换、profile、刷新
src/messages/       Messages 适配与网关行为
src/claude-cli/     Claude Code service 端点网关
src/api-proxy/      受限上游代理网关
src/upstream/       Anthropic / Claude 端点的 raw fetch 客户端
src/routing/        账号 / token / 池 / session 选择
src/storage/        SQLite schema 与 store API
src/quota/          quota / rate-limit header 解析
src/audit/          审计用量提取
src/debug/          脱敏本地 traffic recorder
src/domain/         共享运行时领域类型
frontend/           React / Ant Design 管理台源码
public/admin/       Vite 构建产物（服务端直接托管）
tests/              Vitest 覆盖与可执行 governance 检查
scripts/            live smoke 与 Claude Code 包探针
docs/               设计、策略与验证证据
repos/              只读参考 submodule（运行时代码不得 import）
data/               本地 SQLite（git 忽略，可能含明文 token）
```

## 文档

- [`AGENTS.md`](AGENTS.md) — 面向编码 agent 的操作约定，记录当前有效的工程与协议规则。
- [`docs/module-boundaries.md`](docs/module-boundaries.md) — 模块边界与治理规则。
- [`docs/message-forwarding-policy.md`](docs/message-forwarding-policy.md) — Messages 转发策略。
- [`docs/local-api.md`](docs/local-api.md) — 本地 API 说明。
- [`docs/auth-and-user-management-plan.md`](docs/auth-and-user-management-plan.md) — 本地认证与用户管理设计。
- [`docs/hono-http-migration-plan.md`](docs/hono-http-migration-plan.md) — Hono HTTP 迁移计划。
- [`docs/claude-code-auth-and-identity-source-review.md`](docs/claude-code-auth-and-identity-source-review.md) — Claude Code 认证与身份源码评审。
- [`docs/user-stories.md`](docs/user-stories.md) / [`docs/frontend-user-stories.md`](docs/frontend-user-stories.md) / [`docs/story-acceptance-audit.md`](docs/story-acceptance-audit.md) — 用户故事与验收。
- [`docs/initial-design-and-mvp-spec.md`](docs/initial-design-and-mvp-spec.md) — **已归档**的初始设计与 MVP 规格（原 README）。

## 数据与凭证安全

- `data/*.sqlite` 由 git 忽略，可能包含明文 OAuth access / refresh token，切勿提交或外传。
- 本地 app user 密码、会话 token、本地客户端 secret 以 hash 存储；client secret 明文仅创建时返回一次。
- traffic debug 输出在 `data/debug/`，结构化脱敏，不记录 prompt / completion / tool result / 文件内容，
  以及 `authorization` / `x-api-key` / cookie 等敏感 header。

## 非目标

不实现多租户隔离；不隐藏 / 伪造 / 绕过服务端账号、订阅、限额、风控语义；
不把多个上游账号自动混成同一上游身份；不复刻 Claude Code 全部 remote / bridge / telemetry 能力。
