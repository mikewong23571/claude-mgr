# Auth And User Management Plan

## 1. Result

Add local application users in four stages:

1. Protect the admin surface with a local owner login.
2. Protect Claude Code-compatible runtime entrypoints with local client secrets.
3. Add local user management and basic RBAC.
4. Add resource ownership and visibility isolation only if multi-user sharing is
   needed.

The new user model is local to `claude-mgr`. It is not the same thing as a
Claude.ai account.

Existing concepts keep their current meaning:

1. `claude_accounts`: upstream Claude.ai accounts discovered from OAuth profile.
2. `oauth_tokens`: Claude.ai OAuth credentials.
3. `local_clients`: local Claude Code-compatible clients.
4. `account_pools`: local routing pools.
5. `app_users`: new local users who can sign in to the admin console.

Do not convert `claude_accounts` into application users.

## 2. Route Protection Model

| Route | Protection |
| --- | --- |
| `GET /health` | Public. |
| `/admin/*` read routes | Local app user session. |
| `/admin/*` write routes | Local app user session plus role permission. |
| `GET /oauth/authorize` | Local app user session plus `owner` or `admin` permission. |
| `GET /callback` and `GET /oauth/callback` | OAuth pending `state` plus PKCE verifier; not ordinary session alone. |
| `POST /oauth/callback` | Local app user session plus matching OAuth pending `state`. |
| `POST /v1/messages` | Local client secret; not browser session. |
| Claude Code service and proxy endpoints | Local client secret. |

The OAuth callback can be protected without breaking Claude login. The callback
request from Claude may not carry a useful admin session, so the security
boundary is the server-side pending OAuth login:

1. A logged-in admin creates the pending login at `GET /oauth/authorize`.
2. The server stores a high-entropy `state`, PKCE `code_verifier`, expiry, and
   initiating local user id.
3. Claude redirects back with `code` and `state`.
4. The callback succeeds only if the `state` is known, unexpired, and unconsumed.
5. The server consumes the `state` before returning success.

If the callback request also has a local session, the session user must match
the pending login's initiating user. If it does not match, reject the callback.

## 3. Phase 0: Spike And Design Confirmation

### Goal

Reduce uncertainty before changing authentication behavior.

### Tasks

1. Verify Hono cookie/session middleware shape.
2. Verify frontend login-state restoration and 401 handling in Vite/React.
3. Verify how Claude Code sends `ANTHROPIC_API_KEY`, `Authorization`,
   `x-api-key`, and `ANTHROPIC_CUSTOM_HEADERS` to this gateway.
4. Verify whether OAuth browser callbacks usually carry the admin cookie, while
   keeping the final design independent of that assumption.
5. Decide whether local client secrets use `Authorization: Bearer <secret>`,
   `x-api-key`, or both.
6. Decide the first owner bootstrap mechanism.

### Deliverables

1. A short spike note in this document or a follow-up doc section.
2. Final choices for session cookie name, expiry, and CSRF handling.
3. Final choice for local client secret header support.
4. Final owner bootstrap behavior.

## 4. Phase 1: Local Owner Login

### Goal

Protect the admin console and admin APIs without introducing full multi-tenant
resource isolation.

### Data Model

Add:

```text
app_users
  id TEXT PRIMARY KEY
  username TEXT NOT NULL UNIQUE
  display_name TEXT
  role TEXT NOT NULL
  enabled INTEGER NOT NULL
  created_at INTEGER NOT NULL
  updated_at INTEGER NOT NULL

password_credentials
  user_id TEXT PRIMARY KEY
  password_hash TEXT NOT NULL
  updated_at INTEGER NOT NULL

user_sessions
  id TEXT PRIMARY KEY
  user_id TEXT NOT NULL
  session_hash TEXT NOT NULL UNIQUE
  expires_at INTEGER NOT NULL
  created_at INTEGER NOT NULL
  last_seen_at INTEGER

pending_oauth_logins
  state TEXT PRIMARY KEY
  code_verifier TEXT NOT NULL
  redirect_uri TEXT NOT NULL
  label TEXT NOT NULL
  source_device TEXT NOT NULL
  pool_id TEXT
  initiated_by_user_id TEXT NOT NULL
  expires_at INTEGER NOT NULL
  consumed_at INTEGER
  created_at INTEGER NOT NULL
```

Store only password hashes and session token hashes. Do not store plaintext
passwords or plaintext session tokens.

