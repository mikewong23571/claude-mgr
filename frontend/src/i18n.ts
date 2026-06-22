import type { Locale } from './types.js'

type MessageKey =
  | 'account'
  | 'accounts'
  | 'actions'
  | 'addAccount'
  | 'addMember'
  | 'audit'
  | 'baseUrl'
  | 'client'
  | 'clientId'
  | 'clients'
  | 'completeLogin'
  | 'copy'
  | 'created'
  | 'dashboard'
  | 'defaultPool'
  | 'delete'
  | 'diagnostics'
  | 'disable'
  | 'displayName'
  | 'email'
  | 'enable'
  | 'enabled'
  | 'edit'
  | 'errorSource'
  | 'errorType'
  | 'expires'
  | 'gateway'
  | 'generateUrl'
  | 'health'
  | 'lastCheck'
  | 'lastUsed'
  | 'loginFlow'
  | 'loginExpired'
  | 'loginSucceeded'
  | 'loginWaiting'
  | 'manualCode'
  | 'model'
  | 'name'
  | 'noData'
  | 'offline'
  | 'online'
  | 'open'
  | 'origin'
  | 'pastedCode'
  | 'popupBlocked'
  | 'pool'
  | 'poolId'
  | 'poolOverride'
  | 'pools'
  | 'priority'
  | 'purpose'
  | 'quota'
  | 'rateLimit'
  | 'rateTier'
  | 'refresh'
  | 'remove'
  | 'resets'
  | 'routing'
  | 'runChecks'
  | 'save'
  | 'scopes'
  | 'setup'
  | 'sourceDevice'
  | 'startLogin'
  | 'status'
  | 'subscription'
  | 'token'
  | 'tokenLabel'
  | 'tokens'
  | 'upstream'
  | 'upstreamRequestId'
  | 'utilization'

const messages: Record<Locale, Record<MessageKey, string>> = {
  en: {
    account: 'Account',
    accounts: 'Accounts',
    actions: 'Actions',
    addAccount: 'Add account',
    addMember: 'Add member',
    audit: 'Audit Events',
    baseUrl: 'Base URL',
    client: 'Client',
    clientId: 'Client id',
    clients: 'Local Clients',
    completeLogin: 'Complete login',
    copy: 'Copy',
    created: 'Created',
    dashboard: 'Gateway State',
    defaultPool: 'Default pool',
    delete: 'Delete',
    diagnostics: 'Diagnostics',
    disable: 'Disable',
    displayName: 'Display name',
    email: 'Email',
    enable: 'Enable',
    enabled: 'Enabled',
    edit: 'Edit',
    errorSource: 'Error source',
    errorType: 'Error type',
    expires: 'Expires',
    gateway: 'gateway',
    generateUrl: 'Generate URL',
    health: 'Health',
    lastCheck: 'Last check',
    lastUsed: 'Last used',
    loginFlow: 'Login flow',
    loginExpired: 'Login expired',
    loginSucceeded: 'Login completed',
    loginWaiting: 'Waiting for OAuth callback',
    manualCode: 'Manual code',
    model: 'Model',
    name: 'Name',
    noData: 'No data',
    offline: 'Offline',
    online: 'Online',
    open: 'Open',
    origin: 'Origin',
    pastedCode: 'Pasted code or callback URL',
    popupBlocked: 'Popup was blocked. Open the URL manually.',
    pool: 'Pool',
    poolId: 'Pool id',
    poolOverride: 'Pool override',
    pools: 'Account Pools',
    priority: 'Priority',
    purpose: 'Purpose',
    quota: 'Quota Snapshots',
    rateLimit: 'Rate limit',
    rateTier: 'Rate tier',
    refresh: 'Refresh',
    remove: 'Remove',
    resets: 'Resets',
    routing: 'Routing Snapshot',
    runChecks: 'Run Checks',
    save: 'Save',
    scopes: 'Scopes',
    setup: 'Claude Code Setup',
    sourceDevice: 'Source device',
    startLogin: 'Start Account Login',
    status: 'Status',
    subscription: 'Subscription',
    token: 'Token',
    tokenLabel: 'Token label',
    tokens: 'Token Metadata',
    upstream: 'upstream',
    upstreamRequestId: 'Upstream request id',
    utilization: 'Utilization',
  },
  zh: {
    account: '账号',
    accounts: '账号',
    actions: '操作',
    addAccount: '添加账号',
    addMember: '添加成员',
    audit: '审计事件',
    baseUrl: 'Base URL',
    client: '客户端',
    clientId: '客户端 id',
    clients: '本地客户端',
    completeLogin: '完成登录',
    copy: '复制',
    created: '创建时间',
    dashboard: '网关状态',
    defaultPool: '默认账号池',
    delete: '删除',
    diagnostics: '诊断',
    disable: '停用',
    displayName: '显示名',
    email: '邮箱',
    enable: '启用',
    enabled: '已启用',
    edit: '编辑',
    errorSource: '错误来源',
    errorType: '错误类型',
    expires: '过期时间',
    gateway: '网关',
    generateUrl: '生成 URL',
    health: '健康检查',
    lastCheck: '最近检查',
    lastUsed: '最近使用',
    loginFlow: '登录方式',
    loginExpired: '登录已过期',
    loginSucceeded: '登录完成',
    loginWaiting: '等待 OAuth callback',
    manualCode: '手动码',
    model: '模型',
    name: '名称',
    noData: '暂无数据',
    offline: '离线',
    online: '在线',
    open: '打开',
    origin: '来源',
    pastedCode: '粘贴授权码或回调 URL',
    popupBlocked: '弹窗被浏览器拦截，请手动打开 URL。',
    pool: '账号池',
    poolId: '账号池 id',
    poolOverride: '账号池覆盖',
    pools: '账号池',
    priority: '优先级',
    purpose: '用途',
    quota: '额度快照',
    rateLimit: '限流',
    rateTier: '速率层级',
    refresh: '刷新',
    remove: '移除',
    resets: '重置时间',
    routing: '路由快照',
    runChecks: '运行检查',
    save: '保存',
    scopes: 'Scopes',
    setup: 'Claude Code 配置',
    sourceDevice: '来源设备',
    startLogin: '开始账号登录',
    status: '状态',
    subscription: '订阅',
    token: 'Token',
    tokenLabel: 'Token 标签',
    tokens: 'Token 元数据',
    upstream: '上游',
    upstreamRequestId: '上游 request id',
    utilization: '使用率',
  },
}

export function useText(locale: Locale) {
  return (key: MessageKey): string => messages[locale][key]
}
