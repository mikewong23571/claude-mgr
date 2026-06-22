# AGENTS.md

## Purpose

This repository implements `claude-mgr`, a personal Claude Code OAuth gateway.
It lets the owner route local Claude Code-compatible clients through a local,
auditable TypeScript service while reusing Claude.ai subscription OAuth
credentials obtained through the Claude Code OAuth flow.

The service is not a multi-tenant product. It is a local/personal gateway for
the repository owner.

## How This AGENTS.md Is Designed

Treat this file as the operational contract for coding agents:

1. Keep it short enough to read before touching code.
2. Put durable project rules here, not transient task notes.
3. Link to detailed docs instead of duplicating every design detail.
4. Prefer executable checks and repository tests over review-only guidance.
5. Record constraints that prevent expensive mistakes, especially around
   credentials, upstream protocol compatibility, and `repos/`.

If behavior changes, update this file only when the change affects how future
agents should work in the repository.

## Repository Boundary

Work in the current repository root:

```text
/Users/mike/projs/playground/claude-mgr
```

Do not implement project functionality inside `repos/`.

`repos/claude-code-analysis` is a git submodule and read-only reference
material. It exists to inspect Claude Code source behavior. Runtime code in
`src/` must not import or depend on files under `repos/`.

## Technology Choices

1. Runtime language: TypeScript.
2. Runtime HTTP layer: Hono route modules.
3. Runtime persistence: SQLite through `node:sqlite`.
4. OAuth token storage: plaintext SQLite by explicit project decision.
5. Runtime upstream calls: lightweight raw `fetch` adapters.
6. Admin UI: React + Ant Design + Vite under `frontend/`, served from the
   checked-in `public/admin/` build output.
7. Request validation: local schemas in `src/http/validation.ts`, currently
   implemented with Zod.
8. `@anthropic-ai/sdk`: allowed as a dev/spike/reference dependency, not the
   primary runtime abstraction unless the project direction changes.

Avoid adding new infrastructure or broad dependencies unless the existing
implementation cannot reasonably support the required behavior.

## Important Paths

```text
src/index.ts              runtime assembly and server startup
src/http/                 Hono app, route modules, responses, validation
src/auth/                 local app login, sessions, RBAC, and client secrets
src/oauth/                OAuth PKCE, token exchange, profile, refresh
src/messages/             Messages adaptation and gateway behavior
src/claude-cli/           Claude Code service endpoint gateway behavior
src/api-proxy/            narrow upstream proxy gateway behavior
src/upstream/             raw fetch clients for Anthropic/Claude endpoints
src/routing/              account, token, pool, and session selection
src/storage/              SQLite schema and store API
src/quota/                quota/rate-limit header parsing
src/audit/                audit usage extraction
src/debug/                sanitized local traffic recorder
src/domain/               shared runtime domain types
frontend/                 React/Ant Design admin UI source
public/admin/             Vite-built admin UI served by the local gateway
tests/                    Vitest coverage and executable governance checks
scripts/live-smoke.ts     live OAuth/profile/Messages/CLI smoke script
scripts/probe-claude-code-package.mjs
docs/                     design, policy, and verification evidence
repos/                    reference submodules only
data/                     local SQLite databases, ignored by git
```

Start with these docs for project context:

```text
README.md
docs/module-boundaries.md
docs/message-forwarding-policy.md
docs/local-api.md
docs/auth-and-user-management-plan.md
docs/frontend-user-stories.md
docs/hono-http-migration-plan.md
docs/story-acceptance-audit.md
docs/claude-code-auth-and-identity-source-review.md
docs/user-stories.md
```

## Core Product Rules

1. The gateway uses Claude Code OAuth credentials for Claude.ai subscriber
   access. It is not an Anthropic API-key gateway.
2. Multiple Claude.ai accounts are supported as account-level separation.
   Different accounts must not share the same upstream account identity.
3. Account pools are local routing controls. Pool ids, local client ids, token
   labels, and source device labels must not be sent upstream.
4. A Claude.ai account should expose one stable upstream client identity from
   this gateway. Do not create per-device upstream identities for the same
   account unless the design is deliberately changed and documented.
5. Do not bypass server limits, hide accounts, fake subscriptions, or forge
   browser/device fingerprints.
6. Upstream Anthropic errors and local gateway errors must remain
   distinguishable.
7. Prompt, completion, tool result, and file content are user content. They may
   be forwarded to Anthropic when required by Messages semantics, but must not
   be written to audit logs by default.
8. Local app users protect the admin console and OAuth initiation only. They
   are not Claude.ai accounts and must not be sent upstream.
9. Runtime Claude Code-compatible calls use local client secrets tied to
   `local_clients`, not browser sessions.

## Protocol Compatibility Rules

When changing OAuth, Messages, headers, metadata, streaming, quota, or error
behavior, use this evidence order:

1. Existing implementation and tests.
2. `repos/claude-code-analysis` source reference.
3. Installed Claude Code npm package probe or local spike.
4. Live smoke evidence against the real upstream.

Do not freely invent upstream headers, body fields, identity fields, or
telemetry.

Current important protocol facts:

