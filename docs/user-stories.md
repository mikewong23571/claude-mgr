# User Stories

本文档是 `claude-mgr` 的用户故事基线。它只描述当前个人本地 Claude Code OAuth 网关的 MVP 范围，后续实现、测试和兼容治理都应围绕这些 story 收敛。

每个 story 的当前实现证据记录在 `docs/story-acceptance-audit.md`。当实现、测试、live smoke 或协议依据变化时，应同步更新该验收审计。

## 1. 一句话目标

作为服务拥有者，我要在本地运行一个可审计的 TypeScript 网关，用 Claude Code OAuth 登录自己的 Claude.ai 账号，把多个本地客户端的 Messages 请求通过账号池路由到自己的 Claude.ai 订阅账号，同时保持账号级上游身份稳定、错误语义清楚、默认不保存正文内容。

## 2. 不变边界

必须遵守：

1. `repos/` 只作为参考源码和 submodule 基线，不在其中实现本项目功能。
2. OAuth、endpoint、headers、metadata、streaming、quota、identity 行为必须来自 Claude Code 源码、npm 包 probe 或线上实测，不能自由发挥。
3. MVP 使用 SQLite 明文保存 OAuth access token、refresh token、账号信息、账号池、审计和 quota snapshot。
4. 本项目不是多租户系统，不做不同真实用户之间的数据隔离。
5. 多个 Claude.ai 账号是账号级隔离，不能把多个账号伪装成同一个上游账号。
6. 本地客户端身份只用于本地路由和审计，不直接透传给上游。
7. 默认不保存 prompt、completion、tool result、文件正文。

当前不做：

1. Claude Code remote sessions / CCR。
2. MCP proxy。
3. voice stream。
4. team memory、settings sync、Grove、transcript share。
5. WebSocket 推理代理。
6. GrowthBook / Datadog 复制。
7. token 加密、keychain、secret manager。

## 3. 角色

| 角色 | 定义 | 核心诉求 |
| --- | --- | --- |
| 服务拥有者 | 同一个真实用户，也是 Claude.ai 账号拥有者 | 登录账号、配置账号池、审计本地客户端调用 |
| 本地客户端 | 服务拥有者自己的设备、脚本、编辑器插件或工具 | 通过本地网关调用 Messages，不直接持有 Claude.ai token |
| Claude.ai 账号 | 一个真实订阅账号 | 独立 token、quota、audit、upstream identity |
| 上游服务 | Anthropic / Claude.ai | 接收 OAuth bearer token 和 Claude Code 兼容 Messages 请求 |

## 4. Story Map

```text
项目基线
  -> 源码调研和 npm probe
  -> OAuth 登录
  -> token exchange
  -> profile 入库
  -> 多账号入库
  -> 账号池维护
  -> 本地客户端绑定
  -> Messages JSON 代理
  -> Messages SSE 代理
  -> Claude Code usage/bootstrap 查询
  -> token refresh / 401 retry
  -> audit / quota
  -> 错误区分
  -> live smoke 验证
```

### 4.1 核心用户旅程

MVP 的用户故事按以下四条真实使用路径组织。实现和验收时应优先保证这些路径完整，而不是孤立完成单个接口。

| Journey | 触发者 | 目标 | 经过的 story | 完成信号 |
| --- | --- | --- | --- | --- |
| J1. 初始化和治理 | 服务拥有者 / 维护者 | 当前目录成为可维护主项目，参考源码只作为基线 | A1、A2、A3、G1、G2、G3 | `src/` 不依赖 `repos/`，关键协议行为有依据，probe 和测试可重复执行 |
| J2. 接入 Claude.ai 账号 | 服务拥有者 | 通过 Claude Code OAuth 登录一个或多个本人账号并明文入库 | B1、B2、B3、C1、H1 | SQLite 中出现 account、token、scope、profile，账号可独立启停 |
| J3. 组织账号池和本地客户端 | 服务拥有者 | 把账号组装成池，并让不同本地客户端使用指定池 | C2、C3、F1、F2 | 本地请求能定位 client/pool/account/token，审计能回答用量来源 |
| J4. 代理 Messages 请求 | 本地客户端 | 通过本地服务完成 JSON / SSE Messages 调用 | D1、D2、D3、D4、E1、E2、H2、H3 | 成功响应透传，stream 不缓冲，上游错误和网关错误可区分 |
| J5. 查询 Claude Code 服务元数据 | 本地客户端 | 通过本地服务访问 usage/bootstrap 等 profile-scoped GET 接口 | D5、E1、E2、F1 | 选中 profile-scoped token，响应透传，本地元数据审计完整 |

