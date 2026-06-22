# Claude Code Auth and Identity Source Review

Status:

- Source review against `repos/claude-code-analysis` at submodule commit `7b7b915d7da804088a8152ed24c68e3da2d1110e`.
- Local npm package probe against `@anthropic-ai/claude-code@2.1.185`, resolved and installed on 2026-06-21.

This document records how the reference Claude Code source handles Claude.ai OAuth authentication, token storage and refresh, upstream request identity, telemetry/data reporting, and observed device/user fingerprinting surfaces. The goal is to define a factual baseline for `claude-mgr`; this is not a bypass guide and does not prescribe forging browser or device fingerprints.

## Scope

Reviewed source areas:

- OAuth config and login: `src/constants/oauth.ts`, `src/cli/handlers/auth.ts`, `src/services/oauth/*`.
- Token source, storage, refresh, and logout: `src/utils/auth.ts`, `src/utils/secureStorage/*`, `src/commands/logout/logout.tsx`.
- API client/request construction: `src/services/api/client.ts`, `src/services/api/claude.ts`, `src/utils/http.ts`, `src/constants/system.ts`.
- Account/user metadata: `src/utils/config.ts`, `src/utils/user.ts`.
- Quota, bootstrap, usage, file APIs: `src/services/claudeAiLimits.ts`, `src/services/api/bootstrap.ts`, `src/services/api/usage.ts`, `src/services/api/filesApi.ts`.
- Data reporting: `src/services/analytics/*`, `src/services/api/logging.ts`, `src/utils/privacyLevel.ts`.

Also installed npm package:

- `@anthropic-ai/claude-code@2.1.185` as a dev dependency for update/spike verification.
- On this machine the wrapper installed `@anthropic-ai/claude-code-darwin-arm64@2.1.185`; `node_modules/.bin/claude --version` returns `2.1.185 (Claude Code)`.
- The npm artifact is a native Mach-O binary plus small wrapper scripts, not readable TypeScript. Verification is therefore string-level and behavioral-probe oriented, not equivalent to a full source review.

## OAuth Configuration

Production OAuth configuration is centralized in `src/constants/oauth.ts`. The normal Claude.ai subscriber flow uses:

- `BASE_API_URL`: `https://api.anthropic.com`.
- Claude.ai authorize URL: `https://claude.com/cai/oauth/authorize`, which comments say redirects through Claude web properties for attribution.
- Console authorize URL: `https://platform.claude.com/oauth/authorize`.
- Token URL: `https://platform.claude.com/v1/oauth/token`.
- API key creation URL: `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`.
- Roles URL: `https://api.anthropic.com/api/oauth/claude_cli/roles`.
- OAuth client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.

Claude.ai OAuth scopes are:

- `user:profile`
- `user:inference`
- `user:sessions:claude_code`
- `user:mcp_servers`
- `user:file_upload`

Console OAuth uses `org:create_api_key` plus `user:profile`; the login request can request the union of Console and Claude.ai scopes. Custom OAuth URLs are allowlisted to specific FedStart/PubSec bases, not arbitrary endpoints.

Evidence: `src/constants/oauth.ts:33-58`, `src/constants/oauth.ts:83-104`, `src/constants/oauth.ts:176-220`.

## Login and Token Acquisition

Claude Code implements OAuth 2.0 authorization code flow with PKCE:

1. `OAuthService` creates a localhost callback listener and generates a code verifier, challenge, and state.
2. It builds both automatic and manual URLs.
3. Automatic flow opens the browser and receives `http://localhost:<port>/callback`.
4. Manual flow sends the user to the configured manual redirect URL and accepts a pasted code.
5. It exchanges the authorization code for tokens at the token URL, then fetches profile data.

`buildAuthUrl()` sets `code=true`, `client_id`, `response_type=code`, `redirect_uri`, requested scopes, `code_challenge`, `code_challenge_method=S256`, `state`, plus optional `orgUUID`, `login_hint`, and `login_method`.

`exchangeCodeForTokens()` posts JSON with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and `state`. `refreshOAuthToken()` posts `grant_type=refresh_token`, `refresh_token`, `client_id`, and requested scopes.

There is also a non-browser fast path: `authLogin()` can use `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` plus `CLAUDE_CODE_OAUTH_SCOPES` to refresh and install tokens without opening a browser. That path is useful for controlled environments, but the resulting installed token still follows the same storage and account profile path.

