# Local API

本文档记录当前 `claude-mgr` 本地 HTTP API。范围仍限定为个人本地服务、OAuth 认证后的 Messages 交互、多账号/账号池、审计和 quota。

## 1. Runtime

默认启动：

```text
npm run dev
```

默认监听：

```text
http://127.0.0.1:8787
```

环境变量：

```text
HOST=127.0.0.1
PORT=8787
CLAUDE_MGR_DB=data/claude-mgr.sqlite
CLAUDE_MGR_DEBUG_TRAFFIC=0
CLAUDE_MGR_DEBUG_DIR=data/debug
```

SQLite 数据库会自动初始化 schema。MVP 明文保存 OAuth access token 和 refresh token。

真实上游 smoke：

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
```

默认只验证 OAuth/profile 入库：脚本会启动本地服务、创建 smoke pool/client、打印 Claude Code OAuth URL，并等待浏览器 callback。它不会默认发送 Messages 请求。脚本会断言 token、account、pool membership 已入库；如果传 `--messages`，会用官方 Claude Code CLI 通过本地网关发起端到端请求，并断言 CLI 返回 `OK`、Messages audit 成功、官方入站 session 已映射到服务端 upstream session。脚本完成后会打印最近 audit event 和 quota snapshot 元数据，不打印 token、prompt 或 completion 正文。

只验证 smoke 脚本和本地服务入口、不等待 OAuth callback 时：

```text
npm run smoke:live -- --dry-run --host localhost
```

如需验证真实官方 Claude Code CLI 端到端 Messages，需要显式指定模型：

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model <anthropic-model>
```

该模式会调用上游 `/v1/messages`，会消耗对应 Claude.ai 账号额度。

### Debug Traffic

开发或 spike 中需要比较 Claude Code 客户端请求与网关上游请求时，可以打开 traffic debug：

```text
CLAUDE_MGR_DEBUG_TRAFFIC=1 npm run dev
```

