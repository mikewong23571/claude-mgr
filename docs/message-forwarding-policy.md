# Message Forwarding Policy

本文档记录 `claude-mgr` 在消息处理过程中哪些数据应转发、哪些不应转发，以及哪些字段包含用户信息。策略来自当前已审阅的 Claude Code 参考源码，不作为自由扩展协议。

范围：本文只覆盖 OAuth 认证后的 Messages 交互链路，包括 non-streaming 和 SSE streaming。Files API、remote sessions、voice stream、MCP、team memory 等侧链不属于 MVP 消息协议范围。

## 1. 源码依据

已确认的参考点：

1. `repos/claude-code-analysis/src/services/api/client.ts`
   - 设置 `x-app`、`User-Agent`、`X-Claude-Code-Session-Id`。
   - 为 first-party Anthropic API 注入 `x-client-request-id`。
2. `repos/claude-code-analysis/src/services/api/claude.ts`
   - 构造 `anthropic.beta.messages.create(...)` 参数。
   - 请求 body 包含 `model`、`messages`、`system`、`tools`、`tool_choice`、`betas`、`metadata`、`max_tokens`、`thinking`、`temperature`、`context_management`、`output_config`、`speed`。
   - streaming 请求通过 `.withResponse()` 获取 upstream request id 和 response headers。
3. `repos/claude-code-analysis/src/utils/http.ts`
   - OAuth subscriber 认证使用 `Authorization: Bearer <access_token>`。
   - OAuth 相关请求带 `anthropic-beta: oauth-2025-04-20`。
4. `repos/claude-code-analysis/src/services/api/claude.ts:getAPIMetadata()`
   - `metadata.user_id` 是 JSON 字符串，包含 `device_id`、`account_uuid`、`session_id`。
5. `repos/claude-code-analysis/src/constants/system.ts:getAttributionHeader()`
   - attribution 信息以 `x-anthropic-billing-header: ...` 文本形式放入 system prompt block。
6. `repos/claude-code-analysis/src/utils/fingerprint.ts`
   - attribution fingerprint 来自第一条用户消息的少量字符和版本号 hash。
7. `repos/claude-code-analysis/src/utils/log.ts:captureAPIRequest()`
   - Claude Code 捕获 API 请求时默认移除 `messages`，避免长期保留完整 conversation。

## 2. 总体策略

1. 下游客户端的原始 HTTP headers 不做无差别透传；Claude Code 兼容 headers 使用 prefix-forward + denylist。
2. 上游请求由 `request-adapter` 和 `upstream-client` 按 Claude Code 源码依据重新组装。
3. 下游本地认证信息只用于识别本地客户端，不进入上游请求。
4. 上游认证使用 `account-router` 选中的 Claude.ai OAuth access token。
5. 本地账号池、token label、source device、local client id 只写入本地数据库和审计，不透传给上游。
6. 官方 Claude Code 入站 `X-Claude-Code-Session-Id` 只用于本地 session/account affinity；上游 session id 由服务端映射生成。
7. prompt、completion、tool result、文件内容属于用户内容；为了完成推理请求必须转发给上游，但 MVP 默认不写入 audit log。
8. 任何新增上游 header、metadata、body 字段必须先有参考源码、npm 包 spike 或线上实测依据。

## 3. 下游请求到上游请求

### 3.1 应转发或重建后发送

| 数据 | 发送方式 | 是否包含用户信息 | 说明 |
| --- | --- | --- | --- |
| `messages` | upstream request body | 是 | 核心用户 conversation，可能包含 prompt、tool result、粘贴内容、代码、路径、文件摘要等。必须转发给上游，但默认不写本地 audit log。 |
| `system` | upstream request body | 可能包含 | Claude Code 会注入系统提示、billing attribution block、项目上下文等。若包含本地项目路径或用户配置，则属于用户环境信息。 |
| `tools` | upstream request body | 可能包含 | 工具 schema 通常不是用户身份信息，但 MCP/server/tool 名称可能暴露本地环境或工作流。 |
| `tool_choice` | upstream request body | 否/低 | 通常是请求控制信息，不直接包含用户身份。 |
| `model` | upstream request body | 否 | 请求配置。 |
| `max_tokens` | upstream request body | 否 | 请求配置。 |
| `temperature` | upstream request body | 否 | 请求配置。Claude Code 在 thinking 启用时通常不发送。 |
| `thinking` | upstream request body | 否/低 | 请求配置，可能反映客户端能力或模式。 |
| `betas` | SDK-compatible `anthropic-beta` header | 否/低 | 功能开关；Claude SDK beta Messages 会从 body 参数中移除 `betas` 并转成 `anthropic-beta` header。只发送有源码或 spike 依据的 beta。 |
| `metadata.user_id` | upstream request body | 是，账号/设备级标识 | Claude Code 源码中包含 `device_id`、`account_uuid`、`session_id`。`claude-mgr` 由选中账号和服务端 session 映射生成，不接受下游 body 覆盖。 |
| OAuth `Authorization` | upstream request header | 是，账号凭证 | 使用选中账号的 Claude.ai OAuth access token。只发给 Anthropic 上游，不返回给下游，不写入普通 audit event。 |
| Claude Code `User-Agent` | upstream request header | 否/低 | 复用官方 Claude Code 客户端发送的值；缺失时才使用网关默认值。 |
| `anthropic-*` client headers | upstream request header | 否/低 | 兼容 Claude Code 新增 beta/feature headers。默认透传，denylist 拦截凭证和组织伪装类字段。 |
| `x-stainless-*` client headers | upstream request header | 否/低 | Claude Code SDK runtime 元信息，按客户端请求透传。 |
| `x-app` | upstream request header | 否/低 | Claude Code 源码使用 `cli`。是否发送需由兼容 spike 决定。 |
| `X-Claude-Code-Session-Id` | upstream request header | 是，session 级标识 | 不含明文姓名/email，但可关联同一会话。带入站 session 时使用服务端映射 id；无入站 session 时回退到账号级稳定 identity。 |
| `x-client-request-id` | upstream request header | 否/低 | 随机请求 UUID，用于请求关联和 timeout 排查。可以转发/生成，但不应复用下游传入值。 |
| file/image/document blocks | upstream request body | 是 | 属于用户内容。仅在 Anthropic Messages 语义要求时转发；独立 Files API 不属于 MVP。 |