Evidence: `src/services/oauth/index.ts:14-132`, `src/services/oauth/client.ts:46-144`, `src/services/oauth/client.ts:146-240`.

## Account Profile and Global Auth State

OAuth account metadata is stored in global config, separately from secret token storage. The account structure includes:

- `accountUuid`
- `emailAddress`
- `organizationUuid`
- organization name/role/workspace role
- display name
- extra usage flag
- billing type
- account creation time
- subscription creation time

`getOauthAccountInfo()` returns this account only when Anthropic first-party auth is enabled. That means external API-key, Bedrock, Vertex, Foundry, or bare-mode auth suppresses OAuth account identity in normal analytics/user metadata paths.

Logout flushes telemetry before clearing credentials, removes API key material, deletes secure storage, clears auth-related caches, refreshes GrowthBook after auth changes, and removes `oauthAccount` from global config.

Evidence: `src/utils/config.ts:161-174`, `src/utils/auth.ts:1611-1617`, `src/commands/logout/logout.tsx:16-47`, `src/commands/logout/logout.tsx:50-71`.

## Token Storage

`saveOAuthTokensIfNeeded()` persists only Claude.ai tokens with `user:inference`. It intentionally skips:

- non-Claude.ai OAuth tokens
- inference-only tokens lacking refresh token or expiry, such as env/FD tokens

The stored shape is `storageData.claudeAiOauth`:

- `accessToken`
- `refreshToken`
- `expiresAt`
- `scopes`
- `subscriptionType`
- `rateLimitTier`

Token storage backend selection:

- macOS: keychain primary with plaintext fallback.
- non-macOS: plaintext file only.
- plaintext path: `${CLAUDE_CONFIG_DIR or ~/.claude}/.credentials.json`, chmod `0600`, with a warning that credentials are stored in plaintext.

macOS keychain storage uses `security find-generic-password` and `security add-generic-password`. It stores the JSON as a hex payload, prefers `security -i` stdin to avoid putting payloads in process arguments, and falls back to argv for large payloads. Keychain reads use a short cache and stale-while-error behavior.

The fallback storage reads primary first, then secondary. On primary write success it deletes the secondary when migrating. If primary write fails and secondary succeeds, it deletes stale primary data best-effort so stale keychain values do not shadow fresh plaintext data.

Evidence: `src/utils/auth.ts:1193-1253`, `src/utils/secureStorage/index.ts:6-17`, `src/utils/secureStorage/plainTextStorage.ts:13-84`, `src/utils/secureStorage/macOsKeychainStorage.ts:26-176`, `src/utils/secureStorage/fallbackStorage.ts:7-70`.

## Token Resolution Priority

Anthropic auth is disabled for bare mode, third-party providers, or external auth/API-key sources unless running in a managed OAuth context such as Claude Code Remote or Claude Desktop. The bearer token source priority is:

1. `ANTHROPIC_AUTH_TOKEN`, unless in managed OAuth context.
2. `CLAUDE_CODE_OAUTH_TOKEN`.
3. OAuth token from file descriptor or CCR disk fallback.
4. configured `apiKeyHelper`, unless in managed OAuth context.
5. stored Claude.ai OAuth token from secure storage.

`getClaudeAIOAuthTokens()` returns env-var and FD tokens as inference-only tokens with `scopes: ['user:inference']`, no refresh token, and no expiry. These are usable for inference but do not have `user:profile`, so profile-scoped endpoints are gated by `hasProfileScope()`.

Evidence: `src/utils/auth.ts:98-149`, `src/utils/auth.ts:151-206`, `src/utils/auth.ts:1255-1300`, `src/utils/auth.ts:1572-1584`.

## Refresh, 401 Handling, and Cross-Process Coordination

Before creating an Anthropic API client, Claude Code calls `checkAndRefreshOAuthTokenIfNeeded()`. Refresh behavior:

- It invalidates OAuth caches if `.credentials.json` mtime changed.
- It skips refresh when the token has no refresh token, is not expired, or is not Claude.ai auth.
- It re-reads token storage before refresh to detect another process already refreshing.
- It uses a lockfile in the Claude config directory to serialize refresh across processes.
- It retries lock contention up to five times with jitter.
- It refreshes at the token endpoint and saves the new token set.