或者在端到端 smoke 中直接开启：

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model <anthropic-model> --debug-traffic
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model <anthropic-model> --debug-dir data/debug/sonnet-spike
```

输出为 JSONL 文件，默认目录是 `data/debug`。每条记录包含：

1. `direction`: `downstream` 表示 Claude Code 到本地网关，`upstream` 表示本地网关到 Anthropic。
2. `phase`: `request` 或 `response`。
3. method、URL、status 和 headers。
4. Messages body 结构摘要，例如 model、stream、消息数量、角色分布、content block 类型、system block 数量、metadata key、betas/thinking 是否存在。

debug 文件只用于本地协议排查。`authorization`、`x-api-key`、cookie、Anthropic token 类 headers 会被写成 `[redacted]`；body 只记录结构摘要，不写 prompt、completion、tool result 或文件内容。

## 2. Health

```text
GET /health
```

响应：

```json
{ "ok": true }
```

## 3. OAuth

### Start Login

```text
GET /oauth/authorize?label=<token_label>&source_device=<device_label>&redirect_uri=<optional_callback_url>&pool_id=<optional_pool>
```

作用：

1. 生成 OAuth state 和 PKCE verifier。
2. 在当前进程内保存 pending login。
3. 返回 Claude Code OAuth authorize URL。
4. 如果没有传 `redirect_uri`，默认使用当前服务 origin 的 `/callback`。

响应：

```json
{
  "authorize_url": "https://claude.com/cai/oauth/authorize?...",
  "state": "..."
}
```

### Complete Login

浏览器回调：

```text
GET /callback?code=<authorization_code>&state=<state>
```

手动回调：

```text
POST /oauth/callback
Content-Type: application/json
```

请求：

```json
{
  "code": "authorization-code",
  "state": "state-from-authorize"
}
```

作用：

1. 校验 pending state。
2. 使用 code verifier 调用 token endpoint。
3. 调用 profile endpoint。
4. 明文保存 token。
5. 保存或更新 account。
6. 如果 authorize 阶段传了 `pool_id`，把账号加入账号池。

响应：

```json
{
  "account_uuid": "...",
  "organization_uuid": "...",
  "token_label": "main",
  "scopes": ["user:profile", "user:inference"]
}
```

## 4. Admin

这些接口是单人本地服务管理面，MVP 暂不做多用户权限系统。

### Create Pool

```text
POST /admin/pools
```

请求：

```json
{
  "id": "main",
  "name": "Main",
  "purpose": "default development pool"
}
```

### List Pools

```text
GET /admin/pools
```

### Get Pool

```text
GET /admin/pools/{pool_id}
```

### Update Pool

```text
PATCH /admin/pools/{pool_id}
```

请求：

```json
{
  "name": "Main",
  "purpose": "updated purpose"
}
```

### Delete Pool

```text
DELETE /admin/pools/{pool_id}
```

删除账号池会移除 pool members，并把绑定到该 pool 的 local client default pool 清空。

### Add Pool Member

```text
POST /admin/pools/{pool_id}/members
```

请求：

```json
{
  "account_uuid": "acc_...",
  "priority": 100,
  "enabled": true
}
```

### List Pool Members

```text
GET /admin/pools/{pool_id}/members
```

### Update Pool Member

```text
PATCH /admin/pools/{pool_id}/members/{account_uuid}
```

请求：

```json
{
  "priority": 50,
  "enabled": false
}
```

禁用成员后，`account-router` 不会再选择该账号。

### Remove Pool Member

```text
DELETE /admin/pools/{pool_id}/members/{account_uuid}
```

### Create Local Client

```text
POST /admin/clients
```

请求：

```json
{
  "id": "laptop",
  "name": "Laptop",
  "enabled": true,
  "default_pool_id": "main"
}
```

### List Local Clients

```text
GET /admin/clients
```

### Update Local Client

```text
PATCH /admin/clients/{client_id}
```

请求：

```json
{
  "name": "Laptop",
  "enabled": false,
  "default_pool_id": null
}
```

禁用本地客户端后，`/v1/messages` 会返回 `gateway_auth_error`，不会继续进入账号池或上游请求。本地客户端 id 仍只用于本地认证和审计，不透传给上游。

### Delete Local Client

```text
DELETE /admin/clients/{client_id}
```

### List Accounts

```text
GET /admin/accounts
```

### Update Account

```text
PATCH /admin/accounts/{account_uuid}
```

请求：

```json
{
  "enabled": false
}
```

禁用账号后，`account-router` 不会再选择该账号的 token。账号、token、quota snapshot 和 audit event 保留在本地数据库中。

### List Tokens

```text
GET /admin/tokens
```

响应会隐藏明文 `accessToken` 和 `refreshToken`，只返回 token 元数据。凭证本身仍明文保存在 SQLite。

### List Audit Events

```text
GET /admin/audit-events
```

### List Quota Snapshots

```text
GET /admin/quota-snapshots
```

Quota snapshot 来自上游响应 headers 中的 `anthropic-ratelimit-unified-*` 信息，绑定到选中 account 和 token label。普通 `/v1/messages` 响应默认不返回这些账号级 quota 元数据。`account-router` 会跳过最近 snapshot 为 `rejected` 且 reset 尚未过期的账号；这只是保守可用性过滤，不是复杂负载均衡。

## 5. Claude Code Service Endpoints

这些接口对应 Claude Code 参考源码中除 `/v1/messages` 外的 first-party authenticated GET 请求。它们仍通过本地 `x-claude-mgr-client-id` / 可选 `x-claude-mgr-pool-id` 做账号池路由，并要求选中的 OAuth token 具备 `user:profile` scope。本地 client id、pool id、token label、source device 不会透传上游。

### Usage

```text
GET /api/oauth/usage
x-claude-mgr-client-id: <local_client_id>
x-claude-mgr-pool-id: <optional_pool_override>
```

作用：

1. 选择满足 `user:profile` scope 且未过期的 token。
2. 使用 OAuth bearer token 调用上游 `/api/oauth/usage`。
3. 透传上游 JSON body。
4. 写入 audit event，endpoint 为 `/api/oauth/usage`。

上游请求 headers 使用：

```text
Authorization: Bearer <selected_access_token>
Content-Type: application/json
User-Agent: claude-mgr/0.1.0
anthropic-beta: oauth-2025-04-20
```

### Bootstrap

```text
GET /api/claude_cli/bootstrap
x-claude-mgr-client-id: <local_client_id>
x-claude-mgr-pool-id: <optional_pool_override>
```

作用：

1. 选择满足 `user:profile` scope 且未过期的 token。
2. 使用 OAuth bearer token 调用上游 `/api/claude_cli/bootstrap`。
3. 透传上游 JSON body，例如 `client_data` 和 `additional_model_options`。
4. 写入 audit event，endpoint 为 `/api/claude_cli/bootstrap`。

这些接口的上游 401 会触发一次 token refresh retry；本地没有 profile-scoped token 时返回 `gateway_no_eligible_token`。上游错误保留 status、type、message 和 request id。

### Transparent Same-Origin Proxy Endpoints

以下 Claude Code 同域接口按透明代理处理。网关不解析业务 body，不做文件大小、payload schema、trusted-device display name 等额外校验，也不保存正文内容。

```text
GET  /v1/files
POST /v1/files
GET  /v1/files/{file_id}/content
POST /api/event_logging/batch
POST /api/auth/trusted_devices
```

请求头处理规则：

1. `x-claude-mgr-client-id` / `x-claude-mgr-pool-id` 只用于本地路由，不透传上游。
2. 下游 `authorization`、`x-api-key`、`anthropic-api-key`、`anthropic-auth-token`、`anthropic-organization-id` 会被移除。
3. 对需要本地账号的接口，网关选择该 client/pool 下任意未过期 token，并写入上游 `Authorization: Bearer <selected_access_token>`；不在本地做 scope 判断。
4. Files 请求如果下游没给，会补 `anthropic-version: 2023-06-01` 和 `anthropic-beta: files-api-2025-04-14,oauth-2025-04-20`。
5. hop-by-hop headers 和 `content-length` 不透传，由 fetch/HTTP 栈重新计算。
6. 上游响应 body 和 status 透明返回；响应 headers 会过滤 hop-by-hop headers。

`/api/event_logging/batch` 允许没有本地 client header，此时不注入 OAuth，只透明转发下游请求并写 `__anonymous__` audit event。其他接口仍需要本地 client header，以便网关选择 OAuth token。

## 6. Messages

### Non-Streaming

```text
POST /v1/messages
Content-Type: application/json
x-claude-mgr-client-id: <local_client_id>
x-claude-mgr-pool-id: <optional_pool_override>
X-Claude-Code-Session-Id: <official_claude_code_session_id>
```

请求 body 使用 Anthropic Messages 语义。当前 adapter 只允许 `docs/message-forwarding-policy.md` 中的 MVP allowlist 字段。

当官方 Claude Code 客户端发送 `X-Claude-Code-Session-Id` 时，服务端只把它作为本地路由 key：`local_client_id + pool + inbound session id` 会绑定到首次选中的 Claude.ai account。后续同一会话继续使用该 account；如果该 account 不可用，网关返回本地错误，不静默切到其他账号。上游请求中的 `X-Claude-Code-Session-Id` 和 `metadata.user_id.session_id` 由服务端生成的映射 id 填充，不透传入站 session id。

响应：

1. 成功时返回上游 JSON body。
2. 保留 `request-id` 和 `x-client-request-id`。
3. 写入 audit event。无 eligible token、禁用本地客户端、缺少本地客户端头等本地失败也会写入元数据审计。
4. 尝试保存 quota snapshot。

### SSE Streaming

```text
POST /v1/messages
Content-Type: application/json
x-claude-mgr-client-id: <local_client_id>
X-Claude-Code-Session-Id: <official_claude_code_session_id>