1. OAuth authorize endpoint: `https://claude.com/cai/oauth/authorize`.
2. OAuth token endpoint: `https://platform.claude.com/v1/oauth/token`.
3. OAuth requests use `anthropic-beta: oauth-2025-04-20`.
4. Messages use `POST /v1/messages?beta=true`.
5. Messages include `anthropic-version: 2023-06-01`.
6. Downstream `betas` are converted to `anthropic-beta` and removed from the
   upstream JSON body.
7. `context_management` may appear in Claude Code requests, but current
   Claude.ai OAuth Messages upstream rejects it. The adapter accepts it from
   downstream and strips it before upstream forwarding.
8. `metadata.user_id`, `X-Claude-Code-Session-Id`, and
   `x-client-request-id` are generated by the gateway, not accepted from
   downstream clients.
9. Claude Code service GET endpoints currently live behind `src/claude-cli/`
   and `src/upstream/claude-cli-client.ts`; keep them separate from Messages
   adaptation.
10. Narrow proxy support currently lives behind `src/api-proxy/` and
    `src/upstream/api-proxy-client.ts`. Do not add proxy endpoints without
    source, package probe, or live-smoke evidence.
11. Traffic debug is local protocol evidence only. It must remain sanitized and
    must not log prompt, completion, tool result, file content, OAuth token, API
    key, or cookie values.

## Claude Code CLI Integration Notes

Claude Code 2.1.185 can be smoke-tested through the gateway with:

```bash
env \
  HOME="$(mktemp -d /tmp/claude-mgr-cc-home.XXXXXX)" \
  CLAUDE_CONFIG_DIR="$(mktemp -d /tmp/claude-mgr-cc-config.XXXXXX)" \
  ANTHROPIC_BASE_URL="http://localhost:8787" \
  ANTHROPIC_API_KEY="<local-client-secret>" \
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

Use temporary `HOME` and `CLAUDE_CONFIG_DIR` for tests. Do not delete or modify
the user's real `~/.claude` unless explicitly instructed.

`ANTHROPIC_CUSTOM_HEADERS` is newline-separated `Name: Value` text, not JSON.

## Credentials And Local Data

`data/*.sqlite` is ignored by git and may contain real OAuth access/refresh
tokens in plaintext.

Rules:

1. Never print access tokens or refresh tokens.
2. Do not commit SQLite databases.
3. Do not delete `data/live-smoke.sqlite` unless the user explicitly asks.
4. Admin token listing routes intentionally return token metadata only.
5. When inspecting SQLite manually, select only non-sensitive columns unless
   the user explicitly needs credential values.
6. Debug traffic files under `data/debug/` are local diagnostic artifacts. They
   should stay out of git and must remain structurally summarized and redacted.
7. Local app user passwords, session tokens, and local client secrets are stored
   as hashes. Client secret plaintext is returned only once at creation.

## Common Commands

Install dependencies:

```bash
npm install
```

Run the local server:

```bash
HOST=127.0.0.1 PORT=8787 CLAUDE_MGR_DB=data/claude-mgr.sqlite npm run dev
```

Bootstrap the first local owner when the database has no app users:

```bash
CLAUDE_MGR_BOOTSTRAP_OWNER=owner CLAUDE_MGR_BOOTSTRAP_PASSWORD='...' npm run dev
```

Run the admin UI dev server against a local gateway. The current Vite proxy
targets `127.0.0.1:8790`, so start the gateway on that port unless the Vite
config changes:

```bash
PORT=8790 CLAUDE_MGR_DB=data/claude-mgr.sqlite npm run dev
npm run dev:frontend
```

Build the checked-in admin UI assets:

```bash
npm run build:frontend
```

Required local checks before claiming a code change is ready:

```bash
npm run typecheck
npm test
npm run probe:claude-code
```

Dry-run smoke without OAuth callback:

```bash
npm run smoke:live -- --dry-run --host localhost
```

Live OAuth/profile smoke:

```bash
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite
```

Live Messages JSON and SSE smoke:

```bash
npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001
```

Live smoke consumes real Claude.ai account quota when `--messages` is used.

## Implementation Style

1. Keep changes small and reviewable.
2. Follow existing module boundaries.
3. Prefer explicit store methods over direct SQL outside `src/storage/`.
4. Prefer focused tests for compatibility and governance behavior.
5. Do not add abstractions just to make the current edit look generic.
6. Do not introduce encryption, Redis, multi-process coordination, or
   multi-user auth unless the user changes the MVP scope.
7. Preserve existing error namespaces: gateway errors use `gateway_*`;
   upstream errors preserve upstream type/message/request id.
8. Keep route registration in `src/http/app.ts` boring and explicit; new route
   families should have a matching focused module under `src/http/routes/` and
   domain behavior outside the HTTP layer.
9. If `frontend/` changes, run `npm run build:frontend` and keep
   `public/admin/` in sync because the server serves that directory directly.
10. Do not put runtime behavior in `public/admin/`; it is generated UI output,
    not a source module.

## Git And Generated Files

1. The repository may already be dirty. Do not revert changes you did not make.
2. Do not modify `repos/` internals.
3. Do not commit `node_modules/`, `data/`, temp files, logs, local Claude Code
   state, or debug traffic JSONL.
4. If staging or committing, inspect `git status --short` first and stage only
   the intended project files.
5. `public/admin/` is generated but currently tracked. Treat it as build output
   that must match `frontend/`, not as a place for manual edits.
