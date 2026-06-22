import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  LinkOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  UserOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Divider,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd'
import type { TableColumnsType } from 'antd'
import enUS from 'antd/locale/en_US.js'
import zhCN from 'antd/locale/zh_CN.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, apiJson, loadAdminState, loadCurrentUser } from './api.js'
import { useText } from './i18n.js'
import type {
  Account,
  AdminState,
  AuthUser,
  AuditEvent,
  LocalClient,
  LocalClientTokenMeta,
  Locale,
  OAuthTokenMeta,
  Pool,
  PoolMember,
  QuotaSnapshot,
} from './types.js'

const { Content, Header, Sider } = Layout
const { Text, Title } = Typography
const localeStorageKey = 'claude-mgr.admin.locale'

type HealthState = {
  ok: boolean
  checkedAt: number | null
}

type OAuthFlow = 'callback' | 'manual'

type OAuthLoginState = {
  authorizeUrl: string
  flow: OAuthFlow
  state: string
}

type OAuthFlowStatus = 'pending' | 'success' | 'expired' | 'error'

const emptyState: AdminState = {
  accounts: [],
  pools: [],
  poolMembers: {},
  clients: [],
  tokens: [],
  auditEvents: [],
  quotaSnapshots: [],
}

function readInitialLocale(): Locale {
  return localStorage.getItem(localeStorageKey) === 'zh' ? 'zh' : 'en'
}

function formatTime(value: number | null | undefined, locale: Locale): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value))
}

function valueText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function statusTag(value: string | boolean, locale: Locale): React.ReactElement {
  const normalized = String(value)
  const success = value === true || ['enabled', 'success', 'allowed', 'ok'].includes(normalized)
  const warning = ['pending', 'interrupted'].includes(normalized)
  const label =
    value === true
      ? locale === 'zh'
        ? '已启用'
        : 'enabled'
      : value === false
        ? locale === 'zh'
          ? '已停用'
          : 'disabled'
        : normalized
  return (
    <Tag color={success ? 'success' : warning ? 'warning' : 'error'}>{label}</Tag>
  )
}

function parsePastedOAuthCode(value: string): { code: string; state?: string } {
  const trimmed = value.trim()
  if (!trimmed) return { code: '' }
  try {
    const url = new URL(trimmed)
    return {
      code: url.searchParams.get('code')?.trim() ?? '',
      state: url.searchParams.get('state')?.trim() || undefined,
    }
  } catch {
    const hashIndex = trimmed.indexOf('#')
    if (hashIndex > 0) {
      return {
        code: trimmed.slice(0, hashIndex).trim(),
        state: trimmed.slice(hashIndex + 1).trim() || undefined,
      }
    }
    return { code: trimmed }
  }
}

function useClipboardMessage() {
  const { message } = App.useApp()
  return useCallback(
    async (value: string) => {
      await navigator.clipboard.writeText(value)
      message.success('Copied')
    },
    [message],
  )
}