401 handling is forceful but conservative. `handleOAuth401Error(failedAccessToken)` deduplicates concurrent handlers for the same failed token, clears caches, re-reads storage, and if storage already contains a different access token it treats that as another process having refreshed. Otherwise it forces a refresh.

Evidence: `src/utils/auth.ts:1302-1392`, `src/utils/auth.ts:1424-1562`.

## API Request Authentication

The main Anthropic client sends these default headers:

- `x-app: cli`
- `User-Agent: claude-cli/<version> (<USER_TYPE>, <entrypoint>, optional agent-sdk/client-app/workload)`
- `X-Claude-Code-Session-Id: <sessionId>`
- SDK default `anthropic-version: 2023-06-01`
- optional `x-claude-remote-container-id`
- optional `x-claude-remote-session-id`
- optional `x-client-app`
- optional `x-anthropic-additional-protection`
- custom headers from `ANTHROPIC_CUSTOM_HEADERS`

For Claude.ai subscribers, SDK config uses `apiKey: null` and `authToken: <OAuth access token>`. The SDK bearer auth path sends `Authorization: Bearer <authToken>`, and SDK request construction adds `anthropic-version: 2023-06-01`. Helper functions that manually construct auth headers use:

- `Authorization: Bearer <accessToken>`
- `anthropic-beta: oauth-2025-04-20`

For API-key users, the client uses `x-api-key` or, for `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`, an `Authorization: Bearer ...` header.

For first-party API calls to the real Anthropic base URL, the fetch wrapper injects `x-client-request-id: <uuid>` unless already present. This is for server-log correlation, especially for timeouts that have no server request id.

Evidence: `src/services/api/client.ts:88-139`, `src/services/api/client.ts:300-315`, `src/services/api/client.ts:356-389`, `src/utils/http.ts:16-35`, `src/utils/http.ts:65-99`.

## API Body Metadata and Attribution Header

Main message requests are sent through `anthropic.beta.messages.create(...)`, which uses `/v1/messages?beta=true`; SDK code strips `betas` from the JSON body and sends them as `anthropic-beta` when present. Main message requests include `metadata: getAPIMetadata()`. `getAPIMetadata()` returns:

```json
{
  "user_id": "{\"device_id\":\"...\",\"account_uuid\":\"...\",\"session_id\":\"...\"}"
}
```

It also merges optional JSON from `CLAUDE_CODE_EXTRA_METADATA`. `device_id` is the global config `userID`; `account_uuid` comes from the active OAuth account; `session_id` comes from bootstrap state.

Separately, Claude Code computes a short attribution fingerprint from the first user message and version. The code uses a hardcoded salt, characters at indices 4, 7, and 20 of the first user text, plus `MACRO.VERSION`, then SHA256 and first three hex chars. This is not a browser/device fingerprint; it is a per-request Claude Code attribution fingerprint.

The fingerprint is embedded into a system prompt billing header string:

```text
x-anthropic-billing-header: cc_version=<version>.<fingerprint>; cc_entrypoint=<entrypoint>;
```

If native client attestation is compiled in, the header also includes `cch=00000`, with comments saying Bun's HTTP stack overwrites the placeholder with an attestation token before send.

Evidence: `src/services/api/claude.ts:503-528`, `src/utils/fingerprint.ts:1-76`, `src/services/api/claude.ts:1318-1369`, `src/constants/system.ts:59-95`.

## Other Authenticated Endpoints

Observed first-party endpoint usage beyond `/v1/messages`:

- `/api/claude_cli/bootstrap`: fetches client data and additional model options; skipped for essential-traffic mode, third-party providers, or no usable auth. `claude-mgr` supports this as `GET /api/claude_cli/bootstrap` with local client routing, `user:profile` token selection, OAuth beta header, one refresh retry on upstream 401, and metadata-only audit.
- `/api/oauth/usage`: fetches utilization for subscribers with `user:profile`, skipped when token is expired. `claude-mgr` supports this as `GET /api/oauth/usage` with the same local routing and audit behavior.
- `/v1/files/<file_id>/content`: file download with OAuth bearer, `anthropic-version: 2023-06-01`, and `anthropic-beta: files-api-2025-04-14,oauth-2025-04-20`. `claude-mgr` supports this as transparent proxy with local OAuth token injection and no content logging.
- `/v1/files`: upload/list path in the files API module, using similar OAuth/beta semantics. `claude-mgr` supports `GET` and `POST` as transparent proxy.
- `/api/event_logging/batch`: internal 1P analytics event export. `claude-mgr` supports this as transparent proxy; OAuth injection is optional because Claude Code can send this endpoint without auth.
- `/api/auth/trusted_devices`: remote-control trusted-device enrollment, gated and skipped in essential-traffic mode. `claude-mgr` supports this as transparent proxy with local OAuth token injection.

