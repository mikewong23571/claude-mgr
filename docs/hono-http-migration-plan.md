# Hono HTTP Migration Plan

本文档记录把手写 HTTP 路由迁移到 Hono 的计划和当前实施状态。目标是提升本地 HTTP API 的一致性和可维护性，不改变 OAuth、Messages、routing、storage、audit 或 upstream 协议行为。

## 0. 当前状态

状态：已实施。

当前 HTTP 层已经迁移为 Hono route modules：

```text
src/http/
  app.ts
  responses.ts
  validation.ts
  routes/
    admin.ts
    health.ts
    messages.ts
    oauth.ts
    static-admin.ts
```

保留的运行时边界：

1. `createFetchHandler(options)` 仍返回 `(request: Request) => Promise<Response>`。
2. `src/http/server.ts` 仍负责 Node HTTP 到 Web `Request` / `Response` 的适配。
3. 未引入 `@hono/node-server`。
4. `POST /v1/messages` 仍直接返回原生 `ReadableStream` 作为 SSE response body。
5. Admin 静态资源仍受 `public/admin` 目录约束，未引入通用静态文件中间件。

完成后的验证命令：

```text
npm run typecheck
npm test -- tests/http-app.test.ts
npm test
npm run probe:claude-code
npm run smoke:live -- --dry-run --host localhost
```

验证结果：以上命令均通过。`--messages` live smoke 仍需要显式执行，因为会消耗 Claude.ai quota。

## 1. 迁移结论

采用 Hono 作为轻量 HTTP 路由层。

不采用 Nest、Express 或其他更重框架作为本轮迁移目标：

1. 当前服务是个人本地 OAuth gateway，不需要 Nest 风格的应用框架、依赖注入和模块系统。
2. 当前实现已经以 Web `Request` / `Response` 为核心，Hono 可以保留这个边界。
3. `POST /v1/messages` 需要保持 SSE streaming 语义，迁移不能引入 buffering 或响应包装副作用。
4. 迁移目标是让路由、校验和错误映射更清晰，不重写业务核心。

第一阶段只引入 `hono`。暂不引入 `@hono/node-server`，继续复用当前 Node HTTP 到 Web `Request` / `Response` 的适配层。只有在 Hono route migration 稳定后，才评估是否用 `@hono/node-server` 替换 `src/http/server.ts`。

## 2. 当前问题

迁移前，`src/http/app.ts` 把以下职责集中在一个 `handle(request)` 控制流中：

1. 静态 admin console 资源。
2. `GET /health`。
3. OAuth authorize 和 callback。
4. admin pools、clients、accounts、tokens、audit events、quota snapshots。
5. `POST /v1/messages` JSON 和 SSE 代理。
6. gateway/upstream/storage error 到 HTTP response 的映射。
7. 404 fallback。

这不是业务分层失败，但 HTTP 层已经接近需要正式路由组织的阈值。继续使用手写 `url.pathname`、`request.method` 和 `pathParts()` 会带来以下风险：

1. 新 route 更容易出现匹配顺序和路径参数问题。
2. 请求体校验会继续分散在路由内部。
3. admin API 的重复结构会增加维护成本。
4. `Messages` streaming route 的关键行为埋在大文件尾部，不利于审计。

## 3. 保持不变的边界

迁移不得改变这些行为：

1. `createFetchHandler(options)` 对测试和 server 的外部签名保持稳定。
2. Gateway errors 使用 `gateway_*` type。
3. Upstream errors 保留上游 status、type、message 和 request id。
4. Admin token listing 仍只返回 token metadata，不返回 access token 或 refresh token。
5. `POST /v1/messages` 缺少 `x-claude-mgr-client-id` 时仍写入 error audit event。
6. JSON Messages response 仍保留 `x-client-request-id` 和 upstream `request-id`。
7. SSE Messages response 仍返回 `text/event-stream`，不 buffer upstream stream。
8. Debug traffic recorder 仍只记录脱敏结构摘要，不记录 prompt、completion、tool result 或文件内容。
9. 运行时代码仍不得 import 或依赖 `repos/`。

## 4. 目标文件结构

目标结构：