### 4.2 依赖关系

```text
A1 -> A2 -> A3
A3 -> G1 -> G2 -> G3
G1 -> B1 -> B2 -> B3 -> C1
C1 -> C2 -> C3
C3 -> D1 -> D2
B2 -> D3
B3 -> D4
D1/D2/D3/D4 -> E1/E2 -> F1/F2
B3/C3 -> D5 -> E1/E2 -> F1
B1/B2/B3 -> H1
D1 -> H2
D2 -> H3
```

实现顺序约束：

1. 没有 G1/G2 的来源依据，不新增 OAuth、header、metadata、endpoint、streaming、quota 字段。
2. 没有 B3 的 account/profile 入库，不允许把 token 标记为可用于 Messages。
3. 没有 C2/C3 的池和本地客户端映射，不允许绕过 account-router 直接拿 token 调上游。
4. 没有 H1-H3 的真实 smoke，只能标记为“本地完成，待 live smoke”，不能把 MVP 宣称为完成。

## 5. Story 状态约定

| 状态 | 含义 |
| --- | --- |
| 已完成 | 代码、文档和本地测试已覆盖，当前没有已知本地缺口 |
| 本地完成，待 live smoke | 本地实现和测试已完成，但仍需真实 Claude.ai 登录或真实 Messages 请求验证 |
| 持续治理 | 基线已建立，后续新增兼容行为仍必须继续执行 |
| 非 MVP | 明确暂不实现 |

## 6. MVP 用户故事矩阵

| ID | 用户故事 | 优先级 | 状态 | 主要验收点 |
| --- | --- | --- | --- | --- |
| A1 | 初始化当前目录为主项目 | P0 | 已完成 | git、TS、`.gitignore`、`repos/` 不承载实现 |
| A2 | 用 submodule 管理参考源码 | P0 | 已完成 | `.gitmodules`、`repos/claude-code-analysis`、运行时代码不 import `repos/` |
| A3 | 建立 source-driven 兼容治理 | P0 | 持续治理 | 上游字段必须有源码、npm probe 或 live evidence |
| B1 | 发起 Claude Code OAuth 登录 | P0 | 已完成 | authorize URL、client id、scope、PKCE、state |
| B2 | OAuth callback 换 token 并明文入库 | P0 | 已完成 | state 校验、token endpoint、access/refresh token、expires_at |
| B3 | 获取 profile 并建立账号记录 | P0 | 已完成 | account uuid、organization uuid、email、失败不误入库 |
| C1 | 添加多个本人 Claude.ai 账号 | P0 | 已完成 | 多账号、多 token、多 quota、多 audit、账号可禁用 |
| C2 | 创建和维护账号池 | P0 | 已完成 | pool CRUD、member priority/enabled、只本地使用 |
| C3 | 绑定本地客户端到默认账号池 | P0 | 已完成 | local client CRUD、默认 pool、本地审计、不透传上游 |
| D1 | 代理 non-streaming Messages | P0 | 已完成 | body allowlist、OAuth bearer、SDK-compatible beta endpoint/header、JSON 响应、audit |
| D2 | 代理 SSE streaming Messages | P0 | 已完成 | `stream: true`、SSE 透传、不中途缓冲、stream 错误审计 |
| D3 | token 过期 refresh 和上游 401 retry | P0 | 已完成 | expiry 检查、refresh lock、401 强制 refresh 一次 |
| D4 | 保持账号级上游 identity 稳定 | P0 | 已完成 | 每账号独立 identity、拒绝下游 spoof metadata/header |
| D5 | 代理 Claude Code usage/bootstrap | P1 | 已完成 | profile scope token、OAuth beta header、上游 JSON 透传、metadata-only audit |
| D6 | 透明代理同域 Files/event/trusted-device 接口 | P1 | 已完成 | 不解析业务 body、本地头剥离、OAuth 注入、响应透明返回 |
| E1 | 原样暴露上游 Anthropic 错误 | P0 | 已完成 | status/type/message/request id 保留，不包装 429/529 |
| E2 | 暴露网关自己的错误 | P0 | 已完成 | `gateway_*` namespace，区分 no account / no token / auth / storage / stream |
| F1 | 记录请求元数据审计 | P0 | 已完成 | client、pool、account、token、model、request id、status、error |
| F2 | 记录 quota snapshot 并用于保守路由 | P1 | 已完成 | 解析 rate-limit headers，绑定账号，不跨账号合并 |
| G1 | 用参考源码确定协议基线 | P0 | 已完成 | OAuth、Messages、SSE/WebSocket 边界写入文档 |
| G2 | 用 npm 包补充验证发布行为 | P0 | 持续治理 | `npm run probe:claude-code` 可重复验证关键 marker |
| G3 | 轻量 7 层代理优先 | P0 | 已完成 | 运行时 raw fetch，上游构造可审计，不依赖 SDK 黑盒 |
| H1 | 真实 OAuth/profile live smoke | P0 | 已完成 | 用真实 Claude.ai 账号完成 callback、profile 入库 |
| H2 | 真实 Messages JSON live smoke | P0 | 已完成 | 指定模型发起真实 non-streaming 请求并记录 audit/quota |
| H3 | 真实 Messages SSE live smoke | P0 | 已完成 | 指定模型发起真实 streaming 请求并记录 audit/quota |

