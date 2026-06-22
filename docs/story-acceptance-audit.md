# Story Acceptance Audit

本文档把 `docs/user-stories.md` 中的 MVP story 映射到当前实现证据。它用于判断“构建应用，实现当前规划的所有用户故事”是否已经被证明，而不是替代用户故事本身。

状态含义：

1. `proven-local`：当前代码、测试、文档和本地 smoke 已能证明。
2. `live-proven`：当前代码、测试、本地 smoke 和真实 Claude.ai 上游请求已能证明。
3. `needs-live-smoke`：本地实现已覆盖，但必须用真实 Claude.ai OAuth / Messages 请求证明。
4. `ongoing-governance`：已有治理入口，但后续协议变更仍需持续执行。
5. `not-mvp`：明确不属于当前 MVP。

## Current Verification

最近一次本地验证命令：

```text
npm run typecheck
npm test
npm run probe:claude-code
npm run smoke:live -- --dry-run --host localhost
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=local-dummy-key ANTHROPIC_CUSTOM_HEADERS=$'x-claude-mgr-client-id: live-smoke-client\nx-claude-mgr-pool-id: live-smoke' node_modules/.bin/claude --bare --print --no-session-persistence --disable-slash-commands --model claude-haiku-4-5-20251001 --output-format json "Respond with exactly OK and nothing else."
```

本地结果：

1. TypeScript typecheck 通过。
2. Vitest 通过：6 个测试文件，70 个测试。
3. Claude Code npm probe 通过：`missingRequiredMarkers: []`。
4. dry-run smoke 通过：本地服务启动、创建 smoke pool/client、生成 Claude Code OAuth URL，未等待 OAuth callback，未消耗 Messages 额度。
5. H1 live smoke 通过：真实 Claude.ai Pro 账号完成 browser OAuth callback，profile/account/token/pool membership 断言通过。
6. H2/H3 低层 Messages 证据通过：`claude-haiku-4-5-20251001` JSON 和 SSE 请求均返回 200，audit status 为 `success`。
7. Claude Code CLI 端到端 smoke 通过：Claude Code 2.1.185 通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_CUSTOM_HEADERS` 访问本地网关，返回 `OK`，audit 中出现 `/v1/messages` success，并验证官方入站 session 映射为服务端 upstream session。
8. D5 live probe 通过：`/api/oauth/usage` 和 `/api/claude_cli/bootstrap` 均通过本地网关返回 200 和 upstream request id；验证时只输出 status、request id 是否存在和 JSON 顶层 keys，不输出 token 或具体用量数值。
9. D6 partial live probe 通过：`GET /v1/files` 通过本地网关返回 200 和 upstream request id；验证时只输出 status、request id 是否存在和 JSON 顶层 keys，不输出文件列表内容。

## Story Evidence Matrix

| ID | Status | Evidence |
| --- | --- | --- |
| A1 | proven-local | `.git/`、`.gitignore`、`package.json`、`tsconfig.json`、`src/`、`tests/governance.test.ts` |
| A2 | proven-local | `.gitmodules`、`repos/claude-code-analysis` submodule、`tests/governance.test.ts` 禁止 `src/` import `repos/` |
| A3 | ongoing-governance | `README.md`、`docs/module-boundaries.md`、`docs/message-forwarding-policy.md`、`tests/governance.test.ts` |
| B1 | live-proven | `src/oauth/config.ts`、`src/oauth/pkce.ts`、`src/oauth/client.ts`、`src/http/app.ts`、`tests/oauth-and-upstream.test.ts`、dry-run smoke、2026-06-22 real browser OAuth |
| B2 | live-proven | `OAuthClient.exchangeCode` sends `anthropic-beta: oauth-2025-04-20`、`createFetchHandler` callback path、`oauth_tokens` schema、OAuth callback tests、2026-06-22 token exchange live smoke |
| B3 | live-proven | `OAuthClient.fetchProfile` sends `anthropic-beta: oauth-2025-04-20`、`OAuthClient.installToken`、`claude_accounts` schema、profile failure test、2026-06-22 profile live smoke |
| C1 | live-proven | `claude_accounts`、`oauth_tokens`、`quota_snapshots`、`audit_events` schema；account enable/disable and routing tests；2026-06-22 real account/token/quota/audit association |
| C2 | proven-local | account pool CRUD routes, store methods, pool member priority/enabled tests |
| C3 | proven-local | local client CRUD routes, default pool routing, disabled client auth test |
| D1 | live-proven | `src/messages/adapter.ts` body allowlist, `src/upstream/messages-client.ts` `/v1/messages?beta=true`, tests for JSON request and audit, 2026-06-22 JSON Messages live smoke |
| D2 | live-proven | `MessagesGateway.sendStream`, `wrapAuditedStream`, `UpstreamMessagesClient.sendStream`, tests for SSE success/read failure/cancel, 2026-06-22 SSE Messages live smoke |
| D3 | live-proven | `TokenRefresher`, refresh lock test, expired-token refresh path, upstream 401 retry tests, 2026-06-22 real OAuth token accepted by inference path |
| D4 | live-proven | account-scoped `upstreamClientIdentityId`, adapter-generated `metadata.user_id`, tests rejecting local routing fields in upstream metadata, 2026-06-22 real upstream accepted account-scoped metadata |
| D5 | live-proven | `src/claude-cli/gateway.ts`, `src/upstream/claude-cli-client.ts`, `/api/oauth/usage` and `/api/claude_cli/bootstrap` route tests, profile-scope token filtering, 2026-06-22 live probe returned 200/request id for both service endpoints |
| D6 | proven-local | `src/api-proxy/gateway.ts`, `src/upstream/api-proxy-client.ts`, transparent proxy tests for Files download/upload, event logging, and trusted-device enrollment; tests assert auth header replacement and local header stripping; 2026-06-22 `GET /v1/files` live probe returned 200/request id |
| E1 | live-proven | `UpstreamError`, upstream error preservation tests, upstream request id audit tests, 2026-06-22 Sonnet 4.6 returned real upstream 429 `rate_limit_error` and request id |
| E2 | proven-local | `GatewayError`, `errorResponse`, no-account/no-token/auth/storage/upstream-unreachable/stream tests |
| F1 | proven-local | `audit_events` metadata schema, request audit tests, governance test forbidding prompt/completion/body/file-content audit columns |
| F2 | proven-local | `quotaSnapshotFromHeaders`, `quota_snapshots` schema, rejected quota routing test |
| G1 | proven-local | source review docs, OAuth constants, Messages policy, SDK endpoint/header tests |
| G2 | ongoing-governance | `scripts/probe-claude-code-package.mjs`, `npm run probe:claude-code`, governance test for required markers |
| G3 | proven-local | runtime uses raw fetch upstream client; SDK is dev dependency for spike/verification only; tests assert exact headers/body |
| H1 | live-proven | 2026-06-22 real Claude.ai Pro browser OAuth login and callback into `npm run smoke:live` |
| H2 | live-proven | 2026-06-22 low-level `claude-haiku-4-5-20251001` JSON request returned 200 and success audit |
| H3 | live-proven | 2026-06-22 low-level `claude-haiku-4-5-20251001` SSE request returned 200, stream chunks > 0, and success audit |
| H4 | live-proven | 2026-06-22 Claude Code 2.1.185 CLI `--bare --print` request through local gateway returned `OK`; audit recorded success under `live-smoke-client` / `live-smoke`; current `npm run smoke:live -- --messages` uses this CLI path |

## Completion Gate

The MVP completion gate is satisfied. H1, H2, and H3 have been proven against a real Claude.ai account.

The live commands used were:

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001
```

