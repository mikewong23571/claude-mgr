# Module Boundaries

本文档记录 `claude-mgr` 的模块职责边界。目标是让后续实现保持可审计、可维护、可演进，并避免把 Claude Code 参考源码、账号调度、上游兼容、审计记录混在同一层里。

## 1. 总体原则

1. `repos/` 只作为参考资料，运行时代码不得 import 或依赖 `repos/` 下的源码。
2. 当前服务是单人本地网关，不做多租户隔离。
3. 多个 Claude.ai 账号是账号级隔离，不是把多个账号伪装成同一个上游账号。
4. 每个 Claude.ai 账号维护独立的 upstream identity、OAuth token、quota snapshot 和 audit event。
5. MVP 使用 SQLite 明文保存认证信息，包括 OAuth access token、refresh token、账号元数据和认证状态。
6. MVP 核心是 OAuth 认证后的 Messages 交互链路，包括 non-streaming 和 SSE streaming。
7. 上游 Anthropic 错误与本地网关错误必须可区分。
8. 兼容 Claude Code 的行为应来自参考源码、npm 包 spike 或线上验证，不能靠猜测扩展。
9. 实现过程中避免自由发挥。涉及 OAuth、headers、metadata、endpoint、错误结构、streaming、quota、identity 的行为，必须先有 Claude Code 参考源码、npm 包 spike 或线上实测依据。
10. 本项目可以新增本地审计、路由、账号池字段，但这些字段只能服务本地语义，不得伪装成已验证的上游协议或设备指纹。

## 2. 模块图

```text
downstream client
  -> http-api
  -> local-client-auth
  -> request-adapter
  -> account-router
  -> credential-store
  -> upstream-client
  -> error-mapper
  -> audit-log
```

辅助模块：

```text
oauth-login
quota-tracker
compat-probes
governance
```

## 3. http-api

HTTP 路由层当前使用 Hono route modules；迁移记录见 `docs/hono-http-migration-plan.md`。

职责：

1. 暴露本地 HTTP API 给下游客户端。
2. 解析请求路径、方法、headers、body 和 streaming 参数。
3. 调用 `local-client-auth` 验证本地客户端身份。
4. 把通过验证的请求交给 `request-adapter`。
5. 对 streaming 响应保持传输语义，不在 HTTP 层吞掉上游事件。

不负责：

1. 不直接读取或刷新 OAuth token。
2. 不决定使用哪个 Claude.ai 账号。
3. 不拼接 Anthropic 上游 headers。
4. 不把上游错误改写成本地错误。

主要依赖：

1. `local-client-auth`
2. `request-adapter`
3. `error-mapper`
4. `audit-log`

## 4. local-client-auth

职责：

1. 管理本地客户端凭证。
2. 把下游客户端映射到 `local_clients` 记录。
3. 解析客户端默认账号池。
4. 为审计提供 stable local client id。

不负责：

1. 不验证 Claude.ai OAuth token。
2. 不决定账号池内的具体账号或 token。
3. 不向上游暴露本地设备身份。

数据表：

1. `local_clients`
2. 未来可扩展 `local_client_tokens`

## 5. oauth-login

职责：

1. 发起 Claude Code OAuth PKCE 登录。
2. 处理 authorization code callback。
3. 调用 token endpoint 完成 code exchange。
4. 调用 profile endpoint 解析 `account_uuid`、`organization_uuid`、email、订阅相关信息。
5. 把账号和 token 写入 `credential-store`。

不负责：

1. 不处理推理请求。
2. 不做账号池调度。
3. 不记录 prompt 或 completion 正文。
4. 不复制 Claude Code 的 keychain 或 `.credentials.json` 存储模型。

输入：

1. OAuth callback code/state。
2. 登录 label、source device、可选目标账号池。

输出：

1. `claude_accounts` 记录。
2. `oauth_tokens` 记录。
3. 可选 `account_pool_members` 记录。

## 6. credential-store

职责：

1. 封装 SQLite 读写。
2. 明文保存 OAuth access token 和 refresh token。
3. 保存 Claude.ai account、account pool、pool member、local client、message session binding、quota snapshot、audit event。
4. 提供事务边界，例如 token refresh 更新和 audit event 写入。
5. 保持 schema 与测试同步。

不负责：