function AdminConsole(props: {
  currentUser: AuthUser
  locale: Locale
  setLocale: (locale: Locale) => void
  setCurrentUser: (user: AuthUser | null) => void
}) {
  const { currentUser, locale, setCurrentUser, setLocale } = props
  const [activeKey, setActiveKey] = useState('dashboard')
  const [health, setHealth] = useState<HealthState>({ ok: false, checkedAt: null })
  const [state, setState] = useState<AdminState>(emptyState)
  const [loading, setLoading] = useState(false)
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const t = useText(locale)
  const copyText = useClipboardMessage()
  const [poolForm] = Form.useForm()
  const [clientForm] = Form.useForm()
  const [oauthForm] = Form.useForm()
  const [oauthCompleteForm] = Form.useForm()
  const [setupForm] = Form.useForm()
  const setupValues = Form.useWatch([], setupForm) as
    | { baseUrl?: string; clientId?: string; poolId?: string; clientSecret?: string; model?: string }
    | undefined
  const [oauthLogin, setOAuthLogin] = useState<OAuthLoginState | null>(null)
  const [diagnostics, setDiagnostics] = useState<Array<{ label: string; ok: boolean }>>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [clientTokens, setClientTokens] = useState<LocalClientTokenMeta[]>([])
  const [selectedTokenClientId, setSelectedTokenClientId] = useState<string>()
  const [revealedClientSecret, setRevealedClientSecret] = useState('')
  const [oauthModalOpen, setOAuthModalOpen] = useState(false)
  const [oauthStatus, setOAuthStatus] = useState<OAuthFlowStatus>('pending')
  const oauthPopupRef = useRef<Window | null>(null)
  const [userForm] = Form.useForm()
  const [passwordForm] = Form.useForm()
  const [clientTokenForm] = Form.useForm()

  const refreshHealth = useCallback(async () => {
    try {
      await apiJson('/health')
      setHealth({ ok: true, checkedAt: Date.now() })
    } catch {
      setHealth({ ok: false, checkedAt: Date.now() })
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await refreshHealth()
      const next = await loadAdminState()
      setState(next)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null)
        return
      }
      message.error(error instanceof Error ? error.message : 'Refresh failed')
    } finally {
      setLoading(false)
    }
  }, [message, refreshHealth, setCurrentUser])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = locale === 'zh' ? 'Conduit · 网关控制台' : 'Conduit · Gateway Console'
    localStorage.setItem(localeStorageKey, locale)
  }, [locale])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (state.clients[0] && !setupForm.getFieldValue('clientId')) {
      setupForm.setFieldValue('clientId', state.clients[0].id)
    }
    if (state.clients[0] && !selectedTokenClientId) {
      setSelectedTokenClientId(state.clients[0].id)
    }
    if (state.pools[0] && !oauthForm.getFieldValue('poolId')) {
      oauthForm.setFieldsValue({
        label: oauthForm.getFieldValue('label') || 'default',
        sourceDevice: oauthForm.getFieldValue('sourceDevice') || 'local',
        poolId:
          state.pools.find(pool => pool.id === 'default')?.id ?? state.pools[0].id,
      })
    }
    setupForm.setFieldValue('baseUrl', window.location.origin)
  }, [oauthForm, selectedTokenClientId, setupForm, state.clients, state.pools])

  const refreshUsers = useCallback(async () => {
    if (currentUser.role !== 'owner') return
    setUsers(await apiJson<AuthUser[]>('/admin/users'))
  }, [currentUser.role])

  const refreshClientTokens = useCallback(async () => {
    if (!selectedTokenClientId) {
      setClientTokens([])
      return
    }
    setClientTokens(
      await apiJson<LocalClientTokenMeta[]>(
        `/admin/clients/${encodeURIComponent(selectedTokenClientId)}/tokens`,
      ),
    )
  }, [selectedTokenClientId])

  useEffect(() => {
    if (activeKey === 'users') void refreshUsers()
  }, [activeKey, refreshUsers])

  useEffect(() => {
    if (activeKey === 'clients') void refreshClientTokens()
  }, [activeKey, refreshClientTokens])

  const closeOAuthModal = useCallback(() => {
    oauthPopupRef.current?.close()
    oauthPopupRef.current = null
    setOAuthModalOpen(false)
    setOAuthLogin(null)
    setOAuthStatus('pending')
    oauthCompleteForm.resetFields()
  }, [oauthCompleteForm])

  const openOAuthPopup = useCallback((url: string) => {
    const popup = window.open(
      url,
      'claudeMgrOAuth',
      'popup=yes,width=960,height=760,noopener=false',
    )
    if (popup) {
      oauthPopupRef.current = popup
      popup.focus()
      return
    }
    message.warning(t('popupBlocked'))
  }, [message, t])

  useEffect(() => {
    if (
      !oauthLogin ||
      oauthLogin.flow !== 'callback' ||
      !oauthModalOpen ||
      oauthStatus !== 'pending'
    ) {
      return
    }
    const oauthState = oauthLogin.state
    let stopped = false
    async function pollOAuthStatus() {
      try {
        const response = await apiJson<{
          status: OAuthFlowStatus
          state: string
        }>(`/oauth/status?state=${encodeURIComponent(oauthState)}`)
        if (stopped) return
        if (response.status === 'success') {
          oauthPopupRef.current?.close()
          oauthPopupRef.current = null
          setOAuthStatus('success')
          setOAuthModalOpen(false)
          setOAuthLogin(null)
          message.success(t('loginSucceeded'))
          await refresh()
        } else if (response.status === 'expired') {
          setOAuthStatus('expired')
        }
      } catch (error) {
        if (stopped) return
        setOAuthStatus('error')
        message.error(error instanceof Error ? error.message : 'OAuth status check failed')
      }
    }
    void pollOAuthStatus()
    const interval = window.setInterval(() => void pollOAuthStatus(), 1500)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [message, oauthLogin, oauthModalOpen, oauthStatus, refresh, t])

  const poolOptions = useMemo(
    () => state.pools.map(pool => ({ label: pool.id, value: pool.id })),
    [state.pools],
  )
  const accountOptions = useMemo(
    () =>
      state.accounts.map(account => ({
        label: `${account.email ?? account.displayName ?? account.accountUuid} (${account.accountUuid})`,
        value: account.accountUuid,
      })),
    [state.accounts],
  )
  const clientOptions = useMemo(
    () => state.clients.map(client => ({ label: client.id, value: client.id })),
    [state.clients],
  )

  const accountName = useCallback(
    (accountUuid: string | null | undefined) => {
      if (!accountUuid) return '-'
      const account = state.accounts.find(item => item.accountUuid === accountUuid)
      return account
        ? `${account.email ?? account.displayName ?? account.accountUuid} (${account.accountUuid})`
        : accountUuid
    },
    [state.accounts],
  )

  async function toggleAccount(account: Account) {
    await apiJson(`/admin/accounts/${encodeURIComponent(account.accountUuid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !account.enabled }),
    })
    await refresh()
  }

  const actionColumn = <T extends object>(
    render: (record: T) => React.ReactElement,
    width = 150,
  ) => ({
    title: t('actions'),
    key: 'actions',
    width,
    fixed: 'right' as const,
    align: 'right' as const,
    render: (_: unknown, record: T) => (
      <Space className="table-actions" size={8}>
        {render(record)}
      </Space>
    ),
  })

  const accountColumns: TableColumnsType<Account> = [
    { title: t('email'), dataIndex: 'email', render: valueText },
    { title: t('displayName'), dataIndex: 'displayName', render: valueText },
    { title: 'UUID', dataIndex: 'accountUuid', render: value => <Text code>{value}</Text> },
    { title: t('subscription'), dataIndex: 'subscriptionType', render: valueText },
    { title: t('rateTier'), dataIndex: 'rateLimitTier', render: valueText },
    {
      title: t('status'),
      dataIndex: 'enabled',
      width: 110,
      render: enabled => statusTag(Boolean(enabled), locale),
    },
    actionColumn<Account>(account => (
      <Button size="small" onClick={() => void toggleAccount(account)}>
        {account.enabled ? t('disable') : t('enable')}
      </Button>
    ), 120),
  ]

  async function savePool(values: { id: string; name: string; purpose?: string }) {
    const exists = state.pools.some(pool => pool.id === values.id)
    await apiJson(exists ? `/admin/pools/${encodeURIComponent(values.id)}` : '/admin/pools', {
      method: exists ? 'PATCH' : 'POST',
      body: JSON.stringify({
        ...(exists ? {} : { id: values.id }),
        name: values.name,
        purpose: values.purpose || null,
      }),
    })
    poolForm.resetFields()
    await refresh()
  }

  async function saveClient(values: {
    id: string
    name: string
    enabled: boolean
    defaultPoolId?: string
  }) {
    const exists = state.clients.some(client => client.id === values.id)
    await apiJson(exists ? `/admin/clients/${encodeURIComponent(values.id)}` : '/admin/clients', {
      method: exists ? 'PATCH' : 'POST',
      body: JSON.stringify({
        ...(exists ? {} : { id: values.id }),
        name: values.name,
        enabled: values.enabled,
        default_pool_id: values.defaultPoolId || null,
      }),
    })
    clientForm.resetFields()
    clientForm.setFieldValue('enabled', true)
    await refresh()
  }

  async function startOAuth(values: {
    label: string
    sourceDevice: string
    poolId?: string
    flow?: OAuthFlow
  }) {
    const flow = values.flow ?? 'callback'
    const popup =
      flow === 'callback'
        ? window.open(
            'about:blank',
            'claudeMgrOAuth',
            'popup=yes,width=960,height=760,noopener=false',
          )
        : null
    if (popup) {
      oauthPopupRef.current = popup
    }
    const params = new URLSearchParams({
      label: values.label,
      source_device: values.sourceDevice,
    })
    if (flow !== 'callback') params.set('flow', flow)
    if (values.poolId) params.set('pool_id', values.poolId)
    try {
      const response = await apiJson<{
        authorize_url: string
        flow?: OAuthFlow
        redirect_uri?: string
        state: string
      }>(
        `/oauth/authorize?${params.toString()}`,
      )
      const nextLogin = {
        authorizeUrl: response.authorize_url,
        flow: response.flow ?? flow,
        state: response.state,
      }
      setOAuthLogin(nextLogin)
      setOAuthStatus('pending')
      setOAuthModalOpen(true)
      oauthCompleteForm.resetFields()
      if (nextLogin.flow === 'callback') {
        if (popup) {
          popup.location.href = nextLogin.authorizeUrl
          popup.focus()
        } else {
          message.warning(t('popupBlocked'))
        }
      }
    } catch (error) {
      popup?.close()
      oauthPopupRef.current = null
      message.error(error instanceof Error ? error.message : 'OAuth login failed')
    }
  }

  async function completeOAuth(values: { pastedCode: string }) {
    if (!oauthLogin) return
    const parsed = parsePastedOAuthCode(values.pastedCode)
    if (!parsed.code) {
      message.error('Missing authorization code')
      return
    }
    await apiJson('/oauth/callback', {
      method: 'POST',
      body: JSON.stringify({
        code: parsed.code,
        state: parsed.state ?? oauthLogin.state,
      }),
    })
    oauthPopupRef.current?.close()
    oauthPopupRef.current = null
    setOAuthLogin(null)
    setOAuthModalOpen(false)
    setOAuthStatus('success')
    oauthCompleteForm.resetFields()
    message.success(t('loginSucceeded'))
    await refresh()
  }

  async function createClientToken(values: { name: string }) {
    if (!selectedTokenClientId) return
    const response = await apiJson<{
      id: string
      clientId: string
      name: string
      secret: string
      createdAt: number
    }>(`/admin/clients/${encodeURIComponent(selectedTokenClientId)}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: values.name }),
    })
    setRevealedClientSecret(response.secret)
    setupForm.setFieldsValue({
      clientId: selectedTokenClientId,
      clientSecret: response.secret,
    })
    clientTokenForm.resetFields()
    await refreshClientTokens()
  }

  async function revokeClientToken(token: LocalClientTokenMeta) {
    await apiJson(
      `/admin/clients/${encodeURIComponent(token.clientId)}/tokens/${encodeURIComponent(token.id)}`,
      { method: 'DELETE' },
    )
    await refreshClientTokens()
  }

  async function deleteOAuthToken(token: OAuthTokenMeta) {
    await apiJson(`/admin/tokens/${encodeURIComponent(token.label)}`, {
      method: 'DELETE',
    })
    await refresh()
  }

  async function createUser(values: {
    username: string
    displayName?: string
    role: AuthUser['role']
    password: string
    enabled?: boolean
  }) {
    await apiJson('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: values.username,
        display_name: values.displayName || null,
        role: values.role,
        password: values.password,
        enabled: values.enabled,
      }),
    })
    userForm.resetFields()
    userForm.setFieldValue('enabled', true)
    await refreshUsers()
  }

  async function disableUser(user: AuthUser) {
    await apiJson(`/admin/users/${encodeURIComponent(user.id)}/disable`, {
      method: 'POST',
    })
    await refreshUsers()
  }

  async function changePassword(values: {
    currentPassword: string
    newPassword: string
  }) {
    await apiJson('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: values.currentPassword,
        new_password: values.newPassword,
      }),
    })
    passwordForm.resetFields()
    message.success(locale === 'zh' ? '密码已更新' : 'Password updated')
  }

  async function logout() {
    await apiJson('/auth/logout', { method: 'POST' }).catch(() => null)
    setCurrentUser(null)
  }

  const clientColumns: TableColumnsType<LocalClient> = [
    { title: t('clientId'), dataIndex: 'id', render: value => <Text code>{value}</Text> },
    { title: t('name'), dataIndex: 'name' },
    { title: t('defaultPool'), dataIndex: 'defaultPoolId', render: valueText },
    {
      title: t('status'),
      dataIndex: 'enabled',
      width: 110,
      render: enabled => statusTag(Boolean(enabled), locale),
    },
    actionColumn<LocalClient>(client => (
      <>
        <Button
          icon={<EditOutlined />}
          size="small"
          onClick={() =>
            clientForm.setFieldsValue({
              id: client.id,
              name: client.name,
              defaultPoolId: client.defaultPoolId ?? undefined,
              enabled: client.enabled,
            })
          }
        >
          {t('edit')}
        </Button>
        <Button
          size="small"
          onClick={async () => {
            await apiJson(`/admin/clients/${encodeURIComponent(client.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ enabled: !client.enabled }),
            })
            await refresh()
          }}
        >
          {client.enabled ? t('disable') : t('enable')}
        </Button>
        <Popconfirm
          title={`Delete ${client.id}?`}
          onConfirm={async () => {
            await apiJson(`/admin/clients/${encodeURIComponent(client.id)}`, {
              method: 'DELETE',
            })
            await refresh()
          }}
        >
          <Button danger icon={<DeleteOutlined />} size="small">
            {t('delete')}
          </Button>
        </Popconfirm>
      </>
    ), 250),
  ]

  const tokenColumns: TableColumnsType<OAuthTokenMeta> = [
    { title: t('tokenLabel'), dataIndex: 'label', render: value => <Text code>{value}</Text> },
    { title: t('sourceDevice'), dataIndex: 'sourceDevice' },
    { title: t('account'), dataIndex: 'accountUuid', render: accountName },
    { title: t('scopes'), dataIndex: 'scopes', render: scopes => (scopes as string[]).join(', ') },
    { title: t('expires'), dataIndex: 'expiresAt', render: value => formatTime(value as number | null, locale) },
    { title: t('lastUsed'), dataIndex: 'lastUsedAt', render: value => formatTime(value as number | null, locale) },
    actionColumn<OAuthTokenMeta>(token => (
      <Popconfirm
        title={locale === 'zh' ? `删除 token ${token.label}？` : `Delete token ${token.label}?`}
        onConfirm={() => void deleteOAuthToken(token)}
      >
        <Button danger icon={<DeleteOutlined />} size="small">
          {t('delete')}
        </Button>
      </Popconfirm>
    ), 120),
  ]

  const clientTokenColumns: TableColumnsType<LocalClientTokenMeta> = [
    { title: 'ID', dataIndex: 'id', render: value => <Text code>{value}</Text> },
    { title: t('name'), dataIndex: 'name' },
    { title: t('created'), dataIndex: 'createdAt', render: value => formatTime(value as number, locale) },
    { title: t('lastUsed'), dataIndex: 'lastUsedAt', render: value => formatTime(value as number | null, locale) },
    {
      title: t('status'),
      dataIndex: 'revokedAt',
      render: value =>
        value ? statusTag(locale === 'zh' ? '已撤销' : 'revoked', locale) : statusTag('enabled', locale),
    },
    actionColumn<LocalClientTokenMeta>(token => (
      <Popconfirm
        title={locale === 'zh' ? '撤销这个访问密钥？' : 'Revoke this access key?'}
        onConfirm={() => void revokeClientToken(token)}
      >
        <Button danger disabled={Boolean(token.revokedAt)} size="small">
          {locale === 'zh' ? '撤销' : 'Revoke'}
        </Button>
      </Popconfirm>
    ), 110),
  ]

  const userColumns: TableColumnsType<AuthUser> = [
    { title: locale === 'zh' ? '用户名' : 'Username', dataIndex: 'username' },
    { title: t('displayName'), dataIndex: 'displayName', render: valueText },
    { title: 'Role', dataIndex: 'role', render: value => <Tag>{String(value)}</Tag> },
    {
      title: t('status'),
      dataIndex: 'enabled',
      render: enabled => statusTag(Boolean(enabled), locale),
    },
    actionColumn<AuthUser>(user => (
      <Button
        danger
        disabled={!user.enabled}
        size="small"
        onClick={() => void disableUser(user)}
      >
        {t('disable')}
      </Button>
    ), 110),
  ]

  const auditColumns: TableColumnsType<AuditEvent> = [
    { title: t('created'), dataIndex: 'createdAt', render: value => formatTime(value as number, locale) },
    { title: t('client'), dataIndex: 'clientId', render: value => <Text code>{value}</Text> },
    { title: t('pool'), dataIndex: 'poolId', render: valueText },
    { title: t('account'), dataIndex: 'accountUuid', render: valueText },
    { title: t('token'), dataIndex: 'tokenLabel', render: valueText },
    { title: t('model'), dataIndex: 'model', render: valueText },
    { title: t('status'), dataIndex: 'status', render: value => statusTag(String(value), locale) },
    {
      title: t('errorSource'),
      dataIndex: 'errorType',
      render: value => {
        if (!value) return '-'
        return String(value).startsWith('gateway_') ? t('gateway') : t('upstream')
      },
    },
    { title: t('errorType'), dataIndex: 'errorType', render: valueText },
    { title: t('upstreamRequestId'), dataIndex: 'upstreamRequestId', render: valueText },
  ]

  const quotaColumns: TableColumnsType<QuotaSnapshot> = [
    { title: t('created'), dataIndex: 'createdAt', render: value => formatTime(value as number, locale) },
    { title: t('account'), dataIndex: 'accountUuid', render: value => <Text code>{value}</Text> },
    { title: t('token'), dataIndex: 'tokenLabel', render: valueText },
    { title: t('status'), dataIndex: 'status', render: value => statusTag(String(value), locale) },
    { title: t('rateLimit'), dataIndex: 'rateLimitType', render: valueText },
    { title: t('utilization'), dataIndex: 'utilization', align: 'right', render: valueText },
    { title: t('resets'), dataIndex: 'resetsAt', render: value => formatTime(value as number | null, locale) },
  ]

  const setupConfig = useMemo(() => {
    const baseUrl = setupValues?.baseUrl || window.location.origin
    const clientId = setupValues?.clientId || '<client-id>'
    const clientSecret = setupValues?.clientSecret || '<local-client-secret>'
    const model = setupValues?.model || 'claude-haiku-4-5-20251001'
    const headers = [`x-claude-mgr-client-id: ${clientId}`]
    if (setupValues?.poolId) {
      headers.push(`x-claude-mgr-pool-id: ${setupValues.poolId}`)
    }
    const customHeaders = headers.join('\n')
    const envBlock = `export ANTHROPIC_BASE_URL="${baseUrl}"
export ANTHROPIC_API_KEY="${clientSecret}"
export ANTHROPIC_CUSTOM_HEADERS=$'${headers.join('\\n')}'`
    const command = `${envBlock}
claude --bare --print --no-session-persistence --disable-slash-commands --model ${model} --output-format json "Respond with exactly OK and nothing else."`
    const settingsJson = JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: clientSecret,
          ANTHROPIC_CUSTOM_HEADERS: customHeaders,
        },
      },
      null,
      2,
    )
    return { command, customHeaders, envBlock, settingsJson }
  }, [setupValues])

  const tableProps = {
    size: 'middle' as const,
    pagination: false as const,
    scroll: { x: 'max-content' },
    locale: { emptyText: t('noData') },
  }

  async function runDiagnostics() {
    const checks = [
      [t('health'), '/health'],
      [t('pools'), '/admin/pools'],
      [t('accounts'), '/admin/accounts'],
      [t('clients'), '/admin/clients'],
      [t('audit'), '/admin/audit-events'],
      [t('quota'), '/admin/quota-snapshots'],
    ] as const
    const results = []
    for (const [label, path] of checks) {
      try {
        await apiJson(path)
        results.push({ label, ok: true })
      } catch {
        results.push({ label, ok: false })
      }
    }
    setDiagnostics(results)
  }

  function renderDashboard() {
    const errors = state.auditEvents.filter(
      event => event.status === 'error' || event.status === 'interrupted',
    ).length
    return (
      <div className="stack">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={6}>
            <Card>
              <Statistic title={t('accounts')} value={state.accounts.length} />
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card>
              <Statistic title={t('pools')} value={state.pools.length} />
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card>
              <Statistic title={t('clients')} value={state.clients.length} />
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card>
              <Statistic title={locale === 'zh' ? '近期错误' : 'Recent Errors'} value={errors} />
            </Card>
          </Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card title={locale === 'zh' ? '服务' : 'Service'}>
              <Descriptions column={1} size="small">
                <Descriptions.Item label={t('origin')}>{window.location.origin}</Descriptions.Item>
                <Descriptions.Item label={t('status')}>
                  {health.ok ? statusTag('ok', locale) : statusTag('error', locale)}
                </Descriptions.Item>
                <Descriptions.Item label={t('lastCheck')}>
                  {formatTime(health.checkedAt, locale)}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title={t('routing')}>
              {state.clients.length === 0 ? (
                <Text type="secondary">{t('noData')}</Text>
              ) : (
                <Space direction="vertical">
                  {state.clients.map(client => (
                    <Text key={client.id}>
                      <Text code>{client.id}</Text> -&gt; {client.defaultPoolId ?? '-'} (
                      {client.defaultPoolId
                        ? state.poolMembers[client.defaultPoolId]?.length ?? 0
                        : 0}
                      )
                    </Text>
                  ))}
                </Space>
              )}
            </Card>
          </Col>
        </Row>
      </div>
    )
  }

  function renderPools() {
    return (
      <div className="stack">
        <Card>
          <Form form={poolForm} layout="vertical" onFinish={savePool}>
            <Row gutter={12}>
              <Col xs={24} md={6}>
                <Form.Item name="id" label={t('poolId')} rules={[{ required: true }]}>
                  <Input placeholder="main" />
                </Form.Item>
              </Col>
              <Col xs={24} md={6}>
                <Form.Item name="name" label={t('name')} rules={[{ required: true }]}>
                  <Input placeholder="Main" />
                </Form.Item>
              </Col>
              <Col xs={24} md={9}>
                <Form.Item name="purpose" label={t('purpose')}>
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} md={3}>
                <Form.Item label=" ">
                  <Button block htmlType="submit" icon={<SaveOutlined />} type="primary">
                    {t('save')}
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        {state.pools.map(pool => (
          <PoolCard
            key={pool.id}
            accountName={accountName}
            accountOptions={accountOptions}
            locale={locale}
            members={state.poolMembers[pool.id] ?? []}
            pool={pool}
            refresh={refresh}
            setEditPool={() => poolForm.setFieldsValue(pool)}
            t={t}
            tableProps={tableProps}
          />
        ))}
      </div>
    )
  }

  function renderClients() {
    return (
      <div className="stack">
        <Card>
          <Form
            form={clientForm}
            initialValues={{ enabled: true }}
            layout="vertical"
            onFinish={saveClient}
          >
            <Row gutter={12} align="bottom">
              <Col xs={24} md={5}>
                <Form.Item name="id" label={t('clientId')} rules={[{ required: true }]}>
                  <Input placeholder="laptop" />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="name" label={t('name')} rules={[{ required: true }]}>
                  <Input placeholder="Laptop" />
                </Form.Item>
              </Col>
              <Col xs={24} md={6}>
                <Form.Item name="defaultPoolId" label={t('defaultPool')}>
                  <Select allowClear options={poolOptions} />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item name="enabled" label={t('status')} valuePropName="checked">
                  <Switch checkedChildren={t('enabled')} unCheckedChildren={t('disable')} />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label=" ">
                  <Button block htmlType="submit" icon={<SaveOutlined />} type="primary">
                    {t('save')}
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
          <Table<LocalClient>
            {...tableProps}
            columns={clientColumns}
            dataSource={state.clients}
            rowKey="id"
          />
        </Card>
        <Card title={locale === 'zh' ? '客户端访问密钥' : 'Client Access Keys'}>
          <Form form={clientTokenForm} layout="vertical" onFinish={createClientToken}>
            <Row gutter={12} align="bottom">
              <Col xs={24} md={8}>
                <Form.Item label={t('client')}>
                  <Select
                    options={clientOptions}
                    value={selectedTokenClientId}
                    onChange={value => {
                      setSelectedTokenClientId(value)
                      setRevealedClientSecret('')
                    }}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  name="name"
                  label={t('name')}
                  rules={[{ required: true }]}
                >
                  <Input placeholder="Claude Code" />
                </Form.Item>
              </Col>
              <Col xs={24} md={4}>
                <Form.Item label=" ">
                  <Button
                    block
                    disabled={!selectedTokenClientId}
                    htmlType="submit"
                    icon={<KeyOutlined />}
                    type="primary"
                  >
                    {locale === 'zh' ? '创建密钥' : 'Create Key'}
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
          {revealedClientSecret ? (
            <Alert
              showIcon
              style={{ marginBottom: 16 }}
              type="warning"
              message={locale === 'zh' ? '只显示一次' : 'Shown once'}
              description={
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input.TextArea readOnly rows={2} value={revealedClientSecret} />
                  <Button icon={<CopyOutlined />} onClick={() => void copyText(revealedClientSecret)}>
                    {t('copy')}
                  </Button>
                </Space>
              }
            />
          ) : null}
          <Table<LocalClientTokenMeta>
            {...tableProps}
            columns={clientTokenColumns}
            dataSource={clientTokens}
            rowKey="id"
          />
        </Card>
      </div>
    )
  }

  function renderOAuth() {
    return (
      <>
        <Card>
          <Form
            form={oauthForm}
            layout="vertical"
            initialValues={{ flow: 'callback' }}
            onFinish={startOAuth}
          >
            <Row gutter={12} align="bottom">
              <Col xs={24} md={5}>
                <Form.Item name="label" label={t('tokenLabel')} rules={[{ required: true }]}>
                  <Input placeholder="main" />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="sourceDevice" label={t('sourceDevice')} rules={[{ required: true }]}>
                  <Input placeholder="macbook" />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="poolId" label={t('pool')}>
                  <Select allowClear options={poolOptions} />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="flow" label={t('loginFlow')}>
                  <Segmented
                    block
                    options={[
                      { label: 'Callback', value: 'callback' },
                      { label: t('manualCode'), value: 'manual' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={4}>
                <Form.Item label=" ">
                  <Button block htmlType="submit" icon={<LinkOutlined />} type="primary">
                    {t('generateUrl')}
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        <Modal
          destroyOnHidden
          footer={null}
          open={oauthModalOpen}
          title={oauthLogin?.flow === 'manual' ? t('manualCode') : t('loginFlow')}
          onCancel={closeOAuthModal}
        >
          {oauthLogin ? (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {oauthLogin.flow === 'callback' ? (
                <Alert
                  showIcon
                  type={
                    oauthStatus === 'success'
                      ? 'success'
                      : oauthStatus === 'expired' || oauthStatus === 'error'
                        ? 'error'
                        : 'info'
                  }
                  message={
                    oauthStatus === 'success'
                      ? t('loginSucceeded')
                      : oauthStatus === 'expired'
                        ? t('loginExpired')
                        : t('loginWaiting')
                  }
                />
              ) : null}
              <Input.TextArea readOnly rows={4} value={oauthLogin.authorizeUrl} />
              <Space wrap>
              <Button
                icon={<LinkOutlined />}
                type="primary"
                onClick={() => openOAuthPopup(oauthLogin.authorizeUrl)}
              >
                {t('open')}
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => void copyText(oauthLogin.authorizeUrl)}>
                {t('copy')}
              </Button>
              </Space>
              {oauthLogin.flow === 'manual' ? (
                <Form
                  form={oauthCompleteForm}
                  layout="vertical"
                  onFinish={completeOAuth}
                >
                  <Form.Item
                    name="pastedCode"
                    label={t('pastedCode')}
                    rules={[{ required: true }]}
                  >
                    <Input.TextArea rows={3} />
                  </Form.Item>
                  <Button htmlType="submit" icon={<CheckCircleOutlined />} type="primary">
                    {t('completeLogin')}
                  </Button>
                </Form>
              ) : null}
            </Space>
          ) : null}
        </Modal>
      </>
    )
  }

  function renderSetup() {
    const smokeCommand =
      'npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001'
    return (
      <div className="stack">
      <Card>
        <Form form={setupForm} layout="vertical" onValuesChange={() => setupForm.validateFields()}>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item name="baseUrl" label={t('baseUrl')}>
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="clientId" label={t('client')}>
                <Select options={clientOptions} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="poolId" label={t('poolOverride')}>
                <Select allowClear options={poolOptions} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="clientSecret"
                label={locale === 'zh' ? '本地客户端密钥' : 'Local client secret'}
              >
                <Input.Password placeholder="<local-client-secret>" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="model" label={t('model')}>
                <Input placeholder="claude-haiku-4-5-20251001" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <Alert
          showIcon
          style={{ marginBottom: 16 }}
          type="info"
          message={
            locale === 'zh'
              ? 'Claude Code 支持在用户级 settings.json 的 env 中设置这些值；不要把密钥写进项目级 .claude/settings.json。'
              : 'Claude Code supports these values in user-level settings.json env; do not put secrets in project .claude/settings.json.'
          }
        />
        <div className="copy-grid">
          <section className="copy-panel">
            <Space className="copy-panel-header">
              <Text strong>{locale === 'zh' ? '环境变量' : 'Environment'}</Text>
              <Button icon={<CopyOutlined />} onClick={() => void copyText(setupConfig.envBlock)}>
                {t('copy')}
              </Button>
            </Space>
            <Input.TextArea className="code-block" readOnly rows={4} value={setupConfig.envBlock} />
          </section>
          <section className="copy-panel">
            <Space className="copy-panel-header">
              <Text strong>{locale === 'zh' ? '一次性命令' : 'One-shot command'}</Text>
              <Button icon={<CopyOutlined />} onClick={() => void copyText(setupConfig.command)}>
                {t('copy')}
              </Button>
            </Space>
            <Input.TextArea className="code-block" readOnly rows={6} value={setupConfig.command} />
          </section>
          <section className="copy-panel">
            <Space className="copy-panel-header">
              <Text strong>settings.json</Text>
              <Button icon={<CopyOutlined />} onClick={() => void copyText(setupConfig.settingsJson)}>
                {t('copy')}
              </Button>
            </Space>
            <Input.TextArea className="code-block" readOnly rows={7} value={setupConfig.settingsJson} />
          </section>
        </div>
        <Divider />
        <Alert
          showIcon
          type="warning"
          message={
            locale === 'zh'
              ? '真实 Messages smoke 会消耗 Claude.ai 额度。'
              : 'Real Messages smoke consumes Claude.ai quota.'
          }
        />
        <Input.TextArea
          className="code-block"
          readOnly
          rows={3}
          style={{ marginTop: 12 }}
          value={smokeCommand}
        />
      </Card>
      </div>
    )
  }

  function renderDiagnostics() {
    return (
      <Card>
        <Space direction="vertical" size={16}>
          <Button icon={<PlayCircleOutlined />} type="primary" onClick={() => void runDiagnostics()}>
            {t('runChecks')}
          </Button>
          {diagnostics.length > 0 ? (
            <Space wrap>
              {diagnostics.map(result => (
                <Tag
                  icon={result.ok ? <CheckCircleOutlined /> : undefined}
                  color={result.ok ? 'success' : 'error'}
                  key={result.label}
                >
                  {result.label}
                </Tag>
              ))}
            </Space>
          ) : null}
        </Space>
      </Card>
    )
  }

  function renderUsers() {
    if (currentUser.role !== 'owner') {
      return (
        <Card>
          <Alert
            showIcon
            type="warning"
            message={locale === 'zh' ? '需要 owner 权限' : 'Owner permission required'}
          />
        </Card>
      )
    }
    return (
      <div className="stack">
        <Card title={locale === 'zh' ? '创建本地用户' : 'Create Local User'}>
          <Form
            form={userForm}
            initialValues={{ enabled: true, role: 'viewer' }}
            layout="vertical"
            onFinish={createUser}
          >
            <Row gutter={12} align="bottom">
              <Col xs={24} md={5}>
                <Form.Item name="username" label={locale === 'zh' ? '用户名' : 'Username'} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="displayName" label={t('displayName')}>
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} md={4}>
                <Form.Item name="role" label="Role" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { label: 'viewer', value: 'viewer' },
                      { label: 'admin', value: 'admin' },
                      { label: 'owner', value: 'owner' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="password" label={locale === 'zh' ? '初始密码' : 'Initial password'} rules={[{ required: true }]}>
                  <Input.Password />
                </Form.Item>
              </Col>
              <Col xs={12} md={2}>
                <Form.Item name="enabled" label={t('status')} valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col xs={12} md={3}>
                <Form.Item label=" ">
                  <Button block htmlType="submit" icon={<UserOutlined />} type="primary">
                    {locale === 'zh' ? '创建' : 'Create'}
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        <Card title={locale === 'zh' ? '本地用户' : 'Local Users'}>
          <Table<AuthUser>
            {...tableProps}
            columns={userColumns}
            dataSource={users}
            rowKey="id"
          />
        </Card>
      </div>
    )
  }

  function renderSecurity() {
    return (
      <Card title={locale === 'zh' ? '当前用户' : 'Current User'}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label={locale === 'zh' ? '用户名' : 'Username'}>
            {currentUser.username}
          </Descriptions.Item>
          <Descriptions.Item label="Role">{currentUser.role}</Descriptions.Item>
        </Descriptions>
        <Divider />
        <Form form={passwordForm} layout="vertical" onFinish={changePassword}>
          <Row gutter={12} align="bottom">
            <Col xs={24} md={8}>
              <Form.Item name="currentPassword" label={locale === 'zh' ? '当前密码' : 'Current password'} rules={[{ required: true }]}>
                <Input.Password />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="newPassword" label={locale === 'zh' ? '新密码' : 'New password'} rules={[{ required: true }]}>
                <Input.Password />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item label=" ">
                <Button block htmlType="submit" type="primary">
                  {locale === 'zh' ? '更新密码' : 'Change Password'}
                </Button>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>
    )
  }

  const content = {
    accounts: (
      <Card>
        <Table<Account>
          {...tableProps}
          columns={accountColumns}
          dataSource={state.accounts}
          rowKey="accountUuid"
        />
      </Card>
    ),
    audit: (
      <Card>
        <Table<AuditEvent>
          {...tableProps}
          columns={auditColumns}
          dataSource={[...state.auditEvents].reverse()}
          rowKey="id"
        />
      </Card>
    ),
    clients: renderClients(),
    dashboard: renderDashboard(),
    diagnostics: renderDiagnostics(),
    oauth: renderOAuth(),
    pools: renderPools(),
    quota: (
      <Card>
        <Table<QuotaSnapshot>
          {...tableProps}
          columns={quotaColumns}
          dataSource={[...state.quotaSnapshots].reverse()}
          rowKey="id"
        />
      </Card>
    ),
    setup: renderSetup(),
    security: renderSecurity(),
    tokens: (
      <Card>
        <Alert
          showIcon
          style={{ marginBottom: 16 }}
          type="info"
          message={
            locale === 'zh'
              ? '凭证值不会由这个 API 返回，也不会在这里渲染。'
              : 'Credential values are not returned by this API or rendered here.'
          }
        />
        <Table<OAuthTokenMeta>
          {...tableProps}
          columns={tokenColumns}
          dataSource={state.tokens}
          rowKey="label"
        />
      </Card>
    ),
    users: renderUsers(),
  } as const

  const activeTitle = {
    accounts: t('accounts'),
    audit: t('audit'),
    clients: t('clients'),
    dashboard: t('dashboard'),
    diagnostics: t('diagnostics'),
    oauth: t('startLogin'),
    pools: t('pools'),
    quota: t('quota'),
    setup: t('setup'),
    security: locale === 'zh' ? '安全' : 'Security',
    tokens: t('tokens'),
    users: locale === 'zh' ? '用户' : 'Users',
  }[activeKey as keyof typeof content]

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand">
          <Title className="header-title" level={screens.xs ? 4 : 3}>
            Conduit
          </Title>
        </div>
        <div className="header-actions">
          <Tag color={health.ok ? 'success' : 'error'}>
            {health.ok ? t('online') : t('offline')}
          </Tag>
          <Segmented
            options={[
              { label: 'EN', value: 'en' },
              { label: '中文', value: 'zh' },
            ]}
            size="small"
            value={locale}
            onChange={value => setLocale(value as Locale)}
          />
          <Tag icon={<UserOutlined />}>{currentUser.username}</Tag>
          <Button icon={<LogoutOutlined />} size="small" onClick={() => void logout()}>
            {locale === 'zh' ? '退出' : 'Logout'}
          </Button>
        </div>
      </Header>
      <Layout>
        <Sider
          breakpoint="lg"
          className="app-sidebar"
          collapsedWidth={0}
          theme="light"
          width={232}
        >
          <Menu
            mode="inline"
            selectedKeys={[activeKey]}
            onClick={event => setActiveKey(event.key)}
            items={[
              { key: 'dashboard', label: t('dashboard') },
              { type: 'divider' },
              {
                key: 'grp-identity',
                type: 'group',
                label: locale === 'zh' ? '身份与账号' : 'Identity',
                children: [
                  { key: 'oauth', label: 'OAuth' },
                  { key: 'accounts', label: t('accounts') },
                  { key: 'tokens', label: t('tokens') },
                ],
              },
              { type: 'divider' },
              {
                key: 'grp-routing',
                type: 'group',
                label: locale === 'zh' ? '路由' : 'Routing',
                children: [
                  { key: 'pools', label: t('pools') },
                  { key: 'clients', label: t('clients') },
                ],
              },
              { type: 'divider' },
              {
                key: 'grp-ops',
                type: 'group',
                label: locale === 'zh' ? '运维' : 'Operations',
                children: [
                  { key: 'audit', label: t('audit') },
                  { key: 'quota', label: t('quota') },
                  { key: 'setup', label: t('setup') },
                  { key: 'diagnostics', label: t('diagnostics') },
                  { key: 'security', label: locale === 'zh' ? '安全' : 'Security' },
                  ...(currentUser.role === 'owner'
                    ? [{ key: 'users', label: locale === 'zh' ? '用户' : 'Users' }]
                    : []),
                ],
              },
            ]}
          />
        </Sider>
        <Content className="app-content">
          <div className="toolbar">
            <Title level={4}>{activeTitle}</Title>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
              {t('refresh')}
            </Button>
          </div>
          {content[activeKey as keyof typeof content]}
        </Content>
      </Layout>
    </Layout>
  )
}

function PoolCard(props: {
  accountName: (accountUuid: string | null | undefined) => string
  accountOptions: Array<{ label: string; value: string }>
  locale: Locale
  members: PoolMember[]
  pool: Pool
  refresh: () => Promise<void>
  setEditPool: () => void
  t: ReturnType<typeof useText>
  tableProps: {
    size: 'middle'
    pagination: false
    scroll: { x: string }
    locale: { emptyText: string }
  }
}) {
  const [form] = Form.useForm()
  const { accountName, accountOptions, locale, members, pool, refresh, setEditPool, t } = props

  const memberColumns: TableColumnsType<PoolMember> = [
    { title: t('account'), dataIndex: 'accountUuid', render: accountName },
    { title: t('priority'), dataIndex: 'priority', align: 'right', width: 100 },
    {
      title: t('status'),
      dataIndex: 'enabled',
      width: 110,
      render: enabled => statusTag(Boolean(enabled), locale),
    },
    {
      title: t('actions'),
      key: 'actions',
      width: 180,
      fixed: 'right',
      align: 'right',
      render: (_, member) => (
        <Space className="table-actions" size={8}>
          <Button
            size="small"
            onClick={async () => {
              await apiJson(
                `/admin/pools/${encodeURIComponent(pool.id)}/members/${encodeURIComponent(member.accountUuid)}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled: !member.enabled }),
                },
              )
              await refresh()
            }}
          >
            {member.enabled ? t('disable') : t('enable')}
          </Button>
          <Button
            danger
            size="small"
            onClick={async () => {
              await apiJson(
                `/admin/pools/${encodeURIComponent(pool.id)}/members/${encodeURIComponent(member.accountUuid)}`,
                { method: 'DELETE' },
              )
              await refresh()
            }}
          >
            {t('remove')}
          </Button>
        </Space>
      ),
    },
  ]

  async function addMember(values: { accountUuid: string; priority?: number }) {
    await apiJson(`/admin/pools/${encodeURIComponent(pool.id)}/members`, {
      method: 'POST',
      body: JSON.stringify({
        account_uuid: values.accountUuid,
        priority: values.priority ?? 100,
        enabled: true,
      }),
    })
    form.resetFields()
    await refresh()
  }

  return (
    <Card
      extra={
        <Space>
          <Button icon={<EditOutlined />} onClick={setEditPool}>
            {t('edit')}
          </Button>
          <Popconfirm
            title={`Delete ${pool.id}?`}
            onConfirm={async () => {
              await apiJson(`/admin/pools/${encodeURIComponent(pool.id)}`, {
                method: 'DELETE',
              })
              await refresh()
            }}
          >
            <Button danger icon={<DeleteOutlined />}>
              {t('delete')}
            </Button>
          </Popconfirm>
        </Space>
      }
      title={`${pool.name} (${pool.id})`}
    >
      <Text type="secondary">{pool.purpose || '-'}</Text>
      <Divider />
      <Table<PoolMember>
        {...props.tableProps}
        columns={memberColumns}
        dataSource={members}
        rowKey={member => `${member.poolId}:${member.accountUuid}`}
      />
      <Divider />
      <Form form={form} layout="vertical" onFinish={addMember}>
        <Row gutter={12} align="bottom">
          <Col xs={24} md={12}>
            <Form.Item name="accountUuid" label={t('addAccount')} rules={[{ required: true }]}>
              <Select options={accountOptions} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="priority" label={t('priority')} initialValue={100}>
              <Input type="number" />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item label=" ">
              <Button block htmlType="submit" type="primary">
                {t('addMember')}
              </Button>
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Card>
  )
}

