# claude-mgr

## 1. 结论先行

本项目的目标是做一个个人使用的 Claude Code OAuth 网关：复用 Claude Code 登录得到的 Claude.ai 订阅凭证，把我自己的多个客户端接入收敛到一个可审计、可解释、合规合理的本地服务。

`repos/` 目录只作为上游源码和 npm 包行为探索的参考资料。不要在 `repos/` 中实现本项目功能，也不要把设计文档写入参考仓库。

当前项目约定：

1. 当前目录是主 git 仓库，默认分支为 `main`。
2. `repos/claude-code-analysis` 通过 git submodule 维护，只作为参考基线。
3. 服务实现语言选择 TypeScript。
4. 本地状态、认证信息与审计存储优先选择 SQLite；MVP 明文保存 OAuth access / refresh token，不做加密或 keychain 接入。Redis 暂不作为 MVP 依赖，因为当前目标不是多实例服务。
5. 运行时上游调用优先使用轻量 raw fetch 适配层，保证 headers、body、streaming 和错误映射可审计；`@anthropic-ai/sdk` 仅作为 Claude Code 源码行为理解、spike 和兼容验证参考。
6. `repos/` 中暴露的原始代码作为源码级基线；后续可以安装 npm 发布的 Claude Code 包，用混淆后代码补充验证真实发布行为和更新差异。

MVP 目标：

1. 使用 Claude Code OAuth 登录得到的 Claude.ai 订阅凭证。
2. 重点支持 OAuth 认证后的 Messages 交互链路，包括 non-streaming 和 SSE streaming。
3. 支持多个本人 Claude.ai 账号、账号池和 token 管理，方便隔离用量与审计凭证状态。
4. 对下游客户端提供可审计入口；对上游按 Claude.ai 账号暴露为稳定、可解释的客户端身份。
5. 正确区分 Anthropic 上游错误与本地网关错误。

常用验证命令：

```text
npm run typecheck
npm test
npm run probe:claude-code
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
```

`npm run smoke:live` 会启动本地服务、创建 smoke 账号池和本地客户端、生成 Claude Code OAuth URL，并等待浏览器 callback 完成 OAuth/profile 入库。默认不调用 Messages，不消耗推理额度。脚本会断言 token、account、pool membership 已入库；如果传 `--messages`，会用官方 Claude Code CLI 通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_CUSTOM_HEADERS` 端到端访问本地网关，并断言 CLI 返回 `OK`、Messages audit 成功、官方入站 session 已映射到服务端 upstream session。脚本结束前会打印最近 audit event 和 quota snapshot 元数据。需要真实端到端 Messages smoke 时显式传模型：

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model <anthropic-model>
```

需要定位 Claude Code 客户端和网关上游协议差异时，可以打开脱敏 traffic debug：

```text
CLAUDE_MGR_DEBUG_TRAFFIC=1 npm run dev
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model <anthropic-model> --debug-traffic
```

debug 输出默认为 `data/debug/traffic-*.jsonl`。它记录下游 Claude Code 请求和上游 Anthropic 请求/响应的 method、URL、headers，以及 Messages body 的结构摘要；`authorization`、`x-api-key`、cookie 等敏感 headers 会写成 `[redacted]`，prompt、completion、tool result 和文件内容不会写入 debug 文件。

只验证 smoke 脚本和本地服务入口、不等待 OAuth callback 时：

```text
npm run smoke:live -- --dry-run --host localhost
```

非目标：

1. 不实现多租户隔离。
2. 不隐藏、伪造或绕过服务端的账号、组织、订阅、限额、风控语义。
3. 不把多个 Anthropic account / organization 自动混成同一个上游身份。
4. 不复刻 Claude Code 全部 remote、bridge、team memory、Grove、telemetry 能力。
5. 不修改上游请求以破坏 Claude Code 或 Anthropic API 的功能约束。

## 2. 参考源码边界

参考源码位置：