1. 不发起 OAuth 登录。
2. 不调用 Anthropic API。
3. 不决定请求该走哪个模型或 endpoint。
4. 不实现加密、keychain 或外部 secret store。

核心表：

```text
claude_accounts
account_pools
account_pool_members
local_clients
oauth_tokens
audit_events
quota_snapshots
message_session_bindings
```

边界规则：

1. 其他模块只能通过 store API 访问数据库，不直接拼 SQL。
2. token 必须绑定到 `account_uuid`。
3. account pool 只能引用已存在账号。
4. 删除账号必须显式处理 token、pool membership、quota snapshot 和 audit 关联策略。

## 7. account-router

职责：

1. 根据本地客户端、请求目的和账号池选择 Claude.ai 账号。
2. 过滤不满足 scope 的 token，例如缺少 `user:inference`。
3. 判断 token 是否过期，并触发 `token-refresher`。
4. 按策略选择 token，MVP 初始策略为 least recently used 或显式优先级。
5. 保证同一 Claude.ai 账号的 upstream identity 稳定。
6. 用入站 Claude Code session id 维护本地 session/account affinity，并生成服务端控制的上游 session id。

不负责：

1. 不修改 Anthropic request body。
2. 不伪造账号、组织、浏览器或设备指纹。
3. 不把多个 Claude.ai 账号合并为同一个上游账号身份。
4. 不实现并发绕限或隐藏限额行为。

输入：

1. local client id。
2. endpoint capability，例如 inference、profile、files。
3. 可选显式 pool id 或 account hint。
4. 可选入站 Claude Code session id。

输出：

1. selected account。
2. selected oauth token。
3. upstream client identity metadata。
4. 可选 upstream session identity。

## 8. token-refresher

职责：

1. 使用 refresh token 刷新 OAuth access token。
2. 按 `account_uuid` 或 token label 做 refresh lock，避免同一 token 并发刷新。
3. 更新明文 token、过期时间、scope 和 refresh 状态。
4. 向调用方返回 refresh 成功结果或抛出 refresh 失败错误，供具备请求上下文的 gateway 写入审计事件。

不负责：

1. 不发起完整 OAuth 登录。
2. 不选择账号池。
3. 不吞掉上游 token endpoint 错误。
4. 不直接写请求级 audit event；MessagesGateway 负责把 refresh 成功或失败与 local client、pool、account、token 关联后落库。

错误边界：

1. token endpoint 返回的 OAuth 错误属于上游错误。
2. 本地没有 refresh token、数据库写入失败、锁超时属于网关错误。

## 9. request-adapter

职责：

1. 理解 Anthropic Messages API 语义。
2. 校验下游请求是否在 MVP 支持范围内。
3. 生成上游请求所需 headers、metadata、beta flags 和 client request id。
4. 保留 streaming 与 non-streaming 差异。
5. 把适配后的请求交给 `upstream-client`。

不负责：

1. 不读取数据库。
2. 不选择账号或 token。
3. 不记录审计事件。
4. 不注入与 Claude Code 参考行为无关的遥测。

兼容边界：

1. Claude Code 兼容 headers 必须有来源依据。
2. 不伪造无法从源码或 npm 包验证的浏览器/device fingerprint。
3. 不删除上游限额相关 headers。
4. 不把网关内部字段透传给 Anthropic。

## 10. upstream-client

职责：

1. 调用 `api.anthropic.com` 和 `platform.claude.com`。
2. 支持 Messages streaming / non-streaming，以及已确认的 Claude Code service GET endpoint。
3. 设置 Authorization bearer token。
4. 保留 upstream request id、client request id 和 response headers。
5. 把 quota/rate-limit headers 交给 `quota-tracker`。

不负责：

1. 不决定使用哪个 token。
2. 不把错误映射为最终 HTTP 响应。
3. 不写本地审计日志。
4. 不在 SDK 层实现账号池策略。

输出：

1. upstream response stream 或 JSON response。
2. normalized upstream error。
3. response metadata。

## 11. error-mapper

职责：

1. 区分 Anthropic 上游错误、OAuth 上游错误和 claude-mgr 网关错误。
2. 上游错误保留 status、type、message、request id。
3. 网关错误使用 `gateway_*` type。
4. 为 HTTP API 生成稳定错误响应。

不负责：

