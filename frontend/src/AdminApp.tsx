import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, loadAdminState } from './api.js'
import { useText } from './i18n.js'
import type {
  Account,
  AdminState,
  AuditEvent,
  LocalClient,
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
  locale: Locale
  setLocale: (locale: Locale) => void
}) {
  const { locale, setLocale } = props
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
  const [setupForm] = Form.useForm()
  const setupValues = Form.useWatch([], setupForm) as
    | { baseUrl?: string; clientId?: string; poolId?: string }
    | undefined
  const [authorizeUrl, setAuthorizeUrl] = useState<string>('')
  const [diagnostics, setDiagnostics] = useState<Array<{ label: string; ok: boolean }>>([])

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
      message.error(error instanceof Error ? error.message : 'Refresh failed')
    } finally {
      setLoading(false)
    }
  }, [message, refreshHealth])

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
    setupForm.setFieldValue('baseUrl', window.location.origin)
  }, [setupForm, state.clients])

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
  }) {
    const params = new URLSearchParams({
      label: values.label,
      source_device: values.sourceDevice,
    })
    if (values.poolId) params.set('pool_id', values.poolId)
    const response = await apiJson<{ authorize_url: string }>(
      `/oauth/authorize?${params.toString()}`,
    )
    setAuthorizeUrl(response.authorize_url)
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

  const setupSnippet = useMemo(() => {
    const baseUrl = setupValues?.baseUrl || window.location.origin
    const clientId = setupValues?.clientId || '<client-id>'
    const headers = [`x-claude-mgr-client-id: ${clientId}`]
    if (setupValues?.poolId) {
      headers.push(`x-claude-mgr-pool-id: ${setupValues.poolId}`)
    }
    return `env \\
  ANTHROPIC_BASE_URL="${baseUrl}" \\
  ANTHROPIC_API_KEY="local-dummy-key" \\
  ANTHROPIC_CUSTOM_HEADERS=$'${headers.join('\\n')}' \\
  node_modules/.bin/claude --bare --print --no-session-persistence --disable-slash-commands --model claude-haiku-4-5-20251001 --output-format json "Respond with exactly OK and nothing else."`
  }, [setupValues, state.clients, state.pools])

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
    )
  }

  function renderOAuth() {
    return (
      <Card>
        <Form form={oauthForm} layout="vertical" onFinish={startOAuth}>
          <Row gutter={12} align="bottom">
            <Col xs={24} md={7}>
              <Form.Item name="label" label={t('tokenLabel')} rules={[{ required: true }]}>
                <Input placeholder="main" />
              </Form.Item>
            </Col>
            <Col xs={24} md={7}>
              <Form.Item name="sourceDevice" label={t('sourceDevice')} rules={[{ required: true }]}>
                <Input placeholder="macbook" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="poolId" label={t('pool')}>
                <Select allowClear options={poolOptions} />
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
        {authorizeUrl ? (
          <>
            <Divider />
            <Input.TextArea readOnly rows={4} value={authorizeUrl} />
            <Space style={{ marginTop: 12 }}>
              <Button
                icon={<LinkOutlined />}
                type="primary"
                onClick={() => window.open(authorizeUrl, '_blank', 'noopener')}
              >
                {t('open')}
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => void copyText(authorizeUrl)}>
                {t('copy')}
              </Button>
            </Space>
          </>
        ) : null}
      </Card>
    )
  }

  function renderSetup() {
    const smokeCommand =
      'npm run smoke:live -- --host localhost --port 8799 --db data/live-smoke.sqlite --messages --model claude-haiku-4-5-20251001'
    return (
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
          </Row>
        </Form>
        <Input.TextArea className="code-block" readOnly rows={9} value={setupSnippet} />
        <Space style={{ marginTop: 12 }}>
          <Button icon={<CopyOutlined />} onClick={() => void copyText(setupSnippet)}>
            {t('copy')}
          </Button>
        </Space>
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
    tokens: t('tokens'),
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
        <AdminConsole locale={locale} setLocale={setLocale} />
      </App>
    </ConfigProvider>
  )
}