### 6.1 Story 到模块的职责映射

| Story 范围 | 主要模块 | 不属于该模块的事 |
| --- | --- | --- |
| A/G 项目基线和兼容治理 | `docs/`、`tests/governance.test.ts`、`scripts/probe-claude-code-package.mjs` | 不在运行时 import `repos/`，不把 npm 包私有实现作为黑盒依赖 |
| B OAuth 登录和 token/profile 入库 | `src/oauth/*`、`src/storage/*`、`src/http/app.ts` | 不处理 Messages 推理，不做账号池调度 |
| C 多账号、账号池、本地客户端 | `src/storage/*`、`src/routing/account-router.ts` | 不拼接上游 headers，不伪造上游 identity |
| D Messages 代理、service GET 和 token refresh | `src/messages/*`、`src/claude-cli/*`、`src/upstream/*`、`src/oauth/token-refresher.ts` | 不保存 prompt/completion/file 正文，不接受下游身份字段直通上游 |
| E 错误语义 | `src/errors.ts`、`src/http/app.ts`、`src/messages/gateway.ts` | 不把上游 429/529 包装成 `gateway_*` |
| F 审计和 quota | `src/audit/usage.ts`、`src/quota/headers.ts`、`src/storage/*` | 不返回 token，不默认暴露账号 quota 给普通 Messages 响应 |
| H live smoke | `scripts/live-smoke.ts`、真实 Claude.ai 账号 | 不在没有显式模型和用户触发时消耗推理额度 |

## 7. 详细用户故事

### A1. 初始化当前目录为主项目

作为服务拥有者，我要把当前目录初始化为独立 git 仓库，这样服务实现、文档和治理规则都在主项目中演进。

验收标准：

1. 当前目录是 git 仓库。
2. TypeScript 项目配置存在。
3. `.gitignore` 排除 `node_modules/`、构建产物、本地 SQLite 数据库等本地状态。
4. `repos/` 只保存参考源码，不在其中实现本项目功能。

状态：已完成。

### A2. 用 submodule 管理参考源码

作为维护者，我要把 `repos` 中的参考代码通过 git submodule 维护，这样可以追踪上游基线而不污染服务实现。

验收标准：

