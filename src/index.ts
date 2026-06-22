import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { hashPassword } from './auth/password.js'
import { ApiProxyGateway } from './api-proxy/gateway.js'
import { ensureDefaultOwnerResources } from './bootstrap/default-resources.js'
import {
  JsonlDebugTrafficRecorder,
  createDebugTrafficRecorderFromEnv,
} from './debug/traffic-recorder.js'
import { ClaudeCliGateway } from './claude-cli/gateway.js'
import { MessagesGateway } from './messages/gateway.js'
import { TokenRefresher } from './oauth/token-refresher.js'
import { SqliteStore } from './storage/sqlite-store.js'
import { createNodeServer } from './http/server.js'
import { ApiProxyClient } from './upstream/api-proxy-client.js'
import { UpstreamClaudeCliClient } from './upstream/claude-cli-client.js'
import { UpstreamMessagesClient } from './upstream/messages-client.js'

export type RuntimeStorage = 'sqlite'

export type ProjectRuntimeDecision = {
  language: 'typescript'
  storage: RuntimeStorage
  referenceSource: 'git-submodule'
}

export const runtimeDecision: ProjectRuntimeDecision = {
  language: 'typescript',
  storage: 'sqlite',
  referenceSource: 'git-submodule',
}

export function startServer(input: {
  databasePath?: string
  port?: number
  host?: string
  debugTrafficDir?: string
} = {}) {
  const databasePath =
    input.databasePath ??
    process.env.CLAUDE_MGR_DB ??
    resolve(process.cwd(), 'data/claude-mgr.sqlite')
  const port = input.port ?? Number(process.env.PORT ?? 8787)
  const host = input.host ?? process.env.HOST ?? '127.0.0.1'
  const store = SqliteStore.open(databasePath)
  store.initialize()
  const bootstrapOwner = process.env.CLAUDE_MGR_BOOTSTRAP_OWNER
  const bootstrapPassword = process.env.CLAUDE_MGR_BOOTSTRAP_PASSWORD
  if (store.listAppUsers().length === 0 && bootstrapOwner && bootstrapPassword) {
    const user = store.createAppUser({
      id: randomUUID(),
      username: bootstrapOwner,
      role: 'owner',
      enabled: true,
    })
    store.upsertPasswordCredential({
      userId: user.id,
      passwordHash: hashPassword(bootstrapPassword),
    })
  }
  ensureDefaultOwnerResources(store)
  const debugRecorder = input.debugTrafficDir
    ? new JsonlDebugTrafficRecorder(input.debugTrafficDir)
    : createDebugTrafficRecorderFromEnv()
  const tokenRefresher = new TokenRefresher(store)
  const server = createNodeServer({
    gateway: new MessagesGateway({
      store,
      tokenRefresher,
      upstream: new UpstreamMessagesClient({ debugRecorder }),
    }),
    claudeCliGateway: new ClaudeCliGateway({
      store,
      tokenRefresher,
      upstream: new UpstreamClaudeCliClient({ debugRecorder }),
    }),
    apiProxyGateway: new ApiProxyGateway({
      store,
      upstream: new ApiProxyClient({ debugRecorder }),
    }),
    store,
    debugRecorder,
  })
  server.listen(port, host)
  return { server, store, url: `http://${host}:${port}` }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = startServer()
  console.log(`claude-mgr listening on ${url}`)
}