Evidence: `src/services/api/bootstrap.ts:42-109`, `src/services/api/usage.ts:33-63`, `src/services/api/filesApi.ts:25-38`, `src/services/api/filesApi.ts:132-180`, `src/services/analytics/firstPartyEventLoggingExporter.ts:112-120`, `src/bridge/trustedDevice.ts:89-210`.

## Quota and Usage Handling

Claude Code treats quota as response-header state rather than as a separate token property. It reads unified rate-limit headers:

- `anthropic-ratelimit-unified-status`
- `anthropic-ratelimit-unified-reset`
- `anthropic-ratelimit-unified-fallback`
- `anthropic-ratelimit-unified-representative-claim`
- `anthropic-ratelimit-unified-overage-status`
- `anthropic-ratelimit-unified-overage-reset`
- `anthropic-ratelimit-unified-overage-disabled-reason`
- per-window utilization/reset headers such as `anthropic-ratelimit-unified-5h-utilization`.

It also has an optional lightweight quota probe that sends a minimal message with `max_tokens: 1`, skipped for essential-traffic mode, noninteractive mode, or non-subscriber contexts.

Evidence: `src/services/claudeAiLimits.ts:164-179`, `src/services/claudeAiLimits.ts:199-249`, `src/services/claudeAiLimits.ts:376-485`.

## Analytics and Data Reporting

Analytics is disabled when:

- `NODE_ENV === 'test'`
- Bedrock, Vertex, or Foundry is active
- privacy level is `no-telemetry` or `essential-traffic`

Privacy level is controlled by:

- `DISABLE_TELEMETRY`: disables analytics/telemetry.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: disables all nonessential network traffic, including telemetry, auto-updates, Grove, release notes, model capabilities, etc.

Events enter `services/analytics/index.ts` and are queued until the analytics sink attaches. The public `logEvent()` metadata type intentionally allows only boolean/number/undefined by default; strings require explicit type-cast markers indicating they were reviewed for code/file paths or routed to privileged PII-tagged proto fields.

The sink fans out to:

- Datadog, only when a GrowthBook gate allows it, the sink is not killed, production environment is active, first-party provider is used, and the event is in a fixed allowlist.
- 1P event logging, unless analytics is disabled or the first-party sink is killed.

Evidence: `src/services/analytics/config.ts:11-27`, `src/utils/privacyLevel.ts:1-55`, `src/services/analytics/index.ts:11-58`, `src/services/analytics/index.ts:60-164`, `src/services/analytics/sink.ts:20-72`, `src/services/analytics/datadog.ts:19-64`, `src/services/analytics/datadog.ts:160-279`.

## 1P Event Logging Details

1P event logging uses its own OpenTelemetry `LoggerProvider`, separate from customer OTLP telemetry. It batches events and exports to:

```text
https://api.anthropic.com/api/event_logging/batch
```

or staging/custom base URL if configured by environment or GrowthBook dynamic config. It sends:

- `Content-Type: application/json`
- `User-Agent: claude-code/<version>`
- `x-service-name: claude-code`
- auth headers when trust is established and a non-expired profile-scoped OAuth token is available; it can retry unauthenticated on 401.

Failed 1P events are written as JSONL under `${CLAUDE_CONFIG_DIR}/telemetry` with filenames keyed by `sessionId` and a per-process batch UUID. The exporter retries with backoff and eventually drops events after max attempts.

1P event payloads contain:

- event id/name/timestamp
- device id (`getOrCreateUserID()`)
- email from OAuth user metadata when available
- account/org auth metadata
- session id
- model, user type, entrypoint, client type, interactive flag
- platform/arch/node version/terminal/runtime/package managers/VCS/GitHub Actions metadata
- process metrics encoded as base64 JSON
- additional event metadata

GrowthBook experiment events separately include device id, session id, account/org UUIDs, variation id, and serialized user attributes.