### Modules

Add focused modules:

```text
src/auth/password.ts
src/auth/session.ts
src/auth/permissions.ts
src/http/routes/auth.ts
```

Keep SQLite access behind `SqliteStore` methods.

### API

Add:

```text
POST /auth/login
POST /auth/logout
GET  /auth/me
POST /auth/change-password
```

### Bootstrap

Do not add public signup.

Prefer one of these:

1. Environment-driven bootstrap with `CLAUDE_MGR_BOOTSTRAP_OWNER` and
   `CLAUDE_MGR_BOOTSTRAP_PASSWORD`.
2. A local script such as `npm run bootstrap:owner`.

If the database has no `app_users`, the admin UI may show a bootstrap state, but
the server should still avoid unauthenticated remote user creation by default.

### OAuth Changes

`GET /oauth/authorize`:

1. Require a logged-in `owner` or `admin`.
2. Create `pending_oauth_logins`.
3. Return the Claude authorize URL.

`GET /callback` and `GET /oauth/callback`:

1. Require `code` and `state`.
2. Look up pending state.
3. Reject missing, expired, consumed, or mismatched state.
4. Exchange the code with the pending PKCE verifier.
5. Install the token and account.
6. Associate the installed token/account with `initiated_by_user_id` once
   ownership fields exist.
7. Mark the pending login consumed.

`POST /oauth/callback`:

1. Require a local app user session.
2. Require a matching pending state.
3. Require session user id to match `initiated_by_user_id`.

### Frontend

1. Add a login screen.
2. Load `/auth/me` before showing the admin console.
3. Send users to login on 401.
4. Add logout.
5. Add change-password entry for the current user.

### Tests

1. Unauthenticated `/admin/accounts` returns 401.
2. Login then `/admin/accounts` succeeds.
3. Disabled user cannot log in.
4. Expired session fails.
5. OAuth callback with unknown state fails.
6. OAuth callback replay fails.
7. OAuth callback with expired state fails.
8. Valid OAuth callback still installs account and token.

## 5. Phase 2: Local Client Authentication

### Goal

Protect `/v1/messages` and Claude Code-compatible service/proxy entrypoints
without using browser sessions for runtime inference traffic.

### Data Model

Add:

```text
local_client_tokens
  id TEXT PRIMARY KEY
  client_id TEXT NOT NULL
  name TEXT NOT NULL
  token_hash TEXT NOT NULL UNIQUE
  created_by_user_id TEXT
  created_at INTEGER NOT NULL
  last_used_at INTEGER
  revoked_at INTEGER
```

The plaintext local client secret is returned only once at creation time.

### Runtime Authentication

For `/v1/messages`:

1. Continue reading `x-claude-mgr-client-id`.
2. Read the local client secret from the chosen header.
3. Hash the presented secret.
4. Match it against `local_client_tokens`.
5. Reject missing, wrong, revoked, or disabled credentials.
6. Update `last_used_at`.
7. Continue into the existing account router.

Recommended setup:

```text
ANTHROPIC_API_KEY=<local-client-secret>
ANTHROPIC_CUSTOM_HEADERS=x-claude-mgr-client-id: <client-id>
```

If compatibility requires it, also support `x-api-key: <secret>`.

### Admin API

Add:

```text
POST   /admin/clients/:clientId/tokens
GET    /admin/clients/:clientId/tokens
DELETE /admin/clients/:clientId/tokens/:tokenId
```

The list endpoint returns metadata only.

### Frontend

1. Add local client token creation to the Local Clients page.
2. Show plaintext secret exactly once after creation.
3. Add token revoke.
4. Update Claude Code setup examples.

### Tests

1. `/v1/messages` without secret returns 401.
2. `/v1/messages` with wrong secret returns 401.
3. Revoked token returns 401.
4. Disabled client returns 401.
5. Token plaintext does not appear in list APIs.
6. Token plaintext does not appear in audit or debug traffic.

## 6. Phase 3: User Management And Basic RBAC

### Goal

Let the local owner manage local users and roles while keeping the project a
personal/local gateway rather than a full SaaS multi-tenant product.

### Roles

Use three roles:

```text
owner
admin
viewer
```

Permissions:

