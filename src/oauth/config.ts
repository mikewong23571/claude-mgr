export const oauthBetaHeader = 'oauth-2025-04-20'

export const claudeAiOAuthScopes = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

export type OAuthConfig = {
  baseApiUrl: string
  authorizeUrl: string
  tokenUrl: string
  manualRedirectUrl: string
  clientId: string
}

export const prodOAuthConfig: OAuthConfig = {
  baseApiUrl: 'https://api.anthropic.com',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  manualRedirectUrl: 'https://platform.claude.com/oauth/code/callback',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
}
