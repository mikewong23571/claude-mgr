# Frontend User Stories

本文档记录 `claude-mgr` 如果引入前端管理控制台时应覆盖的用户故事。前端定位是本地管理控制台，不是聊天产品。

## 1. 前端定位

前端的核心目标是让服务拥有者看清楚：

1. Claude.ai 账号是否已接入。
2. OAuth token 是否健康。
3. 本地客户端绑定到哪个账号池。
4. 请求是否成功。
5. 错误来自 Anthropic 上游还是本地网关。
6. quota snapshot 和 audit event 是否符合预期。

前端不应成为新的协议实现层。它只调用本地 HTTP API，并把本地服务已有的账号、账号池、客户端、审计、quota 和诊断信息以可操作方式呈现。

## 2. 设计原则

1. 优先做管理面，不做聊天 UI。
2. 不展示、不复制明文 access token 或 refresh token。
3. 默认不展示、不保存 prompt、completion、tool result、文件正文。
4. 所有上游协议事实仍以后端、源码调研、npm probe 和 live smoke 为准。
5. 前端只展示本地路由和审计语义，不把本地 client id、pool id、token label 伪装成上游字段。
6. 真实 Messages smoke 会消耗 Claude.ai 额度，必须显式提示和确认。

## 3. 信息架构

建议第一版页面结构：

```text
Dashboard
Accounts
Pools
Local Clients
Tokens
Audit Events
Quota
Claude Code Setup
Smoke / Diagnostics
```

第一版最重要的是：

1. Accounts
2. Pools
3. Local Clients
4. Audit Events
5. Quota

这五块直接对应当前后端的核心价值：可配置、可审计、可解释。

## 4. P0 用户故事

| ID | 用户故事 | 验收点 |
| --- | --- | --- |
| UI-A1 | 作为服务拥有者，我要看到服务健康状态 | 显示 `/health`、服务地址、最近一次检查时间；能明确区分服务在线/离线。 |
| UI-B1 | 作为服务拥有者，我要发起 Claude.ai OAuth 登录 | 输入 token label、source device、目标 pool，生成 authorize URL，并能打开浏览器继续授权。 |
| UI-B2 | 作为服务拥有者，我要看到已接入账号 | 列出 account uuid、email、display name、subscription、rate tier、enabled 状态；不显示 access/refresh token。 |
| UI-B3 | 作为服务拥有者，我要禁用或启用账号 | 操作后 account-router 不再选择 disabled account；UI 明确展示禁用状态。 |
| UI-C1 | 作为服务拥有者，我要管理账号池 | 创建、编辑、删除 pool；查看 pool members。 |
| UI-C2 | 作为服务拥有者，我要调整账号池成员 | 添加/移除账号，设置 enabled 和 priority。 |
| UI-C3 | 作为服务拥有者，我要管理本地客户端 | 创建 client、绑定默认 pool、启用/禁用 client。 |
| UI-D1 | 作为服务拥有者，我要看到 token 元数据 | 展示 label、source device、account、scopes、expiresAt、lastUsedAt；明确不展示明文 token。 |
| UI-E1 | 作为服务拥有者，我要查看请求审计 | 按时间列出 client、pool、account、token label、model、status、error type、request id。 |
| UI-E2 | 作为服务拥有者，我要区分上游错误和网关错误 | `gateway_*` 和 upstream error 分开展示，保留 upstream request id。 |
| UI-F1 | 作为服务拥有者，我要查看 quota snapshot | 按 account/token 展示 allowed/rejected、rate limit type、utilization、reset 时间。 |
| UI-G1 | 作为服务拥有者，我要复制 Claude Code CLI 配置方式 | 展示 `ANTHROPIC_BASE_URL`、`ANTHROPIC_CUSTOM_HEADERS` 示例，避免手工拼错。 |
| UI-H1 | 作为服务拥有者，我要运行轻量 smoke test | 可触发本地 health/admin 检查；真实 Messages smoke 必须明确提示会消耗额度。 |

## 5. P1 用户故事

| ID | 用户故事 | 验收点 |
| --- | --- | --- |
| UI-I1 | 作为服务拥有者，我要看账号池路由解释 | 给定 client/pool，显示当前会选哪个 account/token，以及为什么跳过其他账号。 |
| UI-I2 | 作为服务拥有者，我要按 client/account/model 过滤 audit | 支持时间范围、status、error type、model、client、account 过滤。 |
| UI-I3 | 作为服务拥有者，我要查看错误详情 | 展示 upstream request id、client request id、HTTP status、错误来源、排查建议。 |
| UI-I4 | 作为服务拥有者，我要看到 token refresh 状态 | 展示最近 refresh 成功/失败、过期时间、失败原因。 |
| UI-I5 | 作为服务拥有者，我要导出审计元数据 | 导出 JSON/CSV，不包含 prompt、completion、token 明文。 |
| UI-I6 | 作为服务拥有者，我要看到兼容治理状态 | 显示 `probe:claude-code` 结果、Claude Code package version、关键 marker 是否通过。 |

## 6. 非目标

前端 MVP 不做：

1. 聊天 UI，除非只是受控 smoke console。
2. 明文 access token / refresh token 展示或复制。
3. prompt、completion、tool result、文件正文浏览。
4. 多用户权限系统。
5. WebSocket 推理代理。
6. 账号合并、绕限、伪装设备指纹相关配置。
7. Claude Code remote sessions / CCR 管理。
8. MCP proxy 管理。
9. telemetry / GrowthBook / Datadog 复制。

## 7. 后端 API 依赖

前端 MVP 直接依赖当前本地 API：

```text
GET /health
GET /oauth/authorize
GET /callback
POST /oauth/callback
POST /admin/pools
GET /admin/pools
GET /admin/pools/{pool_id}
PATCH /admin/pools/{pool_id}
DELETE /admin/pools/{pool_id}
POST /admin/pools/{pool_id}/members
GET /admin/pools/{pool_id}/members
PATCH /admin/pools/{pool_id}/members/{account_uuid}
DELETE /admin/pools/{pool_id}/members/{account_uuid}
POST /admin/clients
GET /admin/clients
PATCH /admin/clients/{client_id}
DELETE /admin/clients/{client_id}
GET /admin/accounts
PATCH /admin/accounts/{account_uuid}
GET /admin/tokens
GET /admin/audit-events
GET /admin/quota-snapshots
```

如果前端需要 route explanation、probe result、smoke execution 或 audit filtering，应优先补后端 API 和测试，再做前端展示。

## 8. 首版验收建议

首版前端可以视为通过，当它满足：

1. 能完成 OAuth 登录入口的创建和授权 URL 展示。
2. 能查看账号、token 元数据、账号池、本地客户端。
3. 能维护账号池成员和本地客户端默认账号池。
4. 能查看 audit events 和 quota snapshots。
5. 能复制 Claude Code CLI 配置片段。
6. 不暴露 token 明文，不展示正文内容。
7. 对上游错误和 `gateway_*` 错误有不同视觉分类。