1. 不重试请求。
2. 不刷新 token。
3. 不记录业务审计，只返回可供 `audit-log` 使用的分类信息。

错误分类示例：

```text
gateway_auth_error
gateway_no_eligible_token
gateway_no_eligible_account
gateway_upstream_unreachable
gateway_stream_parse_error
gateway_storage_error
```

## 12. audit-log

职责：

1. 记录请求级审计元数据。
2. 记录 local client、account pool、account、token label、model、endpoint、status、error type。
3. 记录 upstream request id 和 client request id。
4. 记录 token refresh、quota snapshot、账号选择结果。
5. MVP 默认不记录 prompt / completion 正文。

不负责：

1. 不参与账号选择。
2. 不修改请求或响应。
3. 不实现上游遥测。

写入时机：

1. 请求开始时可写 pending event。
2. 上游响应完成后更新 final status。
3. streaming 中断时写 interrupted/error status。
4. token refresh 单独写 refresh event。

## 13. quota-tracker

职责：

1. 解析 `anthropic-ratelimit-unified-*` 等 quota/rate-limit headers。
2. 按 account 和 token 写入 `quota_snapshots`。
3. 为 `account-router` 提供最近 quota 状态。

不负责：

1. 不决定是否绕过上游限额。
2. 不合并不同 Claude.ai 账号的 quota。
3. 不把 `/api/oauth/usage` 的响应写成 quota snapshot；该接口作为 profile-scoped service endpoint 透传并记录审计，Messages rate-limit headers 仍是路由用 quota snapshot 的来源。

## 14. compat-probes

职责：

1. 存放一次性或可重复的 spike 脚本。
2. 验证 npm 发布包与 `repos/` 源码基线是否一致。
3. 记录 endpoint、header、scope、binary string markers、版本差异。

不负责：

1. 不作为运行时依赖。
2. 不读取生产数据库。
3. 不自动修改实现代码。

产物：

1. 文档记录。
2. fixture。
3. contract test 输入。

## 15. governance

职责：

1. 通过测试或规则阻止运行时代码 import `repos/`。
2. 约束 schema 中的关键字段，例如明文 OAuth token 字段。
3. 约束上游错误和网关错误的分类。
4. 后续可加入 endpoint contract test 和 header forwarding policy。

不负责：

1. 不替代代码 review。
2. 不为未稳定的探索行为提前引入复杂 lint 工具。
3. 不把个人偏好写成高误报规则。

## 16. 推荐目录映射

```text
src/
  http/
  auth/
  credentials/
  routing/
  requests/
  upstream/
  errors/
  audit/
  quota/
  storage/
  governance/
tests/
  *.test.ts
docs/
  module-boundaries.md
  claude-code-auth-and-identity-source-review.md
```

目录命名可以随实现调整，但依赖方向应保持稳定：

```text
http -> auth/request-adapter/error-mapper/audit-log
request-adapter -> upstream-client
account-router -> credential-store/token-refresher/quota-tracker
token-refresher -> credential-store/upstream-client
upstream-client -> no project module except shared types/config
audit-log -> credential-store
```

## 17. MVP 实现顺序

1. `credential-store`：落 SQLite 初始化、明文 token schema、基础 CRUD。
2. `oauth-login`：完成 PKCE、token exchange、profile 入库。
3. `account-router`：支持账号池、scope 过滤、token refresh 前置判断。
4. `upstream-client`：支持 Messages streaming/non-streaming 的最小链路。
5. `request-adapter`：补齐 Claude Code 兼容 headers 与 request metadata。
6. `error-mapper`：稳定区分 gateway 与 upstream errors。
7. `audit-log` 和 `quota-tracker`：把请求、错误和 quota 元数据落库。
8. `compat-probes` 和 `governance`：把已经发现的兼容边界变成测试或文档。

## 18. 明确暂不做

1. 不做多租户权限系统。
2. 不做 Redis、多实例调度或分布式锁。
3. 不做加密存储、keychain 集成或 secret manager。
4. 不做浏览器指纹伪造。
5. 不做并发绕限、隐藏限额或自动规避服务端策略。
6. Files、event logging、trusted devices 只做同域透明代理，不在中间层解析或校验业务内容；Claude Code remote sessions、voice stream、team memory、Grove、settings sync、transcript share 仍不默认支持。