The first command proved OAuth/profile install after the service owner completed browser login. The second command now proves official Claude Code CLI end-to-end Messages behavior through the local gateway.

Completion evidence:

1. OAuth/profile: account, organization, token, scopes, and pool membership were asserted by `scripts/live-smoke.ts`.
2. JSON Messages: HTTP 200 with upstream request id and success audit event.
3. SSE Messages: HTTP 200, stream chunks > 0, upstream request id, and success audit event.
4. Quota snapshots: status `allowed` recorded for the successful JSON and SSE requests.

## Live Attempt Log

### 2026-06-22 OAuth attempt before subscription refresh

Command:

```text
npm run smoke:live -- --port 8799 --db data/live-smoke.sqlite
```

Observed browser state:

1. Claude OAuth authorize page opened under the logged-in Chrome profile.
2. Page showed: `Claude Max or Pro is required to connect to Claude Code`.
3. No authorization button was available, so no OAuth callback reached `127.0.0.1:8799`.
4. The smoke script timed out waiting for `live-smoke-token`.

Conclusion:

1. The local callback path and authorize URL were exercised.
2. H1 is still not proven because the logged-in Claude.ai account did not have a Claude Max or Pro subscription eligible for Claude Code OAuth.
3. Retest requires switching Chrome to a Claude.ai account with Max/Pro, then rerunning the H1 smoke command.

### 2026-06-22 OAuth/profile live smoke success

Command:

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
```

Result:

1. Browser OAuth authorization succeeded.
2. Account/profile evidence assertion passed.
3. Token label `live-smoke-token` was installed.
4. Account was added to pool `live-smoke`.

Important compatibility note:

Use `--host localhost` for this smoke path. A prior attempt using `127.0.0.1` reached the browser but failed during callback/token handling after the authorization page normalized the redirect host to `localhost`.

### 2026-06-22 Messages live smoke

Successful command:

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001
```

Result:

1. JSON Messages returned HTTP 200 and wrote a `success` audit event.
2. SSE Messages returned HTTP 200, produced stream chunks, and wrote a `success` audit event.
3. Both successful requests wrote quota snapshots with status `allowed`.

Additional upstream error observation:

```text
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-sonnet-4-6
```

Result:

1. JSON Messages returned upstream HTTP 429 `rate_limit_error`.
2. The gateway preserved upstream status/type/request id and wrote an error audit event.