- `docs/module-boundaries.md`
- `docs/message-forwarding-policy.md`
- `docs/hono-http-migration-plan.md`
- `docs/user-stories.md`
- `docs/story-acceptance-audit.md`
- `docs/local-api.md`
- `docs/claude-code-auth-and-identity-source-review.md`
- `repos/claude-code-analysis/src/constants/oauth.ts`
- `repos/claude-code-analysis/src/services/oauth/index.ts`
- `repos/claude-code-analysis/src/services/oauth/client.ts`
- `repos/claude-code-analysis/src/utils/auth.ts`
- `repos/claude-code-analysis/src/services/api/client.ts`
- `repos/claude-code-analysis/src/services/api/claude.ts`
- `repos/claude-code-analysis/src/utils/http.ts`

这些文件用于确认 Claude Code 的 OAuth、token refresh、Anthropic SDK client、headers、metadata、streaming、quota headers、error handling 行为。

实现代码应放在当前项目根目录下的新目录中，例如：

```text
claude-mgr/
  README.md
  package.json
  tsconfig.json
  src/
  tests/
  repos/                 # read-only reference material
```

治理规则：

1. `src/` 运行时代码不能 import `repos/` 下的参考源码。
2. 参考源码中的行为只能通过 spike、文档摘录、测试 fixture 或重新实现后的适配层进入服务。
3. 实现过程中避免自由发挥。OAuth、headers、metadata、endpoint、错误结构、streaming 语义、quota 解析等兼容行为必须先找到 Claude Code 参考源码、npm 包 spike 或线上实测依据，再进入实现。
4. 无依据的字段、header、设备指纹、遥测、请求改写不得进入 MVP；如果确实需要新增本地字段，必须限定在本地审计或路由语义内，不能伪装成上游协议事实。
5. 兼容性修复优先沉淀为可执行规则，例如测试、schema 校验、header forwarding policy、endpoint contract test。
6. 如果 npm 包行为与 `repos/` 源码基线不一致，以当前 npm 包和线上 API 实测作为实现依据，同时记录差异。

## 3. OAuth 与订阅凭证

Claude Code 使用 OAuth 2.0 Authorization Code + PKCE。

参考源码显示的关键语义：

- Claude.ai authorize endpoint：`https://claude.com/cai/oauth/authorize`
- token endpoint：`https://platform.claude.com/v1/oauth/token`
- API base：`https://api.anthropic.com`
- Claude.ai scopes：
  - `user:profile`
  - `user:inference`
  - `user:sessions:claude_code`
  - `user:mcp_servers`
  - `user:file_upload`

MVP 的上游凭证模型：

```text
upstream_credential =
  claude_ai_oauth_token(access, refresh, expires_at, scopes, account, organization)
```

个人订阅额度路径应使用带 `user:inference` scope 的 OAuth bearer token，而不是普通 Anthropic API key。

## 4. 账号与上游客户端身份

这里的“上游客户端身份”不是伪造官方客户端，也不是隐藏真实账号。

定义：

1. 上游账号身份来自 OAuth profile 的 `account_uuid` / `organization_uuid`，不得伪造。
2. 每个 Claude.ai 账号有自己的稳定 upstream client identity，用于保持“一个账号对应一个用户、一个设备、一个稳定客户端身份”的语义。
3. 不同 Claude.ai 账号不能共享同一个 upstream client identity；账号级别隔离。
4. 下游设备身份只进入本地审计日志，不直接伪装成多个上游客户端。
5. 如果需要声明客户端来源，使用明确的 client app 标识，例如 `claude-mgr/<version>`，不要冒充未经修改的官方二进制。

这里的 identity / fingerprint 指本服务内部稳定维护的上游客户端标识和请求元数据，不包含浏览器指纹伪造、设备指纹伪造或规避服务端风控。

这样可以让服务端在每个账号维度看到稳定、可解释的个人客户端，同时本地仍能审计每台设备。

## 5. MVP endpoint 范围