1. `.gitmodules` 存在。
2. `repos/claude-code-analysis` 是 submodule。
3. 运行时代码不得 import `repos/`。
4. 治理测试能阻止 `src/` 依赖参考仓库。

状态：已完成。

### A3. 建立 source-driven 兼容治理

作为维护者，我要要求 OAuth、endpoint、headers、metadata、streaming、quota、错误结构都有依据，这样实现不会靠猜协议。

验收标准：

1. 文档记录参考源码、npm 包 probe 或线上实测作为依据来源。
2. Messages body allowlist 和 header forwarding denylist 存在。
3. 新增上游字段必须先补依据。
4. 本地审计字段不得进入上游协议。

状态：持续治理。当前已有文档、body allowlist、header denylist 和基础治理测试；后续每次新增上游兼容字段仍需补证据。

### B1. 发起 Claude Code OAuth 登录

作为服务拥有者，我想从 `claude-mgr` 发起 Claude Code OAuth 登录，这样我可以把自己的 Claude.ai 账号接入本地服务。

验收标准：

1. 服务能生成 OAuth authorize URL。
2. authorize URL 使用 Claude Code 源码确认的 authorize endpoint、client id、scope 和 PKCE 参数。
3. 登录 state 与 PKCE verifier 存在本地临时状态中。
4. 不要求手工复制 Claude Code 配置文件。
5. OAuth 行为能追溯到参考源码、npm 包 probe 或线上实测。

状态：已完成。2026-06-22 live smoke 已完成 OAuth authorize URL 生成和真实浏览器授权。

### B2. OAuth callback 换 token 并明文入库

作为服务拥有者，我想在浏览器登录完成后让服务接收 callback code，这样服务可以换取 access token 和 refresh token。

验收标准：

1. 服务校验 callback state。
2. 服务向 token endpoint 发送 authorization code、redirect URI、client id、code verifier。
3. token endpoint 错误作为上游 OAuth 错误暴露。
4. access token 和 refresh token 明文写入 SQLite。
5. token 记录包含 label、source device、account uuid、scope、expires_at、created_at、updated_at。

状态：已完成。2026-06-22 live smoke 已完成真实 callback、token exchange 和明文 token 入库。

### B3. 获取 profile 并建立账号记录

作为服务拥有者，我想让服务用 OAuth access token 获取 Claude.ai profile，这样本地数据库能知道 token 属于哪个账号和组织。

验收标准：

1. 服务调用 profile endpoint。
2. 服务保存 `account_uuid`、`organization_uuid`、email、display name、subscription / rate-limit 相关字段。
3. 同一账号多次登录时更新账号记录，不创建重复账号。
4. 不同账号必须有不同 upstream identity。
5. profile 调用失败时 token 不应被误标记为可用于 Messages。

状态：已完成。2026-06-22 live smoke 已完成真实 profile 入库，账号、组织、email、订阅类型和 rate limit tier 已写入 SQLite；profile 失败不写入 account/token 的行为已有本地测试覆盖。

### C1. 添加多个本人 Claude.ai 账号

作为服务拥有者，我想添加多个 Claude.ai 账号，这样我可以按账号级别隔离订阅用量。

验收标准：

1. 数据库支持多个 `claude_accounts`。
2. 每个账号有独立 OAuth token、quota snapshot、audit event。
3. 不同账号不共享 upstream identity。
4. 删除或禁用一个账号不影响其他账号。
5. 所有账号凭证明文存储在 SQLite。

状态：已完成。数据模型、账号禁用和路由过滤已实现；2026-06-22 live smoke 已验证真实账号/token/quota/audit 关联。多账号线性扩展仍按同一登录流程重复添加。

### C2. 创建和维护账号池

作为服务拥有者，我想创建账号池，这样不同客户端或用途可以只使用指定账号集合。

验收标准：

1. 服务支持创建、列出、更新、删除账号池。
2. 账号池只能引用已存在账号。
3. pool member 支持 `enabled` 和 `priority`。
4. 禁用 pool member 后不会被 account-router 选中。
5. 账号池信息只用于本地路由和审计，不透传给上游。