| Capability | owner | admin | viewer |
| --- | --- | --- | --- |
| View dashboard | Yes | Yes | Yes |
| View accounts, tokens, audit, quota | Yes | Yes | Yes |
| Start Claude OAuth | Yes | Yes | No |
| Manage pools | Yes | Yes | No |
| Manage local clients | Yes | Yes | No |
| Create or revoke local client secrets | Yes | Yes | No |
| Manage users | Yes | No | No |
| Change own password | Yes | Yes | Yes |

### Admin API

Add:

```text
GET  /admin/users
POST /admin/users
PATCH /admin/users/:userId
POST /admin/users/:userId/reset-password
POST /admin/users/:userId/disable
```

### Rules

1. Do not allow disabling the last enabled owner.
2. Do not allow deleting the last enabled owner.
3. `admin` cannot modify `owner` users.
4. `viewer` cannot call write routes.
5. Disabled users fail on the next authenticated request.

### Frontend

1. Add Users page.
2. Add create user.
3. Add role change.
4. Add disable user.
5. Add reset password.
6. Show current user and role in the console shell.

### Tests

1. Owner can create admin and viewer users.
2. Admin cannot manage users.
3. Viewer write routes return 403.
4. Last enabled owner cannot be disabled.
5. Disabled user sessions stop working.

## 7. Phase 4: Resource Ownership And Visibility Isolation

### Goal

Add resource visibility boundaries if multiple local users will share the same
gateway. This phase should be its own implementation effort.

### Ownership Model

Start with simple owner fields:

```text
claude_accounts.owner_user_id
oauth_tokens.owner_user_id
account_pools.owner_user_id
local_clients.owner_user_id
```

Only introduce a generic membership table if resource sharing becomes necessary:

```text
resource_memberships
  resource_type TEXT NOT NULL
  resource_id TEXT NOT NULL
  user_id TEXT NOT NULL
  permission TEXT NOT NULL
```

### Query Rules

1. Store list methods accept a current-user or visibility scope parameter.
2. Non-owner users see only owned or shared resources.
3. Owner users can view and manage all local resources.
4. Audit and quota queries filter through visible accounts and clients.
5. Adding a pool member must verify both the pool and account are visible and
   compatible for the acting user.

### OAuth Ownership

1. `pending_oauth_logins.initiated_by_user_id` becomes the owner for installed
   accounts and tokens.
2. If an OAuth flow adds the account to a pool, the pool must belong to or be
   writable by the initiating user.

### Runtime Ownership

`/v1/messages` does not use app user sessions. It uses local client
authentication:

1. The local client token identifies a `local_clients` row.
2. The client controls which pool/account the router may use.
3. The router must not select accounts outside the client's allowed visibility.

### Tests

1. User A cannot see User B's clients or tokens.
2. User A cannot add an account to User B's pool.
3. User A's local client cannot route to User B's Claude account.
4. Audit and quota views only include visible resources.
5. Owner can view all resources.

## 8. Migration Strategy

1. Add new tables with `CREATE TABLE IF NOT EXISTS`.
2. Keep existing `claude_accounts`, `oauth_tokens`, `account_pools`, and
   `local_clients` behavior unchanged through Phase 3.
3. If there are no app users, enter bootstrap mode.
4. Do not assign ownership fields until Phase 4.
5. In Phase 4, for an existing single-owner database, assign all existing
   resources to the owner.
6. For an existing database with multiple local users, require explicit owner
   assignment in the admin UI before enabling visibility filtering.

## 9. Documentation Updates

Update these docs as implementation lands:

1. `docs/local-api.md`
2. `docs/module-boundaries.md`
3. `docs/frontend-user-stories.md`
4. `AGENTS.md`, only for durable future-agent rules

The documentation must keep these distinctions explicit:

1. App users are local admin users.
2. Claude accounts are upstream OAuth identities.
3. OAuth callback protection is pending-state based.
4. Runtime inference uses local client secrets, not browser sessions.
5. Local users, pool ids, client ids, token labels, and ownership metadata are
   not sent upstream.

## 10. Suggested PR Split

1. Design doc and spike notes.
2. Auth schema, session model, login/logout/me, and admin route guard.
3. Persistent OAuth pending state and callback hardening.
4. Frontend login and session handling.
5. Local client tokens and `/v1/messages` protection.
6. User management API and RBAC.
7. User management UI.
8. Resource ownership migration design.
9. Resource visibility filtering and routing isolation.

This split keeps each change reviewable and avoids mixing login, OAuth safety,
runtime client authentication, and multi-user resource isolation in one large
change.