### 3.2 不应转发

| 数据 | 原因 | 本地处理 |
| --- | --- | --- |
| 下游 `Authorization` / local API token | 这是本地客户端认证，不是 Anthropic 凭证。 | 只给 `local-client-auth` 使用。 |
| 下游任意非 `x-stainless-*` 的 `x-*` headers | 无法证明是 Claude Code 协议，可能泄漏本地客户端信息。 | 默认丢弃；本地 `x-claude-mgr-*` 只用于路由。 |
| 下游 `anthropic-api-key` / `anthropic-auth-token` | 凭证类 header 不能由下游客户端指定给 Anthropic。 | 丢弃；上游认证由网关 OAuth token 生成。 |
| 下游 `anthropic-organization-id` | 可能伪装或混淆上游组织身份。 | 丢弃；组织身份来自 OAuth profile/token 上下文。 |
| 入站 `X-Claude-Code-Session-Id` | 官方客户端会发送，但它是下游会话标识，不应原样成为上游 identity。 | 只作为本地路由 key，并映射成服务端生成的上游 session id。 |
| `client_id`、`local_client_id` | 本地审计身份，不属于 Anthropic API 语义。 | 写 audit log。 |
| `pool_id`、account pool 名称 | 本地路由策略，不属于上游协议。 | 写 audit log。 |
| `token_label`、`source_device` | 本地凭证管理字段，可能泄漏设备命名习惯。 | 写 audit log，不上游。 |
| refresh token | 只用于 token refresh，不参与 inference 请求。 | 明文保存在 SQLite，仅发给 OAuth token endpoint。 |
| SQLite row id、内部 trace id、gateway request id | 本地实现细节。 | 可用于本地日志，不上游。 |
| prompt/completion 正文的 audit 副本 | MVP 目标是元数据审计，不默认留存用户正文。 | 默认不写 audit log；未来如果开启，必须显式配置。 |
| Datadog/GrowthBook/1P analytics event | 不属于 MVP 消息转发链路。 | MVP 不转发；后续如启用必须单独设计和记录依据。 |
| 浏览器 fingerprint、任意设备伪装字段 | 无源码/实测依据时属于自由发挥。 | 禁止进入 MVP。 |

## 4. 上游响应到下游响应

### 4.1 应转发

| 数据 | 是否包含用户信息 | 说明 |
| --- | --- | --- |
| response body / stream events | 是 | 模型输出可能包含用户输入的复述、代码、文件内容、工具结果摘要。必须返回给下游客户端。 |
| upstream HTTP status | 否 | 保持上游错误语义。 |
| upstream error `type` / `message` | 可能包含 | 上游错误 message 可能引用请求细节，应原样返回给调用方，同时写入审计元数据。 |
| upstream request id | 否/低 | 用于排障和本地审计。 |
| `x-client-request-id` | 否/低 | 如果由本服务生成，可返回给下游用于关联。 |

### 4.2 可记录但默认不直接暴露

| 数据 | 是否包含用户信息 | 说明 |
| --- | --- | --- |
| `anthropic-ratelimit-unified-*` headers | 是，账号额度状态 | 与选中 Claude.ai 账号相关。写入 `quota_snapshots`；是否返回给下游应由本地 API 明确设计。 |
| selected account uuid | 是，账号标识 | 写 audit log；默认不放进普通响应 body/header。 |
| token label | 是，本地凭证标识 | 写 audit log；默认不返回。 |
| cost/usage 汇总 | 可能包含 | token usage 本身不含正文，但与请求行为有关。可写审计元数据。 |

### 4.3 不应返回

| 数据 | 原因 |
| --- | --- |
| upstream OAuth access token | 账号凭证，不能暴露给下游客户端。 |
| refresh token | 账号凭证，只能留在 credential-store/token-refresher。 |
| 完整上游请求 headers | 可能包含 Authorization 或账号/session 标识。 |
| 完整上游 request body 的调试副本 | 包含用户正文和文件内容。 |
| 数据库内部字段 | 本地实现细节。 |