状态：已完成。

### C3. 绑定本地客户端到默认账号池

作为服务拥有者，我想给每个本地客户端配置默认账号池，这样我可以隔离不同设备或工具的用量。

验收标准：

1. 服务支持创建本地客户端记录。
2. 本地客户端可以绑定默认 pool id。
3. 下游请求能映射到 stable local client id。
4. local client id 写入 audit event。
5. local client id 不进入上游 request body、headers 或 metadata。

状态：已完成。禁用客户端调用 Messages 时返回 `gateway_auth_error`。

### D1. 代理 non-streaming Messages 请求

作为本地客户端，我想通过 `claude-mgr` 发送 non-streaming Messages 请求，这样我可以复用 Claude.ai OAuth 订阅凭证。

验收标准：

1. 下游请求使用 Anthropic Messages 语义。
2. 服务校验请求 body 在 MVP allowlist 内。
3. 服务通过 account-router 选择有 `user:inference` scope 的 token。
4. 服务构造上游 `POST /v1/messages?beta=true` 请求，带 `anthropic-version: 2023-06-01`。
5. 服务发送 OAuth `Authorization: Bearer <access_token>`。
6. 服务补齐有依据的 metadata、headers、request id，并按 SDK 行为把 `betas` 转为 `anthropic-beta` header。
7. 上游成功响应原样返回给下游。
8. audit event 记录 local client、pool、account、token label、model、request id、status。
9. audit event 默认不记录 prompt 或 completion 正文。

状态：已完成。2026-06-22 live smoke 使用 `claude-haiku-4-5-20251001` 完成真实 non-streaming Messages 请求，返回 200 并写入 success audit/quota。

### D2. 代理 SSE streaming Messages 请求

作为本地客户端，我想通过 `claude-mgr` 使用 SSE streaming，这样我可以获得与 Claude Code 消息流相近的交互体验。

验收标准：

1. 下游请求可以指定 `stream: true`。
2. 上游使用 HTTP streaming / SSE，不使用 WebSocket。
3. 服务不缓冲完整响应后再返回。
4. 服务保留 upstream stream event 顺序。
5. stream 中断时写入 audit error status。
6. upstream request id 和 client request id 可用于本地关联。
7. 网关 stream parse / pipe 错误使用 `gateway_stream_parse_error` 或同类 `gateway_*` 类型。

状态：已完成。2026-06-22 live smoke 使用 `claude-haiku-4-5-20251001` 完成真实 SSE Messages 请求，返回 200、收到 stream chunks 并写入 success audit/quota；本地已覆盖读取失败和 interrupted audit。

### D3. token 过期 refresh 和上游 401 retry

作为本地客户端，我希望 access token 过期时服务能自动刷新并重试一次，这样正常请求不会因为本地 token 过期直接失败。

验收标准：

1. 请求前检查 token expiry。
2. token-refresher 使用 refresh token 调用 token endpoint。
3. 同一 token 的 refresh 有锁，避免并发刷新冲突。
4. 上游 401 可触发一次强制 refresh retry。
5. refresh 成功后更新明文 access token、refresh token、expires_at、updated_at。
6. refresh 失败时返回明确上游 OAuth 错误或 `gateway_*` 错误。

状态：已完成。refresh 成功/失败都会写入 `/v1/oauth/token` 元数据审计；live smoke 已验证真实 OAuth token 可用于推理链路。

### D4. 保持账号级上游 identity 稳定

作为服务拥有者，我希望同一个 Claude.ai 账号对上游表现为稳定的一个账号级客户端身份，这样服务端不会看到同一账号被多个本地设备任意分裂。

验收标准：

1. 每个 account 有独立 upstream identity。
2. request-adapter 生成的 `metadata.user_id`、device 相关字段来自选中账号的 identity 状态。
3. 带入站 Claude Code session id 时，服务端把它映射为账号内稳定 upstream session id，并用于 `metadata.user_id.session_id` 和 `X-Claude-Code-Session-Id`。
4. 不接受下游客户端直接指定上游 `metadata.user_id`、`X-Claude-Code-Session-Id` 或类似身份字段。
5. 不同账号不能共享 upstream identity。
6. 本地设备身份只写入本地 audit，不透传给上游。

