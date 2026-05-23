import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Card, Table, Button, Space, Tag, DatePicker, Input, Select, Descriptions } from 'antd'
import {
  ClearOutlined, DownloadOutlined, EyeOutlined, FilterOutlined, ReloadOutlined,
  SafetyCertificateOutlined, MenuOutlined, AimOutlined, ApiOutlined, UserSwitchOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { auditApi } from '@/api/admin'
import PageHeader from '@/components/common/PageHeader'
import SavedFilterViews from '@/components/common/SavedFilterViews'
import ResizableDrawer from '@/components/common/ResizableDrawer'
import { PermGuard } from '@/hooks/usePermission'
import { useTableLayout } from '@/hooks/useTableLayout'
import { fmtDatetime } from '@/utils/format'
import type { AuditLog } from '@/types'

const ACTION_COLORS: Record<string, string> = {
  '点击按钮': 'blue',
  '点击菜单': 'cyan',
  '查看':     'geekblue',
  '触发运行': 'blue',
  '重新运行': 'purple',
  '外部触发': 'blue',
  '保存DAG':  'purple',
  '更新权限': 'orange',
  '分配用户': 'green',
  '移出用户': 'volcano',
  '更新':     'orange',
  '编辑':     'orange',
  '创建':     'green',
  '删除':     'red',
  '禁用':     'volcano',
  '启用':     'cyan',
  '中止':     'red',
  '部署':     'blue',
  '还原':     'purple',
  '执行':     'geekblue',
  '同步':     'cyan',
  '登录':     'default',
  '重置密码': 'magenta',
}

const ACTION_LABELS: Record<string, string> = {
  create:  '创建',
  update:  '更新',
  edit:    '编辑',
  delete:  '删除',
  restore: '还原',
  deploy:  '部署',
}

const BUSINESS_ACTIONS = new Set([
  '创建', '更新', '编辑', '删除', '启用', '禁用', '部署', '还原', '同步',
  '执行', '更新权限', '分配用户', '移出用户', '保存DAG',
  '触发运行', '重新运行', '重置密码',
])

const RESOURCE_LABELS: Record<string, string> = {
  notification_rule: '通知规则',
  env_profile:       '环境部署配置',
  pipeline_version:  '流水线版本',
  pipeline:          '流水线',
  test_set:          '测试集',
  users:             '用户',
  roles:             '角色',
  permission:        '权限',
  vars:              '变量',
  jenkins:           'Jenkins 实例',
  cleanup:           '数据清理',
  task:              '任务',
  '公共变量':          '公共变量',
  '函数库':            '函数库',
  '数据字典':          '数据字典',
}

const ACTION_OPTIONS = ['点击按钮', '点击菜单', '查看', '创建', '更新', '删除', '启用', '禁用', '部署', '还原', '执行', '同步', '更新权限', '分配用户', '移出用户', '保存DAG', '触发运行', '重新运行', '中止', '登录', '重置密码']
const RESOURCE_OPTIONS = ['按钮', '菜单', '用户菜单', '界面', '通知规则', '环境部署配置', '流水线版本', '测试集', '流水线', '用户', '角色', '权限', '公共变量', '函数库', '数据字典', '变量', 'Jenkins 实例', '数据清理', '任务']

const EMPTY_TEXT = <span className="atop-audit-empty">-</span>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type AuditFilters = {
  keyword: string
  action: string
  resourceType: string
  startDate: string
  endDate: string
}

function cleanText(value?: string | null) {
  const text = String(value ?? '').trim()
  if (!text || text === 'null' || text === 'undefined') return ''
  return text
}

const operatorNameOf = (row: AuditLog) =>
  row.operatorName || (row.username?.includes('@') ? row.username.split('@')[0] : row.username) || '已删除用户'

const operatorEmailOf = (row: AuditLog) =>
  row.operatorEmail || (row.username?.includes('@') ? row.username : '')

function humanActionOf(action?: string) {
  const value = action?.trim() || ''
  return ACTION_LABELS[value] || value || '未知操作'
}

function humanResourceTypeOf(resourceType?: string) {
  const value = resourceType?.trim() || ''
  return RESOURCE_LABELS[value] || value || '界面'
}

function isGeneratedId(value?: string) {
  const text = cleanText(value)
  return UUID_RE.test(text)
}

function shortId(value?: string) {
  const text = cleanText(value)
  return text.length > 12 ? `${text.slice(0, 8)}...` : text
}

function routeMetaOf(module?: string) {
  const path = cleanText(module)
  if (!path) return { name: '', path: '', title: '' }
  const map: Record<string, string> = {
    '/dashboard': '运行大盘',
    '/run-history': '运行记录',
    '/trends': '历史趋势',
    '/pipelines': '流水线',
    '/settings/jenkins': 'Jenkins 实例',
    '/settings/vars': '公共变量池',
    '/settings/dimensions': '数据字典',
    '/settings/notification-rules': '通知规则',
    '/admin/users': '用户管理',
    '/admin/roles': '角色管理',
    '/admin/audit': '审计日志',
    '/admin/cleanup': '数据清理',
    '/profile': '个人设置',
  }
  const dynamicRoutes = [
    { prefix: '/runs/', name: '运行详情', idLabel: '运行ID' },
    { prefix: '/pipelines/', name: '流水线详情', idLabel: '流水线ID' },
    { prefix: '/test-sets/', name: '测试集详情', idLabel: '测试集ID' },
  ]
  const dynamic = dynamicRoutes.find(item => path.startsWith(item.prefix) && isGeneratedId(path.slice(item.prefix.length).split('/')[0]))
  if (dynamic) {
    const id = path.slice(dynamic.prefix.length).split('/')[0]
    return {
      name: dynamic.name,
      path: id ? `${dynamic.idLabel}：${shortId(id)}` : path,
      title: path,
    }
  }
  const exact = map[path]
  if (exact) return { name: exact, path, title: path }
  const prefix = Object.keys(map).find((key) => path.startsWith(`${key}/`))
  if (prefix) return { name: map[prefix], path, title: path }
  return { name: path, path, title: path }
}

function auditTargetOf(row: AuditLog) {
  const action = humanActionOf(row.action)
  const type = humanResourceTypeOf(row.resourceType)
  const button = cleanText(row.button)
  const name = cleanText(row.resourceName)
  if ((action === '点击按钮' || action === '点击菜单') && button) return button
  if (name && !isGeneratedId(name)) return name
  if (row.module) return moduleNameOf(row.module)
  return type
}

function auditResourceTitleOf(row: AuditLog) {
  const type = humanResourceTypeOf(row.resourceType)
  const target = auditTargetOf(row)
  if (target === type && isGeneratedId(row.resourceName)) {
    return `${type}记录`
  }
  return target
}

function auditResourceMetaOf(row: AuditLog) {
  const id = cleanText(row.resourceId) || cleanText(row.resourceName)
  if (!isGeneratedId(id)) return ''
  return `ID：${shortId(id)}`
}

function auditResourceIdOf(row: AuditLog) {
  const id = cleanText(row.resourceId)
  if (id) return id
  return isGeneratedId(row.resourceName) ? cleanText(row.resourceName) : ''
}

function actionVerbOf(action: string) {
  const map: Record<string, string> = {
    创建:     '创建了',
    更新:     '更新了',
    编辑:     '编辑了',
    删除:     '删除了',
    启用:     '启用了',
    禁用:     '禁用了',
    部署:     '部署了',
    还原:     '还原了',
    执行:     '执行了',
    同步:     '同步了',
    保存DAG:  '保存了',
    触发运行: '触发运行了',
    重新运行: '重新运行了',
    中止:     '中止了',
    重置密码: '重置了密码',
  }
  return map[action] || `${action}了`
}

function quoteName(name: string) {
  return name ? `「${name}」` : ''
}

function auditPageOf(row: AuditLog) {
  return moduleNameOf(row.module) || ''
}

function auditSentenceOf(row: AuditLog) {
  const actor = operatorNameOf(row)
  const action = humanActionOf(row.action)
  const type = humanResourceTypeOf(row.resourceType)
  const target = auditTargetOf(row)
  const page = auditPageOf(row)
  const pageText = page ? `在 ${page} ` : ''

  if (action === '点击按钮') {
    return `${actor} ${pageText}点击了按钮${quoteName(target)}`
  }
  if (action === '点击菜单') {
    return `${actor} ${pageText}点击了菜单${quoteName(target)}`
  }
  if (action === '查看') {
    return `${actor} ${pageText}查看了${type}${quoteName(target)}`
  }
  if (action === '更新权限') {
    return `${actor} ${pageText}更新了${type}${quoteName(target)}的权限`
  }
  if (action === '分配用户') {
    return `${actor} ${pageText}给${type}${quoteName(target)}分配了用户`
  }
  if (action === '移出用户') {
    return `${actor} ${pageText}从${type}${quoteName(target)}移出了用户`
  }
  if (action === '重置密码') {
    return `${actor} ${pageText}重置了${type}${quoteName(target)}的密码`
  }
  if (action === '登录') {
    return `${actor} 登录了系统`
  }
  return `${actor} ${pageText}${actionVerbOf(action)}${type}${quoteName(target)}`
}

function moduleNameOf(module?: string) {
  return routeMetaOf(module).name
}

function formatDiff(diffJson?: object | string) {
  if (!diffJson) return ''
  try {
    const parsed = typeof diffJson === 'string' ? JSON.parse(diffJson) : diffJson
    if (parsed == null) return ''
    if (Array.isArray(parsed) && parsed.length === 0) return ''
    if (typeof parsed === 'object' && Object.keys(parsed).length === 0) return ''
    return JSON.stringify(parsed, null, 2)
  } catch {
    const text = cleanText(String(diffJson))
    return text === 'null' ? '' : text
  }
}

function renderModule(module?: string) {
  const meta = routeMetaOf(module)
  if (!meta.name) return EMPTY_TEXT
  return (
    <span className="atop-audit-module" title={meta.title || meta.path}>
      {meta.name}
      {meta.path && meta.path !== meta.name ? <small>{meta.path}</small> : null}
    </span>
  )
}

function renderId(value?: string) {
  const id = cleanText(value)
  if (!id) return EMPTY_TEXT
  return <code className="atop-audit-id" title={id}>{isGeneratedId(id) ? shortId(id) : id}</code>
}

function renderDiff(diffJson?: object | string) {
  const diffText = formatDiff(diffJson)
  return diffText
    ? <pre className="atop-audit-diff">{diffText}</pre>
    : <div className="atop-audit-diff-empty">本次记录没有额外变更明细</div>
}

export default function AuditPage() {
  const { tableProps, defaultPageSize } = useTableLayout({ offsetY: 520 })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [detail, setDetail] = useState<AuditLog | null>(null)
  const [filters, setFilters] = useState({
    keyword:      '',
    action:       '',
    resourceType: '',
    startDate:    '',
    endDate:      '',
  })

  const { data, isLoading, mutate } = useSWR(
    ['audit', page, pageSize, filters],
    () => auditApi.list({ ...filters, page, pageSize }),
    { revalidateOnFocus: false }
  )

  const rows = data?.items ?? []
  const stats = useMemo(() => ({
    total: data?.total ?? 0,
    pageRows: rows.length,
    buttonClicks: rows.filter((row) => humanActionOf(row.action) === '点击按钮').length,
    businessActions: rows.filter((row) => BUSINESS_ACTIONS.has(humanActionOf(row.action))).length,
    deleteActions: rows.filter((row) => humanActionOf(row.action) === '删除').length,
  }), [data?.total, rows])

  const activeFilterCount = [
    filters.keyword,
    filters.action,
    filters.resourceType,
    filters.startDate && filters.endDate,
  ].filter(Boolean).length

  const handleExport = async () => {
    await auditApi.export(filters)
  }

  const resetFilters = () => {
    setFilters({ keyword: '', action: '', resourceType: '', startDate: '', endDate: '' })
    setPage(1)
  }

  const applySavedFilters = (nextFilters: AuditFilters) => {
    setFilters({
      keyword: nextFilters.keyword ?? '',
      action: nextFilters.action ?? '',
      resourceType: nextFilters.resourceType ?? '',
      startDate: nextFilters.startDate ?? '',
      endDate: nextFilters.endDate ?? '',
    })
    setPage(1)
  }

  const cols = [
    {
      title: '时间', dataIndex: 'createdAt', key: 'time', width: 158,
      render: (t: string) => <span className="atop-audit-time">{fmtDatetime(t)}</span>,
    },
    {
      title: '审计事件', key: 'event', width: 430,
      render: (_: unknown, row: AuditLog) => {
        const action = humanActionOf(row.action)
        return (
          <div className="atop-audit-event">
            <div className="atop-audit-event-main">
              <Tag color={ACTION_COLORS[action] ?? 'default'}>{action}</Tag>
              <strong>{auditSentenceOf(row)}</strong>
            </div>
            <span>{operatorEmailOf(row) || '未记录邮箱'}</span>
          </div>
        )
      },
    },
    {
      title: '来源页面', dataIndex: 'module', key: 'module', width: 180,
      render: (module?: string) => renderModule(module),
    },
    {
      title: '资源', key: 'resource', width: 220,
      render: (_: unknown, row: AuditLog) => {
        const meta = auditResourceMetaOf(row)
        return (
          <div className="atop-audit-resource">
            <span>{humanResourceTypeOf(row.resourceType)}</span>
            <strong>{auditResourceTitleOf(row)}</strong>
            {meta ? <small>{meta}</small> : null}
          </div>
        )
      },
    },
    {
      title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 132,
      render: (ip: string) => ip ? <code className="atop-audit-ip">{ip}</code> : EMPTY_TEXT,
    },
    {
      title: '详情', key: 'detail', width: 88, fixed: 'right' as const,
      render: (_: unknown, row: AuditLog) => (
        <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => setDetail(row)}>
          查看
        </Button>
      ),
    },
  ]

  return (
    <div className="atop-page-shell atop-audit-page">
      <PageHeader
        eyebrow="AUDIT TRAIL"
        title="操作审计日志"
        subtitle="追踪用户点击菜单、点击按钮和关键业务操作，帮助定位问题、还原路径和安全复盘。"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => mutate()}>刷新</Button>
            <PermGuard resource="audit" action="view">
              <Button icon={<DownloadOutlined />} onClick={handleExport}>导出 CSV</Button>
            </PermGuard>
          </Space>
        }
      />

      <div className="atop-audit-hero">
        <div>
          <SafetyCertificateOutlined />
          <span>筛选结果总数</span>
          <strong>{stats.total}</strong>
          <small>本页展示 {stats.pageRows} 条</small>
        </div>
        <div>
          <UserSwitchOutlined />
          <span>本页可见记录</span>
          <strong>{stats.pageRows}</strong>
          <small>当前表格记录数</small>
        </div>
        <div>
          <AimOutlined />
          <span>本页按钮点击</span>
          <strong>{stats.buttonClicks}</strong>
          <small>谁在什么页面点了什么</small>
        </div>
        <div>
          <MenuOutlined />
          <span>本页业务操作</span>
          <strong>{stats.businessActions}</strong>
          <small>创建、更新、删除等</small>
        </div>
        <div>
          <ApiOutlined />
          <span>本页删除记录</span>
          <strong>{stats.deleteActions}</strong>
          <small>删除对象名称可追溯</small>
        </div>
      </div>

      <div className="atop-audit-filter-panel">
        <div className="atop-audit-filter-copy">
          <span className="atop-audit-filter-icon"><FilterOutlined /></span>
          <div>
            <div className="atop-audit-filter-title">筛选审计日志</div>
            <div className="atop-audit-filter-note">按操作人、按钮、页面、IP、动作和资源定位记录</div>
          </div>
        </div>
        <div className="atop-audit-filter-controls">
          <Input.Search
            className="atop-audit-search"
            placeholder="搜索操作人 / 按钮 / 页面 / IP"
            value={filters.keyword}
            onChange={(event) => { setFilters((f) => ({ ...f, keyword: event.target.value })); setPage(1) }}
            onSearch={(value) => { setFilters((f) => ({ ...f, keyword: value })); setPage(1) }}
            allowClear
          />
          <DatePicker.RangePicker
            className="atop-audit-range"
            value={filters.startDate && filters.endDate ? [dayjs(filters.startDate), dayjs(filters.endDate)] : null}
            onChange={(dates) => {
              setFilters((f) => ({
                ...f,
                startDate: dates?.[0]?.startOf('day').toISOString() ?? '',
                endDate:   dates?.[1]?.endOf('day').toISOString() ?? '',
              }))
              setPage(1)
            }}
          />
          <Select
            className="atop-audit-action-select"
            placeholder="全部操作"
            allowClear
            value={filters.action || undefined}
            options={ACTION_OPTIONS.map((value) => ({ label: value, value }))}
            onChange={(value) => { setFilters((f) => ({ ...f, action: value ?? '' })); setPage(1) }}
          />
          <Select
            className="atop-audit-resource-select"
            placeholder="全部资源"
            allowClear
            value={filters.resourceType || undefined}
            options={RESOURCE_OPTIONS.map((value) => ({ label: value, value }))}
            onChange={(value) => { setFilters((f) => ({ ...f, resourceType: value ?? '' })); setPage(1) }}
          />
          <Button icon={<ClearOutlined />} onClick={resetFilters}>重置</Button>
          <SavedFilterViews<AuditFilters>
            storageKey="atop.savedFilters.audit.v1"
            currentFilters={filters}
            onApply={applySavedFilters}
            activeCount={activeFilterCount}
            presets={[
              { name: '高风险审计操作', note: '删除操作', filters: { keyword: '', action: '删除', resourceType: '', startDate: '', endDate: '' } },
              { name: '权限变更', note: '角色/权限操作', filters: { keyword: '', action: '更新权限', resourceType: '', startDate: '', endDate: '' } },
              { name: '密码重置', note: '账号安全相关', filters: { keyword: '', action: '重置密码', resourceType: '', startDate: '', endDate: '' } },
            ]}
          />
        </div>
        <div className="atop-audit-filter-summary">
          <span>关键词：{filters.keyword || '全部'}</span>
          <span>操作：{filters.action || '全部类型'}</span>
          <span>资源：{filters.resourceType || '全部资源'}</span>
          <span>筛选：{activeFilterCount} 项</span>
        </div>
      </div>

      <Card className="atop-content-card atop-table-card atop-audit-card" size="small" styles={{ body: { padding: 0 } }}>
        <Table
          {...tableProps}
          dataSource={rows}
          columns={cols}
          rowKey="id"
          size="small"
          loading={isLoading}
          rowClassName={(row) => humanActionOf(row.action) === '点击菜单' ? 'is-menu-action' : humanActionOf(row.action) === '点击按钮' ? 'is-button-action' : ''}
          pagination={{
            ...tableProps.pagination,
            current: page,
            pageSize,
            total: data?.total ?? 0,
            showTotal: (total) => `共 ${total} 条记录`,
            onChange: (p, s) => { setPage(p); setPageSize(s) },
          }}
        />
      </Card>

      <ResizableDrawer
        title="审计详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        defaultWidth={620}
        minWidth={520}
        maxWidth={1120}
        rootClassName="atop-audit-detail-drawer"
      >
        {detail && (
          <div className="atop-audit-detail">
            <div className="atop-audit-detail-head">
              <Tag color={ACTION_COLORS[humanActionOf(detail.action)] ?? 'default'}>{humanActionOf(detail.action)}</Tag>
              <strong>{auditSentenceOf(detail)}</strong>
              <span>{fmtDatetime(detail.createdAt)}</span>
            </div>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="操作人">{operatorNameOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{operatorEmailOf(detail) || '-'}</Descriptions.Item>
              <Descriptions.Item label="完整事件">{auditSentenceOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="操作按钮">{detail.button || '-'}</Descriptions.Item>
              <Descriptions.Item label="来源页面">{renderModule(detail.module)}</Descriptions.Item>
              <Descriptions.Item label="资源类型">{humanResourceTypeOf(detail.resourceType)}</Descriptions.Item>
              <Descriptions.Item label="资源名称">{auditResourceTitleOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="资源 ID">{renderId(auditResourceIdOf(detail))}</Descriptions.Item>
              <Descriptions.Item label="IP 地址"><code>{detail.ip || '-'}</code></Descriptions.Item>
            </Descriptions>
            {renderDiff(detail.diffJson)}
          </div>
        )}
      </ResizableDrawer>
    </div>
  )
}