{
  "model": "...",
  "max_tokens": 1024,
  "stream": true,
  "messages": [...]
}
```

响应：

```text
Content-Type: text/event-stream
```

服务不把上游 SSE 完整缓冲后再返回，而是转发 upstream stream body。stream 正常结束后 audit event 更新为 `success`；读取失败或中断时更新为 `interrupted` 并记录 `gateway_stream_parse_error` 或同类 `gateway_*` error type。

### Claude Code CLI Smoke

Claude Code CLI 可通过环境变量指向本地网关。基于 Claude Code 2.1.185 源码和 npm 包实测：

1. `ANTHROPIC_BASE_URL` 指向本地网关根 URL。
2. `ANTHROPIC_API_KEY` 在 `--bare` 模式下必须存在，但这里只作为 Claude Code 本地认证路径的占位值；网关不会把下游 `x-api-key` 转发给上游。
3. `ANTHROPIC_CUSTOM_HEADERS` 使用换行分隔的 curl 风格 header，不是 JSON。
4. 使用临时 `HOME` 和 `CLAUDE_CONFIG_DIR` 可以避免读写真实 `~/.claude` 状态。

示例：

```bash
tmp_home=$(mktemp -d /tmp/claude-mgr-cc-home.XXXXXX)
tmp_cfg=$(mktemp -d /tmp/claude-mgr-cc-config.XXXXXX)

env \
  HOME="$tmp_home" \
  CLAUDE_CONFIG_DIR="$tmp_cfg" \
  ANTHROPIC_BASE_URL="http://localhost:8787" \
  ANTHROPIC_API_KEY="local-dummy-key" \
  ANTHROPIC_CUSTOM_HEADERS=$'x-claude-mgr-client-id: live-smoke-client\nx-claude-mgr-pool-id: live-smoke' \
  node_modules/.bin/claude \
    --bare \
    --print \
    --no-session-persistence \
    --disable-slash-commands \
    --model claude-haiku-4-5-20251001 \
    --output-format json \
    "Respond with exactly OK and nothing else."
```

当前 MVP 的 Claude Code 兼容治理规则会接受 `context_management` 作为下游输入，但不会把它转发给 Claude.ai OAuth Messages 上游；实测上游会拒绝该 beta-only 字段。

## 7. Error Semantics

网关错误：

```json
{
  "error": {
    "type": "gateway_no_eligible_token",
    "message": "...",
    "upstream_request_id": null
  }
}
```

常见网关错误：

1. `gateway_auth_error`: 缺少或禁用本地客户端身份。
2. `gateway_no_eligible_account`: 指定账号池或默认账号池下没有 enabled Claude.ai account。
3. `gateway_no_eligible_token`: 存在可用账号，但没有满足 scope、未过期、未被 quota rejected 窗口阻塞的 token。
4. `gateway_storage_error`: 本地 SQLite 或 store 操作失败。
5. `gateway_upstream_unreachable`: 本地网关未收到可解析的上游 HTTP 响应。
6. `gateway_stream_parse_error` / `gateway_stream_interrupted`: SSE 读取或下游取消导致 stream 未正常完成。

上游错误：

```json
{
  "error": {
    "type": "overloaded_error",
    "message": "...",
    "upstream_request_id": "..."
  }
}
```

上游错误保留上游 HTTP status；网关错误使用 `gateway_*` type。