状态：已完成。npm 包 probe 已确认关键 identity / attribution marker 仍存在；2026-06-22 live smoke 已验证账号级 identity 生成的请求可被真实上游接受。

### D5. 代理 Claude Code usage/bootstrap

作为本地客户端，我想让 Claude Code 通过本地网关访问 usage 和 bootstrap 这类 profile-scoped service endpoint，这样客户端仍能获得账号用量和模型选项等元数据，而不直接持有 Claude.ai token。

验收标准：

1. 服务支持 `GET /api/oauth/usage` 和 `GET /api/claude_cli/bootstrap`。
2. 这两个接口使用本地 `x-claude-mgr-client-id` 和可选 `x-claude-mgr-pool-id` 做路由。
3. 服务只选择具备 `user:profile` scope 且未过期的 token。
4. 上游请求带 OAuth bearer 和 `anthropic-beta: oauth-2025-04-20`。
5. 本地 client id、pool id、token label 和 source device 不透传给上游。
6. 上游 JSON body 原样返回；上游错误保留 status、type、message 和 request id。
7. audit event 只记录 endpoint、client、pool、account、token、request id 和状态，不记录正文内容。

状态：已完成。本地测试覆盖 usage 成功、bootstrap 上游错误、缺少 profile scope 的 token 过滤和 metadata-only audit。

### D6. 透明代理同域 Files/event/trusted-device 接口

作为本地客户端，我希望 Claude Code 访问同域 Files、event logging 和 trusted-device endpoint 时仍能经过本地网关，这样 `ANTHROPIC_BASE_URL` 指向本地服务后不会缺失这些 Claude Code 已知接口。

验收标准：

1. 服务支持 `GET /v1/files`、`POST /v1/files`、`GET /v1/files/{file_id}/content`、`POST /api/event_logging/batch`、`POST /api/auth/trusted_devices`。
2. 中间层不解析业务 body，不做文件大小、payload schema 或 trusted-device 字段校验。
3. 本地路由 headers 和下游认证 headers 不透传上游。
4. Files 请求补齐 Claude Code 参考源码确认的 files beta 和 Anthropic version header。
5. 需要账号的接口由本地 client/pool 选择任意未过期 token，不做额外 scope 判断；上游负责最终授权。
6. event logging 允许无本地 client header 的透明转发。
7. 上游 status、headers 和 body 透明返回，audit 只记录元数据。

状态：已完成。本地测试覆盖 Files download/upload、event logging 无 auth 转发、trusted-device enrollment 转发，以及认证头替换和本地头剥离。

### E1. 原样暴露上游 Anthropic 错误

作为本地客户端，我想看到真实的 Anthropic 错误类型和状态，这样我能区分限额、鉴权、validation 和服务端错误。

验收标准：

1. 上游返回 4xx / 5xx 时保留 status。
2. 上游结构化 error 的 `type` 和 `message` 尽量原样返回。
3. upstream request id 保留在响应或审计事件中。
4. 不把上游 429 / 529 包装成 `gateway_*`。
5. 错误 body 可能包含请求细节，写日志时只记录元数据。

状态：已完成。2026-06-22 live smoke 中 `claude-sonnet-4-6` 返回真实上游 429 `rate_limit_error`，本地按上游 status/type/request id 写入 audit。

### E2. 暴露网关自己的错误

作为本地客户端，我想区分本地网关错误，这样我能知道问题发生在账号池、凭证、数据库、网络还是 stream 管道。

验收标准：

1. 网关错误使用 `gateway_*` namespace。
2. 没有可用账号返回 `gateway_no_eligible_account`。
3. 账号存在但没有可用 token 返回 `gateway_no_eligible_token`。
4. 本地客户端鉴权失败返回 `gateway_auth_error`。
5. 数据库错误返回 `gateway_storage_error`。
6. 上游不可达返回 `gateway_upstream_unreachable`。
7. stream 管道错误返回 `gateway_stream_parse_error` 或同类明确错误。