export function AdminApp() {
  const [locale, setLocale] = useState<Locale>(() => readInitialLocale())
  const antLocale = locale === 'zh' ? zhCN : enUS

  return (
    <ConfigProvider
      locale={antLocale}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          // Brand
          colorPrimary: '#4f46e5',
          colorInfo: '#4f46e5',
          colorSuccess: '#16a34a',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          colorLink: '#4f46e5',
          // Neutrals — a calm slate scale instead of pure black/grey
          colorTextBase: '#1c2333',
          colorTextSecondary: '#646b7d',
          colorBgLayout: '#f3f4f7',
          colorBorder: '#e4e7ee',
          colorBorderSecondary: '#edeff4',
          // Shape & rhythm
          borderRadius: 10,
          borderRadiusLG: 14,
          controlHeight: 36,
          fontSize: 14,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Layout: {
            headerBg: '#ffffff',
            headerHeight: 64,
            headerPadding: '0 24px',
            bodyBg: '#f6f7f9',
            siderBg: '#ffffff',
          },
          Menu: {
            itemBorderRadius: 8,
            itemMarginInline: 8,
            itemMarginBlock: 2,
            itemHeight: 38,
            itemSelectedBg: '#eef0fe',
            itemSelectedColor: '#4338ca',
            itemColor: '#525a6d',
            itemHoverBg: '#f4f5f8',
            groupTitleColor: '#9aa1b1',
            iconMarginInlineEnd: 10,
          },
          Card: {
            borderRadiusLG: 14,
            paddingLG: 20,
            colorBorderSecondary: '#eef0f4',
            headerFontSize: 16,
          },
          Table: {
            headerBg: '#f7f8fa',
            headerColor: '#5a6275',
            headerSplitColor: 'transparent',
            rowHoverBg: '#f6f7fb',
            borderColor: '#eef0f4',
            cellPaddingBlock: 12,
          },
          Statistic: {
            titleFontSize: 13,
          },
          Button: {
            controlHeight: 36,
            fontWeight: 500,
            primaryShadow: 'none',
            defaultShadow: 'none',
          },
          Segmented: {
            itemSelectedBg: '#ffffff',
            trackBg: '#eef0f4',
          },
          Input: { controlHeight: 36 },
          Select: { controlHeight: 36 },
        },
      }}
    >
      <App>
        <AdminRoot locale={locale} setLocale={setLocale} />
      </App>
    </ConfigProvider>
  )
}