```text
src/http/
  app.ts
  server.ts
  responses.ts
  validation.ts
  routes/
    admin.ts
    health.ts
    messages.ts
    oauth.ts
    static-admin.ts
```

建议职责：

1. `app.ts`: 创建 Hono app、挂载 route modules、注册 error mapper 和 404。
2. `responses.ts`: 放 `json()`、`errorResponse()` 和可复用 validation helpers。
3. `routes/health.ts`: `GET /health`。
4. `routes/static-admin.ts`: `/`、`/admin`、`/admin/`、`/admin/index.html`、`/admin/admin.js`、`/admin/styles.css`。
5. `routes/oauth.ts`: OAuth authorize、callback 和 pending OAuth state 闭包。
6. `routes/admin.ts`: pools、clients、accounts、tokens、audit events、quota snapshots。
7. `routes/messages.ts`: `POST /v1/messages` JSON/SSE 代理。

`createFetchHandler()` 应继续返回 `(request: Request) => Promise<Response>`：

```ts
export function createFetchHandler(options: AppOptions) {
  const app = createHonoApp(options)
  return async (request: Request): Promise<Response> => await app.fetch(request)
}
```

## 5. Spike

状态：已由正式迁移覆盖。

先做 disposable spike，不直接作为最终实现扩展。

Spike 范围：

1. 安装 `hono`。
2. 新建临时 Hono app。
3. 只迁移 `GET /health` 和 `POST /v1/messages`。
4. 保留现有 `createFetchHandler(options)` 调用方式。
5. 使用现有 `tests/http-app.test.ts` 验证行为。

Spike 必须确认：

1. `app.fetch(request)` 可直接接入当前 `src/http/server.ts`。
2. `app.onError()` 能复用现有 gateway/upstream/storage error response 结构。
3. `POST /v1/messages` SSE path 可以直接返回原生 `ReadableStream`。
4. 现有 JSON 和 SSE audit tests 不需要语义重写。

Spike 检查命令：

```text
npm run typecheck
npm test -- tests/http-app.test.ts
```

如果 spike 不能保持 SSE 或错误语义，停止迁移，回到手写 route split，不继续引入 Hono。

## 6. 正式迁移步骤

状态：已完成。

### Step 1: 建立 Hono app 骨架

完成状态：已完成。`src/http/app.ts` 创建 Hono app、注册 `onError`、`notFound` 和 route modules。

1. 新增 `createHonoApp(options)`。
2. `createFetchHandler(options)` 包装 `createHonoApp(options).fetch`。
3. 注册统一 `app.onError()`，复用现有 `errorResponse()`。
4. 注册统一 `app.notFound()`，保持现有 404 body。
5. 暂时只迁移 `GET /health`。

验证：

```text
npm run typecheck
npm test -- tests/http-app.test.ts
```

### Step 2: 迁移 static admin assets

完成状态：已完成。Static admin route 保留 `Cache-Control: no-store`、`HEAD` 支持、目录逃逸保护和 `public/admin` 目录约束。

迁移 `/`、`/admin` 和 `/admin/*` 静态资源响应。

注意：

1. 保持 `Cache-Control: no-store`。
2. 保持 `HEAD` 支持。
3. 不引入静态文件中间件，避免扩展资源暴露面。
4. 资源路径仍限制在 `public/admin` 目录内，并保留目录逃逸保护。

验证 admin console 测试仍通过。

### Step 3: 迁移 OAuth routes

完成状态：已完成。`pendingOAuth` 仍由 route factory 闭包持有，`OAuthClient` 仍可通过 `AppOptions.oauthClient` 注入。

迁移：

1. `GET /oauth/authorize`
2. `GET /callback`
3. `GET /oauth/callback`
4. `POST /oauth/callback`

注意：

1. `pendingOAuth` 继续由 app factory 闭包持有。
2. `OAuthClient` 仍可通过 `AppOptions.oauthClient` 注入。
3. `label`、`source_device`、`code`、`state` 的 validation error 文案保持稳定。
4. `pool_id` 仍只作为本地 pool membership 写入，不发送上游。

### Step 4: 迁移 Admin routes

完成状态：已完成。Admin resources 已迁移到 Hono params，store 访问仍通过 store API。

建议按资源分块迁移：

