import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootDir = new URL('..', import.meta.url).pathname

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async entry => {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        return listFiles(fullPath)
      }
      return [fullPath]
    }),
  )
  return files.flat()
}

describe('repository governance', () => {
  it('keeps reference code as a git submodule', async () => {
    const gitmodules = await readFile(join(rootDir, '.gitmodules'), 'utf8')

    expect(gitmodules).toContain('path = repos/claude-code-analysis')
    expect(gitmodules).toContain(
      'url = https://github.com/liuup/claude-code-analysis.git',
    )
  })

  it('does not import runtime code from repos', async () => {
    const sourceFiles = await listFiles(join(rootDir, 'src'))
    const tsFiles = sourceFiles.filter(file => file.endsWith('.ts'))

    for (const file of tsFiles) {
      const content = await readFile(file, 'utf8')
      const relativePath = relative(rootDir, file)

      expect(
        content,
        `${relativePath} must not import reference code from repos/`,
      ).not.toMatch(/from\s+['"][^'"]*repos[/'"]/)
      expect(
        content,
        `${relativePath} must not import reference code from repos/`,
      ).not.toMatch(/import\s*\([^)]*['"][^'"]*repos[/'"]/)
    }
  })

  it('keeps generated runtime state out of git', async () => {
    const gitignore = await readFile(join(rootDir, '.gitignore'), 'utf8')

    for (const pattern of ['data/', 'dist/', 'coverage/', 'node_modules/']) {
      expect(gitignore).toContain(pattern)
    }
  })

  it('documents source-driven compatibility as a project constraint', async () => {
    const readme = await readFile(join(rootDir, 'README.md'), 'utf8')
    const moduleBoundaries = await readFile(
      join(rootDir, 'docs/module-boundaries.md'),
      'utf8',
    )

    for (const doc of [readme, moduleBoundaries]) {
      expect(doc).toContain('避免自由发挥')
      expect(doc).toContain('npm 包 spike')
      expect(doc).toContain('线上实测')
      expect(doc).toContain('OAuth 认证后的 Messages 交互')
    }
  })

  it('keeps Claude Code npm package probing executable', async () => {
    const packageJson = JSON.parse(
      await readFile(join(rootDir, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> }
    const probeScript = await readFile(
      join(rootDir, 'scripts/probe-claude-code-package.mjs'),
      'utf8',
    )

    expect(packageJson.devDependencies).toHaveProperty('@anthropic-ai/claude-code')
    expect(packageJson.scripts?.['probe:claude-code']).toBe(
      'node scripts/probe-claude-code-package.mjs',
    )
    for (const marker of [
      'oauth-2025-04-20',
      'user:inference',
      'X-Claude-Code-Session-Id',
      'x-client-request-id',
      'anthropic-ratelimit-unified-status',
    ]) {
      expect(probeScript).toContain(marker)
    }
  })

  it('keeps live upstream smoke executable and documented', async () => {
    const packageJson = JSON.parse(
      await readFile(join(rootDir, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const smokeScript = await readFile(
      join(rootDir, 'scripts/live-smoke.ts'),
      'utf8',
    )
    const readme = await readFile(join(rootDir, 'README.md'), 'utf8')
    const localApi = await readFile(join(rootDir, 'docs/local-api.md'), 'utf8')

    expect(packageJson.scripts?.['smoke:live']).toBe('tsx scripts/live-smoke.ts')
    for (const marker of [
      '/oauth/authorize',
      '/admin/clients',
      '/v1/messages',
      "host: 'localhost'",
      'assertOAuthProfileInstalled',
      'assertLatestMessageAudit',
      'smokeClaudeCodeCliMessages',
      'OAuth/profile evidence ok',
      'node_modules',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      '--dry-run',
      '--messages',
      '--model',
      '--debug-traffic',
      '--debug-dir',
    ]) {
      expect(smokeScript).toContain(marker)
    }
    expect(readme).toContain('npm run smoke:live')
    expect(localApi).toContain('npm run smoke:live')
    expect(localApi).toContain('会消耗对应 Claude.ai 账号额度')
  })

  it('keeps sanitized traffic debug mode documented and local-only', async () => {
    const recorder = await readFile(
      join(rootDir, 'src/debug/traffic-recorder.ts'),
      'utf8',
    )
    const readme = await readFile(join(rootDir, 'README.md'), 'utf8')
    const localApi = await readFile(join(rootDir, 'docs/local-api.md'), 'utf8')

    for (const marker of [
      'CLAUDE_MGR_DEBUG_TRAFFIC',
      'CLAUDE_MGR_DEBUG_DIR',
      'authorization',
      'x-api-key',
      '[redacted]',
      'bodySummary',
      'messageSummary',
    ]) {
      expect(recorder).toContain(marker)
    }
    expect(readme).toContain('data/debug/traffic-*.jsonl')
    expect(readme).toContain('不会写入 debug 文件')
    expect(localApi).toContain('Debug Traffic')
    expect(localApi).toContain('只记录结构摘要')
  })

  it('documents message forwarding and user-information boundaries', async () => {
    const policy = await readFile(
      join(rootDir, 'docs/message-forwarding-policy.md'),
      'utf8',
    )

    for (const section of [
      '应转发或重建后发送',
      '不应转发',
      '上游响应到下游响应',
      '用户信息分类',
      'MVP allowlist',
      'OAuth 认证后的 Messages 交互',
    ]) {
      expect(policy).toContain(section)
    }

    for (const localOnlyField of [
      'local client id',
      'account pool id/name',
      'token label',
      'source device',
    ]) {
      expect(policy).toContain(localOnlyField)
    }
  })

  it('documents MVP user stories for OAuth-backed Messages', async () => {
    const stories = await readFile(join(rootDir, 'docs/user-stories.md'), 'utf8')
    const acceptanceAudit = await readFile(
      join(rootDir, 'docs/story-acceptance-audit.md'),
      'utf8',
    )

    for (const section of [
      '一句话目标',
      '不变边界',
      'Story Map',
      'MVP 用户故事矩阵',
      '详细用户故事',
      '非 MVP 用户故事',
      'MVP 完成定义',
      '当前剩余缺口',
    ]) {
      expect(stories).toContain(section)
    }

    for (const section of [
      'Story Evidence Matrix',
      'Completion Gate',
      'live-proven',
      'H1 | live-proven',
      'H2 | live-proven',
      'H3 | live-proven',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(acceptanceAudit).toContain(section)
    }

    expect(stories).toContain('Claude Code OAuth 网关')
    expect(stories).toContain('SSE streaming Messages')
    expect(stories).toContain('gateway_no_eligible_account')
    expect(stories).toContain('gateway_no_eligible_token')
    expect(stories).toContain('H1 | 真实 OAuth/profile live smoke')
    expect(stories).toContain('H2 | 真实 Messages JSON live smoke')
    expect(stories).toContain('H3 | 真实 Messages SSE live smoke')
    expect(stories).toContain('默认不保存 prompt')
  })

  it('documents the implemented local HTTP API surface', async () => {
    const api = await readFile(join(rootDir, 'docs/local-api.md'), 'utf8')

    for (const route of [
      'GET /health',
      'GET /oauth/authorize',
      'POST /oauth/callback',
      'POST /admin/pools',
      'PATCH /admin/pools/{pool_id}',
      'POST /admin/pools/{pool_id}/members',
      'PATCH /admin/pools/{pool_id}/members/{account_uuid}',
      'POST /admin/clients',
      'PATCH /admin/clients/{client_id}',
      'DELETE /admin/clients/{client_id}',
      'GET /admin/accounts',
      'PATCH /admin/accounts/{account_uuid}',
      'DELETE /admin/tokens/{token_label}',
      'GET /admin/quota-snapshots',
      'POST /v1/messages',
    ]) {
      expect(api).toContain(route)
    }
    expect(api).toContain('text/event-stream')
    expect(api).toContain('gateway_*')
  })
})