第一阶段聚焦 OAuth 认证后的 Messages 交互。OAuth 登录是前置能力，Messages 代理是核心能力。

需要探索并支持：

- OAuth：
  - `GET /oauth/authorize`
  - `POST /v1/oauth/token`
  - `GET /api/oauth/profile`
- Messages：
  - `POST /v1/messages`
  - Claude Code 源码中的 `beta.messages.create` 参数构造语义
  - non-streaming JSON 响应
  - streaming SSE 响应
  - OAuth bearer、Claude Code 兼容 metadata、必要 headers、request id、quota headers
- Quota / profile side channel：
  - 从响应头读取 `anthropic-ratelimit-unified-*`
  - 上游 profile/bootstrap 调用与推理调用分开记录

暂不作为 MVP：

- Files API
- CCR / remote sessions
- MCP proxy
- voice stream
- team memory
- settings sync
- Grove
- transcript share

这些能力会扩大数据面和合规解释成本，MVP 不应默认开启。

## 6. 建议模块

建议结构：

```text
downstream clients
  -> local auth
  -> claude-mgr gateway
     -> plaintext SQLite credential store
     -> request normalizer
     -> upstream Anthropic client
     -> audit event writer
  -> api.anthropic.com / platform.claude.com
```

模块：

1. `auth`
   - 发起 Claude Code OAuth PKCE 登录。
   - 保存 access / refresh token。
   - 刷新 token，处理 401 后的强制刷新。

2. `credential-store`
   - 支持多个 Claude.ai 账号和多个 token。
   - 每个账号保存 account_uuid、organization_uuid、email、subscription、upstream_client_identity_id。
   - 每个 token 保存 label、source_device、account_uuid、scopes、expires_at、last_used_at。
   - token 必须归属于某个账号；账号可以被加入一个或多个账号池。
   - 下游本地客户端凭证可以绑定默认账号池，以隔离不同客户端或不同用途的用量。

3. `request-adapter`
   - 接收下游请求。
   - 校验为 Anthropic messages 语义。
   - 补齐 Claude Code 兼容 headers、metadata、betas。
   - 不做破坏性改写，例如不移除限额相关头、不伪造账号字段。

4. `upstream-client`
   - 调用 `api.anthropic.com`。
   - 支持 streaming。
   - 保留 `x-client-request-id`。
   - 从响应头提取 quota 状态。

5. `audit-log`
   - 记录本地客户端、所用 token label、上游 request id、模型、token usage、错误分类。
   - 默认不记录 prompt / completion 正文；MVP 可只记录元数据。

6. `error-mapper`
   - 上游 Anthropic 错误保持上游 status、type、message、request id。
   - 网关错误使用独立 namespace，例如 `gateway_auth_error`、`gateway_no_eligible_account`、`gateway_no_eligible_token`、`gateway_upstream_unreachable`、`gateway_stream_parse_error`。

## 6.1 数据库选择

MVP 选择 SQLite。

原因：

1. 本项目是个人客户端网关，不需要 Redis 的多实例协调能力。
2. SQLite 更适合本地凭证元数据、审计事件、request correlation、quota snapshot。
3. MVP 按单人本地服务设计，OAuth token 与认证状态直接明文写入 SQLite，便于审计和调试；不引入加密、keychain 或外部 secret store。
4. 数据文件可以放在 `data/`，并通过 `.gitignore` 排除。
5. 后续如果需要多进程或远程部署，再引入 Redis 作为队列、锁或短期缓存，而不是提前增加基础设施复杂度。

初始表方向：

```text
claude_accounts(account_uuid, organization_uuid, email, upstream_client_identity_id, created_at, updated_at)
account_pools(id, name, purpose, created_at, updated_at)
account_pool_members(pool_id, account_uuid, priority, enabled, created_at)
local_clients(id, name, default_pool_id, created_at, updated_at)
oauth_tokens(label, source_device, account_uuid, scopes, access_token, refresh_token, expires_at, last_used_at)
audit_events(id, client_id, pool_id, account_uuid, token_label, model, upstream_request_id, status, error_type, created_at)
quota_snapshots(id, account_uuid, token_label, status, rate_limit_type, utilization, resets_at, created_at)
```