状态：已完成。本地测试已覆盖 no account / no token 的区别、禁用客户端、上游不可达和 stream 错误。

### F1. 记录请求元数据审计

作为服务拥有者，我想查询每次请求的元数据，这样我可以知道哪个客户端用了哪个账号和 token。

验收标准：

1. 每个请求至少创建一个 audit event。
2. audit event 记录 local client、pool、account、token label、model、endpoint、status、error type、created_at。
3. 成功响应记录 upstream request id 和 client request id。
4. 失败响应记录错误分类。
5. 默认不记录 prompt、completion、tool result、文件内容。

状态：已完成。

### F2. 记录 quota snapshot 并用于保守路由

作为服务拥有者，我想保存上游 quota / rate-limit headers，这样我可以观察不同账号的订阅用量状态，并避免继续选择仍处于 rejected 窗口内的账号。

验收标准：

1. upstream-client 从响应 headers 提取 `anthropic-ratelimit-unified-*`。
2. quota snapshot 绑定 account uuid 和 token label。
3. quota snapshot 不跨账号合并。
4. 最近 snapshot 为 `rejected` 且 reset 未过期时，account-router 不选择该账号。
5. quota 信息默认不返回给普通下游 Messages 响应。

状态：已完成。

### G1. 用参考源码确定协议基线

作为维护者，我要先看 Claude Code 原始源码，再实现 OAuth 和 Messages 行为，这样服务不会靠猜测协议字段。

验收标准：

1. OAuth endpoint、client id、scope 来自参考源码。
2. Messages body keys、headers、metadata 来自参考源码。
3. SSE / WebSocket 边界来自源码和 SDK 行为验证。
4. 调研结果写入文档。

状态：已完成。

### G2. 用 npm 包补充验证当前发布行为

作为维护者，我要安装 Claude Code npm 包并对混淆代码做局部验证，这样可以发现参考源码和当前发布包之间的差异。

验收标准：

1. npm 包作为 spike / 验证输入，不作为运行时黑盒依赖。
2. 对 OAuth、Messages、headers、metadata、streaming 做局部验证。
3. 如果 npm 包行为与参考源码不一致，记录差异并以当前发布行为或线上实测为准。

状态：持续治理。当前提供 `npm run probe:claude-code` 做可重复字符串级验证；升级包或新增协议字段时必须重新跑。

### G3. 轻量 7 层代理优先

作为维护者，我希望服务尽量做轻量 HTTP 层适配，而不是引入过重 SDK 抽象，这样协议和审计边界更可控。

验收标准：

1. 上游请求构造可审计。
2. 不把账号池、审计、错误语义藏进 SDK 黑盒。
3. 若使用 SDK，只用于 spike 或局部验证，运行时路径必须仍能解释每个 header / body 字段。
4. streaming 行为必须保持 SSE 语义。

状态：已完成。运行时已使用 raw fetch 风格 upstream client；Claude Code 自身使用 Anthropic SDK 的事实记录在源码调研中。

### H1. 真实 OAuth/profile live smoke

作为服务拥有者，我要用真实 Claude.ai 账号跑通 OAuth callback 和 profile 入库，这样可以确认本地实现不仅通过 mock。

验收标准：

1. `npm run smoke:live` 能启动本地服务并生成 authorize URL。
2. 浏览器登录后 callback 返回本地服务。
3. SQLite 中出现 account 和 token。
4. profile 字段和文档中的数据模型能对齐。

状态：已完成。2026-06-22 使用真实 Claude.ai Pro 账号完成 browser OAuth callback，profile/account/token/pool membership 自动断言通过。

### H2. 真实 Messages JSON live smoke

作为服务拥有者，我要用真实 Claude.ai OAuth token 发送一次 non-streaming Messages 请求，这样确认 OAuth bearer + body/header/metadata 能被上游接受。

验收标准：

1. 显式指定模型运行 `npm run smoke:live -- --messages --model <model>`。
2. non-streaming 请求返回成功 JSON 或保留上游错误语义。
3. audit event 记录 account、token、model、request id、status。
4. quota snapshot 如有相关 header 则入库。

