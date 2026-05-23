import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Empty, Input, Modal, Spin, Tag } from 'antd'
import {
  BellOutlined,
  BranchesOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  HistoryOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { userApi } from '@/api/admin'
import { pipelineApi, runApi } from '@/api/pipelines'
import { VERSION_HISTORY } from '@/data/versionHistory'
import { usePermission } from '@/hooks/usePermission'
import { usePermissionStore } from '@/store/permission'
import type { Pipeline, PipelineRun, UserRecord } from '@/types'

type CommandItem = {
  id: string
  title: string
  subtitle: string
  route: string
  group: string
  icon: ReactNode
  tag?: string
}

type PageCommand = Omit<CommandItem, 'id'> & {
  id: string
  keywords: string
  resource?: string
}

const PAGE_COMMANDS: PageCommand[] = [
  { id: 'page-dashboard', title: '运行大盘', subtitle: '查看异常、运行中任务和质量趋势', route: '/dashboard', group: '页面', icon: <DashboardOutlined />, keywords: 'dashboard 运行大盘 异常' },
  { id: 'page-run-history', title: '运行记录', subtitle: '查看平台触发和 Jenkins 上报记录', route: '/run-history', group: '页面', icon: <HistoryOutlined />, keywords: 'run history 运行记录 失败 日志' },
  { id: 'page-trends', title: '历史趋势', subtitle: '查看近 30 天稳定性和异常趋势', route: '/trends', group: '页面', icon: <HistoryOutlined />, keywords: 'trends 趋势 稳定性' },
  { id: 'page-pipelines', title: '流水线', subtitle: '管理流水线配置并触发运行', route: '/pipelines', group: '页面', icon: <DeploymentUnitOutlined />, keywords: 'pipeline 流水线 触发', resource: 'pipeline' },
  { id: 'page-notifications', title: '消息通知', subtitle: '查看平台消息和处理状态', route: '/notifications', group: '页面', icon: <BellOutlined />, keywords: 'notifications 消息 通知' },
  { id: 'page-versions', title: '版本管理', subtitle: '查看平台版本历史和前后端更新内容', route: '/versions', group: '页面', icon: <BranchesOutlined />, keywords: 'version versions 版本管理 版本历史 发布记录 changelog release' },
  { id: 'page-notification-rules', title: '通知规则', subtitle: '配置异常和运行结果通知规则', route: '/settings/notification-rules', group: '页面', icon: <SettingOutlined />, keywords: 'notification rules 通知规则', resource: 'notification_rule' },
  { id: 'page-users', title: '用户管理', subtitle: '维护用户、角色和独立权限', route: '/admin/users', group: '页面', icon: <TeamOutlined />, keywords: 'users 用户 管理', resource: 'users' },
  { id: 'page-roles', title: '角色管理', subtitle: '维护角色权限和关联用户', route: '/admin/roles', group: '页面', icon: <UsergroupAddOutlined />, keywords: 'roles 角色 权限', resource: 'roles' },
]

function normalize(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function unwrapRuleItems(data: any): any[] {
  const body = data?.data ?? data
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body?.data)) return body.data
  return []
}