Evidence: `src/services/analytics/firstPartyEventLogger.ts:130-230`, `src/services/analytics/firstPartyEventLogger.ts:255-389`, `src/services/analytics/firstPartyEventLoggingExporter.ts:37-72`, `src/services/analytics/firstPartyEventLoggingExporter.ts:112-139`, `src/services/analytics/firstPartyEventLoggingExporter.ts:527-615`, `src/services/analytics/firstPartyEventLoggingExporter.ts:635-761`, `src/services/analytics/metadata.ts:685-743`, `src/services/analytics/metadata.ts:893-972`.

## GrowthBook

GrowthBook is enabled only when 1P event logging is enabled. User attributes sent to GrowthBook include:

- `id`: device id
- `sessionId`
- `deviceID`
- platform
- optional API base URL host for proxy deployments
- organization UUID
- account UUID
- user type
- subscription type
- rate limit tier
- first token time
- email
- app version
- GitHub Actions metadata

GrowthBook uses remote evaluation against `https://api.anthropic.com/` by default. It adds auth headers when workspace trust is established and auth is available. Its cache key attributes are `id` and `organizationUUID`, so feature cache identity is primarily device plus org, not every session.

Evidence: `src/services/analytics/growthbook.ts:420-485`, `src/services/analytics/growthbook.ts:490-560`, `src/services/analytics/growthbook.ts:620-663`.

## API Query, Success, Error, and Gateway Reporting

Claude Code logs `tengu_api_query`, `tengu_api_success`, and `tengu_api_error`.

Query events include model, message count, temperature, provider, build age, betas, permission mode, query source, query chain id/depth, thinking/effort mode, fast mode, previous request id, and selected Anthropic environment variables.

Success events include token counts, cache token counts, latency, attempts, request id, stop reason, estimated cost, noninteractive/print/TTY flags, gateway type if detected, permission mode, content lengths, and time since previous API call.

Error events include model, error string, status, classified error type, message count/tokens, duration, attempt, request id, client request id, fallback flags, prompt category, gateway type, query chain fields, and selected env metadata. Gateway detection is a best-effort classifier over response header prefixes and selected provider host suffixes, not a gateway bypass mechanism.

Evidence: `src/services/api/logging.ts:56-139`, `src/services/api/logging.ts:171-233`, `src/services/api/logging.ts:235-396`, `src/services/api/logging.ts:398-579`.

## Observed Device/User Fingerprinting Surfaces

Observed stable identity surfaces:

- `userID` in global config, created from 32 random bytes hex, used as device id.
- `sessionId` from bootstrap state, sent in headers, API metadata, analytics, and GrowthBook.
- OAuth `accountUuid`, `organizationUuid`, and email where profile scope/auth state allows.
- HTTP User-Agent strings: `claude-cli/<version> (...)` for API calls and `claude-code/<version>` for some service calls.
- `x-client-request-id` per first-party request.
- optional remote/container/session headers.
- per-request Claude Code attribution fingerprint in a system prompt billing header.
- optional trusted-device token for remote-control sessions.

What was not found in the reviewed core auth/inference path:

- No evidence of browser cookie reuse by the CLI after OAuth completion.
- No evidence that the CLI computes a browser fingerprint for normal `/v1/messages` calls.
- No evidence that the CLI tries to mimic Chrome TLS/browser fingerprints for normal inference calls. A voice STT path comments on Cloudflare TLS fingerprinting, but that is separate from the reviewed Claude.ai OAuth inference path.

The term "fingerprint" appears in multiple unrelated contexts. The important one for inference is the 3-character attribution fingerprint derived from first user message characters and version. Gateway "fingerprints" are response-header classifiers. Neither is a stable device/browser fingerprint.

Evidence: `src/utils/config.ts:183-197`, `src/utils/user.ts:30-47`, `src/utils/user.ts:78-127`, `src/services/api/claude.ts:503-528`, `src/services/api/client.ts:105-116`, `src/utils/fingerprint.ts:40-76`, `src/constants/system.ts:59-95`, `src/services/api/logging.ts:56-139`.

## NPM Package Probe

The installed npm package is the current distribution artifact used for local verification. It is not the historical source tree. Package facts:

- wrapper package: `@anthropic-ai/claude-code@2.1.185`
- native package on this machine: `@anthropic-ai/claude-code-darwin-arm64@2.1.185`
- binary path: `node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- version command: `node_modules/.bin/claude --version` -> `2.1.185 (Claude Code)`
- repeatable probe command: `npm run probe:claude-code`

The package layout confirms that the public npm artifact is mainly a platform binary. The wrapper `install.cjs` copies or hardlinks the matching optional platform package binary into `bin/claude.exe`; `cli-wrapper.cjs` is only a fallback launcher.

String-level probe results from the native binary confirm the latest npm artifact still contains the same major auth and identity markers as the reviewed source baseline. `npm run probe:claude-code` fails when required markers are missing:

- OAuth scopes and beta: `oauth-2025-04-20`, `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`.
- OAuth endpoints/env: `https://claude.com/cai/oauth/authorize`, `https://platform.claude.com/v1/oauth/token`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`.
- Token storage markers: `.credentials.json`, `claudeAiOauth`.
- Request identity markers: `X-Claude-Code-Session-Id`, `x-client-request-id`, `x-anthropic-billing-header: cc_version=`, `59cf53e54c78`.
- Quota and service endpoints: `anthropic-ratelimit-unified-status`, `/api/oauth/usage`, `/api/claude_cli/bootstrap`, `/api/auth/trusted_devices`.
- Telemetry controls and sink markers: `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`.

The latest local run returned `missingRequiredMarkers: []`.

This probe does not prove exact control flow, because the npm package is compiled/minified/native. It does confirm that the current package still carries the core data formats, endpoint names, env controls, and identity headers identified from the reference source. Future compatibility work should keep using the npm binary as a spike target for changed strings, command behavior, and network-capture validation.

## Implications for claude-mgr

Design implications for our service:

- Model accounts explicitly. Claude Code has a singleton-ish local token model; `claude-mgr` needs first-class `account`, `account_pool`, and `client_token` records because the user wants several owned Claude.ai accounts and pool-based routing.
- Store auth/account state in our database. The reference source is a data-flow and wire-format baseline, not a storage design to copy. `claude-mgr` should persist configured accounts, account pools, client tokens, selected upstream account, OAuth scopes, expiry, subscription/rate-limit metadata, stable per-account device/session identity, refresh state, and audit indexes in the project database.
- Store OAuth credentials as plaintext in SQLite for the MVP. This is an explicit single-owner/local-auditability decision: access tokens, refresh tokens, account metadata, and related auth state are directly inspectable in the database, with no encryption layer, keychain integration, or external secret store.
- Keep upstream identity stable per upstream Claude.ai account. For each configured Claude.ai account, preserve a stable device id/session lineage and account-specific token/quota/audit records. Do not mix account UUIDs, refresh tokens, quota state, or analytics-derived identity across accounts.
- Do not treat this as multi-tenant isolation. The MVP should be single-owner, multi-account, with local auditability and clear account/pool routing.
- Separate local audit from upstream telemetry. Our own audit log should record request routing, selected account, gateway/proxy errors, upstream request id/client request id, token refresh events, and quota headers locally. It should not invent or forward extra telemetry beyond what Claude Code already sends unless explicitly needed.
- Preserve upstream error semantics. Gateway-originated errors should be surfaced as gateway errors with status/body/request ids where available, instead of being normalized into generic Anthropic failures.
- Implement refresh locking per account. Claude Code's lock is process/global. `claude-mgr` should lock by account id so unrelated accounts can refresh independently while avoiding concurrent refresh races for the same account.
- Treat profile-scoped and inference-only credentials differently. Endpoints such as usage, bootstrap, GrowthBook, and 1P event auth are gated on `user:profile`; inference-only env/FD tokens cannot be assumed to work there.
- Avoid browser/device fingerprint spoofing as a feature. The source baseline supports stable CLI identity through device id, session id, User-Agent, account UUID, and attribution header. Any future compatibility work should be source-driven and auditable, not an attempt to impersonate arbitrary browser state.

## Open Questions for Later Spike

- Confirm the exact current wire body for `/v1/messages` from a controlled dry-run/proxy capture, especially whether the system prompt billing header appears exactly as constructed.
- Decide SQLite database path, file permission defaults, backup policy, and manual token rotation workflow.
- Decide whether `claude-mgr` should forward Claude Code analytics surfaces at all, or stay inference-only for the MVP and keep audit local.