## 5. 用户信息分类

### 5.1 直接用户内容

这些字段包含或可能包含用户输入、项目内容、文件内容、工具结果：

1. `messages[*].content`
2. `system` 中的项目上下文、本地配置、附加系统提示
3. `tool_result`
4. file/image/document blocks
5. model response stream/body

处理规则：

1. 为完成推理请求可转发给上游。
2. 默认不写入 `audit_events`。
3. 不进入普通错误日志。
4. 后续若支持正文审计，必须是显式 opt-in。

### 5.2 账号和认证信息

这些字段能直接或间接标识 Claude.ai 账号：

1. OAuth access token
2. OAuth refresh token
3. `account_uuid`
4. `organization_uuid`
5. email、display name、subscription、rate limit tier
6. quota/rate-limit 状态

处理规则：

1. 明文存入 SQLite。
2. access token 只发送给 Anthropic 上游。
3. refresh token 只发送给 OAuth token endpoint。
4. account/profile/quota 信息可写本地审计和 quota snapshot。
5. 默认不返回给下游普通消息响应。

### 5.3 Pseudonymous client/session identifiers

这些字段不一定是明文 PII，但可关联用户、设备或会话：

1. Claude Code `device_id` / `userID`
2. `session_id`
3. `X-Claude-Code-Session-Id`
4. `metadata.user_id`
5. `x-client-request-id`
6. attribution fingerprint

处理规则：

1. 可以按 Claude Code 参考行为发送给上游，但必须由 `request-adapter` 统一生成。
2. 不接受下游客户端直接指定这些上游身份字段。
3. 每个 Claude.ai 账号维护独立稳定身份，避免跨账号混用。
4. attribution fingerprint 来自用户消息内容的派生 hash，属于 user-content-derived metadata；实现前必须再次用 npm 包或实测验证当前行为。

### 5.4 非用户或低敏请求配置

这些字段一般不包含用户身份：

1. `model`
2. `max_tokens`
3. `temperature`
4. `thinking`
5. `tool_choice`
6. `betas`
7. `speed`
8. `context_management`
9. `output_config`

处理规则：

1. 默认可以转发给上游。
2. 可以写入审计元数据。
3. beta 和 extra body 字段必须有来源依据，不能自由添加。
4. `context_management` 当前作为下游兼容输入接受，但基于 Claude Code CLI 集成实测，Claude.ai OAuth Messages 上游会以 `context_management: Extra inputs are not permitted` 拒绝该字段，所以 MVP 会在 adapter 中剥离它，不转发给上游。

### 5.5 本地治理和路由信息

这些字段是 `claude-mgr` 自己的本地语义：

1. local client id
2. local client token
3. account pool id/name
4. token label
5. source device
6. gateway request id
7. audit event id

处理规则：

1. 只用于本地认证、路由和审计。
2. 不进入上游 request body/header。
3. 不进入上游 metadata。

## 6. MVP allowlist

MVP 的 `request-adapter` 对 body 使用 allowlist，对 Claude Code 兼容 headers 使用 prefix-forward + denylist。

允许的下游 Messages body keys。`betas` 会被转换为 `anthropic-beta` header。`context_management` 仅作为 Claude Code 兼容输入接受，当前不进入上游 JSON body：

```text
model
messages
system
tools
tool_choice
betas
metadata
max_tokens
thinking
temperature
context_management
output_config
speed
stream
```

上游 headers 规则：

```text
Authorization
User-Agent
x-app
X-Claude-Code-Session-Id
x-client-request-id
anthropic-*
x-stainless-*
```

下游 `anthropic-*` headers 默认透传以保持 Claude Code 后向兼容性，但以下字段被 denylist 拦截：

```text
anthropic-api-key
anthropic-auth-token
anthropic-organization-id
```

说明：

1. raw fetch 上游 Messages 请求镜像 SDK beta resource：请求 URL 使用 `/v1/messages?beta=true`，缺少 `anthropic-version` 时补 `2023-06-01`，下游 body 中允许的 `betas` 仅在客户端没有发送 `anthropic-beta` header 时转换为 `anthropic-beta` header，不保留在上游 JSON body 中。
2. `User-Agent` 复用 Claude Code 客户端入站值；缺失时才使用网关默认值。
3. `x-client-request-id` 应由本服务生成，不从下游透传。
4. 入站 `X-Claude-Code-Session-Id` 可以影响本地账号粘性，但不原样透传上游。
5. 不允许下游客户端绕过 adapter 直接指定上游 Authorization、metadata 或 identity headers。

## 7. 审计默认记录

`audit_events` 默认记录：

1. local client id
2. account pool id
3. account uuid
4. token label
5. model
6. endpoint
7. upstream request id
8. client request id
9. status
10. error type
11. token usage summary
12. quota snapshot id
13. created_at

默认不记录：

1. prompt 正文
2. completion 正文
3. tool result 正文
4. file/image/document 内容
5. Authorization header
6. refresh token
7. 完整 request body
8. 完整 response body