## 7. 多账号、多 token 与账号池策略

多账号的目的，是在多个本人 Claude.ai 订阅账号之间做显式隔离和调度。账号池的目的，是让某些下游客户端或用途只使用指定账号集合，避免不同用途互相消耗。

约束：

1. 每个 Claude.ai 账号独立保存 `account_uuid`、`organization_uuid` 和 upstream client identity。
2. 不同账号的上游身份、token、quota snapshot、审计记录必须分开。
3. token 必须绑定到某个账号；refresh 时使用 token 自己的 refresh token。
4. 选择 token 前先检查 scope 包含 `user:inference`。
5. token 失效只摘除该 token，不影响同账号或其他账号的其他 token。
6. 所有 token 使用都写本地 audit event。
7. 账号池只能引用已登录账号；下游客户端可以绑定默认账号池。

初始选择策略：

```text
request client
  -> resolve account pool
  -> eligible accounts in pool
  -> eligible tokens for selected account
  -> has user:inference
  -> not expired, or refresh succeeds
  -> account/token policy, initially least recently used
```

不要在 MVP 引入复杂调度、并发额度规避或自动绕限策略。是否符合 Anthropic 当期条款需要单独核对；代码层面只实现显式账号池和审计，不做隐藏身份或绕过服务端限制的行为。

## 8. 错误语义

上游错误原样暴露：

- 401 / 403：认证、scope、org access、token revoked。
- 429：限额或速率限制。
- 529：上游 overloaded。
- 4xx validation：请求 schema、模型、beta、文件限制。
- 5xx：Anthropic 服务端错误。

网关自己的错误必须可区分：

```json
{
  "error": {
    "type": "gateway_no_eligible_token",
    "message": "No Claude Code OAuth token with user:inference is available",
    "upstream_request_id": null
  }
}
```

如果上游已经返回结构化错误，不要包装成“网关失败”。只附加本地 trace id 即可。

## 9. Spike 顺序

实现前先做三个一次性探针：

1. OAuth token 探针
   - 用 Claude Code 当前登录流程获得 token。
   - 验证 `GET /api/oauth/profile` 返回 account/org/subscription。
   - 验证 refresh token 流程。

2. Messages 探针
   - 用 OAuth bearer 调用最小 messages 请求。
   - 记录必要 headers、beta、metadata、SSE stream event 形态。
   - 验证 quota headers 是否能读到。

3. npm 包探针
   - 用当前 `@anthropic-ai/sdk` 复现 Claude Code 的 `beta.messages.create` 调用。
   - 确认 SDK 对 `authToken`、streaming、`withResponse()`、request id 的支持。

4. Claude Code npm 包探针
   - 安装当前发布版本的 Claude Code 包到临时 spike 环境。
   - 对照 `repos/` 原始源码基线，确认混淆后发布包的 endpoint、header、OAuth、SDK 调用形态是否有差异。
   - 把差异固化为兼容性测试或适配层规则，不直接依赖包内私有实现。

探针结束后再进入正式实现，避免把探索代码直接变成产品代码。

## 10. 第一版验收标准

MVP 完成需要满足：

1. 能完成 Claude Code OAuth 登录并持久化至少两个 token。
2. 能列出 token 的 account/org/scope/expiry/last_used 状态。
3. 能代理一次 non-streaming messages 请求。
4. 能代理一次 streaming messages 请求。
5. 401 时能刷新 token 并重试一次。
6. 上游 429/529 能原样暴露，并保留 request id。
7. 网关自身错误使用 `gateway_*` 类型。
8. 本地 audit log 能回答：哪个下游客户端、用了哪个 token、发到哪个模型、上游 request id 是什么、结果状态是什么。
