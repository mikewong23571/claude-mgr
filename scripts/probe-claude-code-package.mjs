#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resolvePackage(packageName) {
  const packagePath = join(repoRoot, 'node_modules', ...packageName.split('/'))
  const manifestPath = join(packagePath, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`Package is not installed: ${packageName}`)
  }
  return {
    packagePath,
    manifest: readJson(manifestPath),
  }
}

function resolveClaudeBinary(wrapperPath) {
  const binaryPath = join(wrapperPath, 'bin', 'claude.exe')
  if (!existsSync(binaryPath)) {
    throw new Error(`Claude binary was not found: ${binaryPath}`)
  }
  return binaryPath
}

function runClaudeVersion() {
  return execFileSync(join(repoRoot, 'node_modules', '.bin', 'claude'), [
    '--version',
  ])
    .toString('utf8')
    .trim()
}

function probeBinary(binaryPath, markers) {
  const binary = readFileSync(binaryPath)
  const results = {}
  for (const marker of markers) {
    results[marker] = binary.includes(marker)
  }
  return results
}

const wrapper = resolvePackage('@anthropic-ai/claude-code')
const nativePackageName =
  process.platform === 'darwin'
    ? `@anthropic-ai/claude-code-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'linux'
      ? `@anthropic-ai/claude-code-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : process.platform === 'win32'
        ? `@anthropic-ai/claude-code-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
        : null

if (!nativePackageName) {
  throw new Error(`Unsupported platform for probe: ${process.platform}/${process.arch}`)
}

const nativePackage = resolvePackage(nativePackageName)
const binaryPath = resolveClaudeBinary(wrapper.packagePath)
const realBinaryPath = realpathSync(binaryPath)
const version = runClaudeVersion()

const requiredMarkers = [
  'oauth-2025-04-20',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'https://claude.com/cai/oauth/authorize',
  'https://platform.claude.com/v1/oauth/token',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  '.credentials.json',
  'claudeAiOauth',
  'X-Claude-Code-Session-Id',
  'x-client-request-id',
  'x-anthropic-billing-header: cc_version=',
  'anthropic-ratelimit-unified-status',
  '/api/oauth/usage',
  '/api/claude_cli/bootstrap',
]

const optionalMarkers = [
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
]

const markerResults = {
  ...probeBinary(realBinaryPath, requiredMarkers),
  ...probeBinary(realBinaryPath, optionalMarkers),
}
const missingRequiredMarkers = requiredMarkers.filter(marker => !markerResults[marker])

const result = {
  wrapperPackage: {
    name: wrapper.manifest.name,
    version: wrapper.manifest.version,
  },
  nativePackage: {
    name: nativePackage.manifest.name,
    version: nativePackage.manifest.version,
  },
  binaryPath,
  realBinaryPath,
  version,
  requiredMarkers,
  optionalMarkers,
  missingRequiredMarkers,
  markerResults,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

if (missingRequiredMarkers.length > 0) {
  process.exitCode = 1
}