状态：已完成。2026-06-22 使用 `claude-haiku-4-5-20251001` 完成真实 JSON Messages smoke，HTTP 200，audit status 为 `success`，quota snapshot status 为 `allowed`。

### H3. 真实 Messages SSE live smoke

作为服务拥有者，我要用真实 Claude.ai OAuth token 发送一次 streaming Messages 请求，这样确认 SSE 传输、审计和错误处理在真实上游可用。

验收标准：

1. 显式指定模型运行 Messages smoke。
2. `stream: true` 请求返回 SSE event。
3. 服务不缓冲完整响应后再返回。
4. stream 正常结束写 success；中断写 interrupted / `gateway_stream_*`。

状态：已完成。2026-06-22 使用 `claude-haiku-4-5-20251001` 完成真实 SSE Messages smoke，HTTP 200，stream chunks > 0，audit status 为 `success`，quota snapshot status 为 `allowed`。

说明：`npm run smoke:live` 已包含 H1-H3 的自动断言。OAuth/profile 阶段会验证 token、account 和 pool membership；`--messages` 阶段会验证 JSON 与 SSE 均产生 `success` 的 Messages audit event，并输出最近 audit/quota 元数据。

## 8. 非 MVP 用户故事

以下 story 暂不实现，只保留为后续候选：

| ID | 用户故事 | 暂缓原因 |
| --- | --- | --- |
| N1 | 接入 Claude Code remote sessions / CCR | 协议面和身份语义更复杂 |
| N2 | 使用 WebSocket 代理推理 | 当前 Messages MVP 使用 HTTP JSON/SSE |
| N3 | 代理 voice stream STT | 非 Messages 主链路 |
| N4 | 代理 MCP server | 工具权限、远端 server 身份和审计边界需单独设计 |
| N5 | 复制 GrowthBook / Datadog 上报 | 不属于个人本地审计目标 |
| N7 | token 加密或 keychain 存储 | 用户明确要求 MVP 明文入 SQLite |
| N8 | 多用户权限隔离 | 项目目标不是多租户 |
| N9 | 默认保存完整 prompt / completion 正文 | 与默认隐私边界冲突 |
| N10 | 复杂 quota-aware 自动调度 | MVP 只做保守过滤，不做复杂负载均衡 |

## 9. MVP 完成定义

MVP 只有在以下条件全部满足后才算完成：

1. OAuth authorize、callback、token exchange、profile 入库可用。
2. SQLite 明文保存多个账号和 token。
3. 账号池、本地客户端和默认 pool 绑定可用。
4. non-streaming Messages 可通过真实上游 smoke。
5. SSE streaming Messages 可通过真实上游 smoke。
6. token 过期 refresh 和上游 401 retry 可用。
7. 上游错误与网关错误可区分。
8. audit event 能回答：哪个本地客户端、哪个账号池、哪个账号、哪个 token、哪个模型、哪个 upstream request id、什么结果。
9. 默认不保存 prompt、completion、tool result、文件内容正文。
10. `src/` 不依赖 `repos/`。
11. 关键兼容行为有参考源码、npm 包 probe 或线上实测依据。

## 10. 当前剩余缺口

当前 MVP 用户故事均已完成并通过本地测试、npm probe、dry-run smoke 与真实上游 live smoke 验证。

已知观察：

1. 2026-06-22 初次 H1 OAuth live smoke 时账号尚未刷新到 Pro，页面返回 `Claude Max or Pro is required to connect to Claude Code`。
2. 切换到 `--host localhost` 后，真实 OAuth callback 与 token exchange 成功；这说明 authorize URL 和 token exchange 的 `redirect_uri` 必须保持同一个 host。
3. `claude-sonnet-4-6` 真实 Messages 请求返回上游 429 `rate_limit_error`，本地正确保留上游 status/type/request id。
4. `claude-haiku-4-5-20251001` 真实 JSON 与 SSE Messages 请求均返回 200，audit 和 quota snapshot 均写入成功记录。