function AdminRoot(props: {
  locale: Locale
  setLocale: (locale: Locale) => void
}) {
  const { locale, setLocale } = props
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void loadCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) {
    return (
      <div className="login-shell">
        <Card>{locale === 'zh' ? '正在检查登录状态...' : 'Checking session...'}</Card>
      </div>
    )
  }

  if (!currentUser) {
    return (
      <LoginScreen
        locale={locale}
        setCurrentUser={setCurrentUser}
        setLocale={setLocale}
      />
    )
  }

  return (
    <AdminConsole
      currentUser={currentUser}
      locale={locale}
      setCurrentUser={setCurrentUser}
      setLocale={setLocale}
    />
  )
}

function LoginScreen(props: {
  locale: Locale
  setCurrentUser: (user: AuthUser | null) => void
  setLocale: (locale: Locale) => void
}) {
  const { locale, setCurrentUser, setLocale } = props
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)

  async function login(values: { username: string; password: string }) {
    setLoading(true)
    try {
      const response = await apiJson<{ user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      })
      setCurrentUser(response.user)
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell">
      <Card className="login-panel">
        <Space className="login-title" direction="vertical" size={4}>
          <Title level={3}>Conduit</Title>
          <Text type="secondary">
            {locale === 'zh' ? '登录本地网关控制台' : 'Sign in to the local gateway console'}
          </Text>
        </Space>
        <Form layout="vertical" onFinish={login}>
          <Form.Item name="username" label={locale === 'zh' ? '用户名' : 'Username'} rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label={locale === 'zh' ? '密码' : 'Password'} rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button block htmlType="submit" loading={loading} type="primary">
            {locale === 'zh' ? '登录' : 'Login'}
          </Button>
        </Form>
        <Divider />
        <Segmented
          block
          options={[
            { label: 'EN', value: 'en' },
            { label: '中文', value: 'zh' },
          ]}
          value={locale}
          onChange={value => setLocale(value as Locale)}
        />
      </Card>
    </div>
  )
}
