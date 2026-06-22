import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import type { Context, Hono } from 'hono'
import { notFoundResponse } from '../responses.js'

function adminAssetResponse(url: URL, method: string): Response | null {
  if (method !== 'GET' && method !== 'HEAD') return null

  if (url.pathname === '/' || url.pathname === '/admin') {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/' },
    })
  }

  if (!url.pathname.startsWith('/admin/')) return null

  const contentTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }
  const assetRoot = join(process.cwd(), 'public/admin')
  const rawAssetPath =
    url.pathname === '/admin/'
      ? 'index.html'
      : decodeURIComponent(url.pathname.slice('/admin/'.length))
  const normalizedAssetPath = normalize(rawAssetPath)
  if (
    normalizedAssetPath.startsWith('..') ||
    isAbsolute(normalizedAssetPath)
  ) {
    return null
  }
  const filePath = join(assetRoot, normalizedAssetPath)
  if (relative(assetRoot, filePath).startsWith('..') || !existsSync(filePath)) {
    return null
  }
  const extension = normalizedAssetPath.match(/\.[^.]+$/)?.[0] ?? '.html'

  const body = method === 'HEAD' ? null : readFileSync(filePath)
  return new Response(body, {
    headers: {
      'Content-Type':
        contentTypes[extension] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  })
}

function handleStaticAdmin(c: Context): Response {
  return adminAssetResponse(new URL(c.req.raw.url), c.req.method) ?? notFoundResponse()
}

export function registerStaticAdminRoutes(app: Hono): void {
  app.get('/', handleStaticAdmin)
  app.on('HEAD', '/', handleStaticAdmin)
  app.get('/admin', handleStaticAdmin)
  app.on('HEAD', '/admin', handleStaticAdmin)
  app.get('/admin/*', handleStaticAdmin)
  app.on('HEAD', '/admin/*', handleStaticAdmin)
}