export default function GlobalCommandPalette() {
  const navigate = useNavigate()
  const { can, isSuperAdmin, loaded: permissionsLoaded } = usePermission()
  const permissionSnapshot = usePermissionStore((state) => state.perms)
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [remoteItems, setRemoteItems] = useState<CommandItem[]>([])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    setKeyword('')
    setRemoteItems([])
    setLoading(false)
  }, [open])

  const pageItems = useMemo(() => {
    if (!permissionsLoaded && !isSuperAdmin) return []
    const query = normalize(keyword)
    return PAGE_COMMANDS
      .filter((item) => isSuperAdmin || !item.resource || can(item.resource, 'view'))
      .filter((item) => !query || normalize(`${item.title} ${item.subtitle} ${item.keywords}`).includes(query))
      .map(({ keywords: _keywords, resource: _resource, ...item }) => item)
      .slice(0, 8)
  }, [can, isSuperAdmin, keyword, permissionSnapshot, permissionsLoaded])

  const versionItems = useMemo<CommandItem[]>(() => {
    const query = normalize(keyword)
    if (!query) return []
    return VERSION_HISTORY
      .filter((item) => normalize([
        item.version,
        item.date,
        item.time,
        item.title,
        item.desc,
        item.frontend?.commit,
        item.backend?.commit,
        ...(item.frontend?.changes ?? []),
        ...(item.backend?.changes ?? []),
      ].join(' ')).includes(query))
      .slice(0, 6)
      .map((item) => ({
        id: `version-${item.version}`,
        title: item.version,
        subtitle: `${item.title} · ${item.date}${item.time ? ` ${item.time}` : ''}`,
        route: `/versions?version=${encodeURIComponent(item.version)}`,
        group: '版本管理',
        icon: <BranchesOutlined />,
        tag: item.version === VERSION_HISTORY[0]?.version ? '当前使用' : undefined,
      }))
  }, [keyword])

  const canSearchPipelines = isSuperAdmin || (permissionsLoaded && can('pipeline', 'view'))
  const canSearchRuns = canSearchPipelines
  const canSearchUsers = isSuperAdmin || (permissionsLoaded && can('users', 'view'))
  const canSearchNotificationRules = isSuperAdmin || (permissionsLoaded && can('notification_rule', 'view'))

  useEffect(() => {
    if (!open) return
    if (!permissionsLoaded && !isSuperAdmin) {
      setRemoteItems([])
      setLoading(true)
      return
    }
    const query = keyword.trim()
    if (!query) {
      setRemoteItems([])
      setLoading(false)
      return
    }

    let alive = true
    const timer = window.setTimeout(async () => {
      setLoading(true)
      const nextItems: CommandItem[] = []
      const [pipelines, runs, users, rules] = await Promise.allSettled([
        canSearchPipelines ? pipelineApi.list({ keyword: query, page: 1, pageSize: 5 }) : Promise.resolve(null),
        canSearchRuns ? runApi.list({ keyword: query, page: 1, pageSize: 5 }) : Promise.resolve(null),
        canSearchUsers ? userApi.list({ keyword: query, page: 1, pageSize: 5 }) : Promise.resolve(null),
        canSearchNotificationRules ? client.get('/notifications/rules', { params: { page: 1, pageSize: 20, keyword: query } }) : Promise.resolve(null),
      ])

      if (canSearchPipelines && pipelines.status === 'fulfilled' && pipelines.value) {
        pipelines.value.items.slice(0, 5).forEach((item: Pipeline) => {
          nextItems.push({
            id: `pipeline-${item.id}`,
            title: item.name,
            subtitle: `${item.project || '未分组'} · ${item.environment || '未指定环境'}`,
            route: `/pipelines/${item.id}/run`,
            group: '流水线',
            icon: <DeploymentUnitOutlined />,
            tag: item.lastRunStatus || item.triggerType,
          })
        })
      }

      if (canSearchRuns && runs.status === 'fulfilled' && runs.value) {
        runs.value.items.slice(0, 5).forEach((item: PipelineRun) => {
          nextItems.push({
            id: `run-${item.id}`,
            title: item.pipelineName || `运行 ${item.id.slice(0, 8)}`,
            subtitle: `#${item.id.slice(0, 8)} · ${item.triggeredByName || item.triggeredBy || '未知触发人'}`,
            route: `/runs/${item.id}`,
            group: '运行记录',
            icon: <HistoryOutlined />,
            tag: item.status,
          })
        })
      }

      if (canSearchUsers && users.status === 'fulfilled' && users.value) {
        users.value.items.slice(0, 5).forEach((item: UserRecord) => {
          nextItems.push({
            id: `user-${item.id}`,
            title: item.username,
            subtitle: item.email,
            route: '/admin/users',
            group: '用户',
            icon: <TeamOutlined />,
            tag: item.status,
          })
        })
      }

      if (canSearchNotificationRules && rules.status === 'fulfilled' && rules.value) {
        unwrapRuleItems(rules.value.data)
          .filter((item) => normalize(`${item.name} ${item.channel} ${item.eventType}`).includes(normalize(query)))
          .slice(0, 5)
          .forEach((item) => {
            nextItems.push({
              id: `rule-${item.id || item.name}`,
              title: item.name || '通知规则',
              subtitle: `${item.channel || '通知'} · ${item.eventType || '事件'}`,
              route: '/settings/notification-rules',
              group: '通知规则',
              icon: <BellOutlined />,
              tag: item.enabled === false || item.status === 'disabled' ? '停用' : '启用',
            })
          })
      }

      if (alive) {
        setRemoteItems(nextItems)
        setLoading(false)
      }
    }, 220)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [canSearchNotificationRules, canSearchPipelines, canSearchRuns, canSearchUsers, isSuperAdmin, keyword, open, permissionSnapshot, permissionsLoaded])

  const items = [...pageItems, ...versionItems, ...remoteItems]

  const openCommand = (item: CommandItem) => {
    setOpen(false)
    setKeyword('')
    navigate(item.route)
  }

  return (
    <>
      <Button
        className="atop-command-trigger"
        icon={<SearchOutlined />}
        onClick={() => setOpen(true)}
      >
        搜索
        <span>Ctrl K</span>
      </Button>

      <Modal
        open={open}
        onCancel={() => {
          setKeyword('')
          setOpen(false)
        }}
        footer={null}
        width={680}
        destroyOnClose
        className="atop-command-modal"
        title="全局命令搜索"
      >
        <Input
          autoFocus
          size="large"
          prefix={<SearchOutlined />}
          placeholder="搜索页面、版本、流水线、运行记录、用户、通知规则"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onPressEnter={() => {
            const first = items[0]
            if (first) openCommand(first)
          }}
        />
        <div className="atop-command-results">
          {loading && <Spin size="small" className="atop-command-loading" />}
          {!loading && items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配结果" />
          ) : items.map((item) => (
            <button key={item.id} type="button" className="atop-command-item" onClick={() => openCommand(item)}>
              <span className="atop-command-icon">{item.icon}</span>
              <span className="atop-command-copy">
                <strong>{item.title}</strong>
                <small>{item.group} · {item.subtitle}</small>
              </span>
              {item.tag && <Tag>{item.tag}</Tag>}
            </button>
          ))}
        </div>
      </Modal>
    </>
  )
}