1. pools collection 和 pool detail。
2. pool members。
3. clients collection 和 client detail。
4. accounts patch。
5. readonly tokens、audit events、quota snapshots。

注意：

1. 路径参数使用 Hono params，不再使用 `pathParts()`。
2. token listing 继续显式映射 metadata 字段。
3. SQLite driver error 仍由统一 error mapper 转成 `gateway_storage_error`。
4. 不在 route 里直接拼 SQL，继续只通过 store API。

### Step 5: 迁移 Messages route

完成状态：已完成。Messages route 保留 missing-client audit、session header 解析、debug recorder、JSON response headers 和 SSE response headers。

最后迁移 `POST /v1/messages`。

注意：

1. 保留 missing local client id 的 audit write。
2. 保留 `x-claude-mgr-pool-id`、`x-claude-mgr-session-id`、`x-claude-code-session-id` 解析顺序。
3. `debugRecorder.record()` 的 direction、phase、method、url、headers、body 不变。
4. JSON response headers 不变。
5. SSE response headers 不变。
6. 不读完整 SSE body，不包裹成 JSON，不引入 Hono streaming helper，除非现有 tests 证明完全等价。

### Step 6: 引入集中 request validation

完成状态：已完成。`src/http/validation.ts` 使用 `zod` 集中校验 OAuth callback 和 admin request bodies。Messages body 仍由 `src/messages/adapter.ts` 控制。

路由稳定后，再把已存在的 `zod` 用作 HTTP 输入校验。

建议 schema：

1. `OAuthCallbackBody`
2. `CreatePoolBody`
3. `UpdatePoolBody`
4. `AddPoolMemberBody`
5. `UpdatePoolMemberBody`
6. `CreateClientBody`
7. `UpdateClientBody`
8. `UpdateAccountBody`

要求：

1. Validation failure 继续返回 `gateway_validation_error`。
2. 不把 zod error 细节原样暴露为长文本，避免本地 API 响应不稳定。
3. 不为 Messages body 做完整 Anthropic schema 复制，Messages 语义仍由 `src/messages/adapter.ts` 控制。

### Step 7: 清理旧手写 routing

完成状态：已完成。`pathParts()` 和 `src/http/app.ts` 的集中 `if` chain 已删除。

完成全部 route migration 后：

1. 删除 `pathParts()`。
2. 删除集中大 `if` chain。
3. 保留必要的 shared response helpers。
4. 确认 `src/http/app.ts` 只负责 app assembly。

## 7. 验证门槛

每个步骤至少运行：

```text
npm run typecheck
npm test -- tests/http-app.test.ts
```

完整迁移完成后运行：

```text
npm run typecheck
npm test
npm run probe:claude-code
npm run smoke:live -- --dry-run --host localhost
```

真实 Messages smoke 需要显式确认，因为会消耗 Claude.ai quota：

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001
```

## 8. 回滚策略

迁移应保持小步提交，方便回滚单个阶段。

推荐提交边界：

1. Add Hono dependency and app skeleton.
2. Move static and health routes.
3. Move OAuth routes.
4. Move admin routes.
5. Move Messages route.
6. Add request validation schemas.
7. Remove old routing helpers and update docs.

如果任一步骤导致 SSE、OAuth callback、error mapping 或 audit 行为不稳定，回滚该步骤，不继续扩大迁移范围。

## 9. 后续可选项

迁移稳定后再评估：

1. 是否用 `@hono/node-server` 替换当前 `src/http/server.ts`。
2. 是否把 route response schema 加入 contract tests。
3. 是否为 admin API 添加更细的 request validation governance tests。

这些不是第一轮 Hono 迁移的完成条件。

## 10. 参考

Hono 文档中与本迁移相关的能力：

1. `app.fetch` 作为 Web 标准入口。
2. `app.route()` 用于较大应用的 route grouping。
3. `app.onError()` 用于集中错误处理。
4. `@hono/node-server` 可作为后续 Node server adapter 选项。

参考链接：

1. https://hono.dev/docs/api/hono
2. https://hono.dev/docs/api/routing
3. https://hono.dev/docs/api/exception
4. https://hono.dev/docs/getting-started/nodejs
