import { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback, Suspense, type MouseEvent } from 'react'
import useSWR from 'swr'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Layout, Menu, Button, Avatar, Dropdown, Badge, Typography, Spin, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  DashboardOutlined, DeploymentUnitOutlined,
  AuditOutlined, ApiOutlined, FieldBinaryOutlined, KeyOutlined,
  UserOutlined, LogoutOutlined, PlusOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, TeamOutlined, DeleteOutlined,
  LineChartOutlined, BellOutlined, HistoryOutlined, BranchesOutlined,
  UsergroupAddOutlined, CloseOutlined, LeftOutlined, RightOutlined,
  MoreOutlined, PushpinOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/store/auth'
import { userApi } from '@/api/admin'
import { roleApi } from '@/api/permission'
import { authApi } from '@/api/auth'
import { notificationApi, notifyNotificationChanged, NOTIFICATION_CHANGED_EVENT } from '@/api/notification'
import { preferenceApi } from '@/api/preferences'
import { useDynamicTitle } from '@/hooks/useDynamicTitle'
import { useAudit } from '@/hooks/useAudit'
import DraggableUnreadBadge from '@/components/common/DraggableUnreadBadge'
import NotificationBell from '@/components/layout/NotificationBell'
import VersionCenter from '@/components/layout/VersionCenter'
import GlobalCommandPalette from '@/components/layout/GlobalCommandPalette'
import { useLoadPermissions, usePermission } from '@/hooks/usePermission'
import { requestCancelManager } from '@/api/client'

const { Sider, Header, Content } = Layout
const { Text } = Typography

// NAV_ITEMS 只包含纯数据，不含任何 JSX/Link 组件
// 避免 Link 组件在 Menu 内引用 router context 导致每次路由变化时重绘闪烁
// resource+action for view permission check (null = always visible)
type NavGroupItem = { type: 'group'; label: string }
type NavRouteItem = { key: string; icon: string; label: string; resource?: string }
type NavItem = NavGroupItem | NavRouteItem

const isNavGroup = (item: NavItem): item is NavGroupItem => 'type' in item && item.type === 'group'

const NAV_ITEMS: NavItem[] = [
  { type: 'group' as const, label: '运行观测' },
  { key: '/dashboard',                   icon: 'dashboard', label: '运行大盘'     },
  { key: '/run-history',                 icon: 'history',   label: '运行记录'     },
  { key: '/trends',                      icon: 'trend',     label: '历史趋势'     },
  { key: '/notifications',               icon: 'notify',    label: '消息通知' },
  { key: '/versions',                    icon: 'versions',  label: '版本管理' },
  { type: 'group' as const, label: '流水线编排' },
  { key: '/pipelines',                   icon: 'pipeline',  label: '流水线',       resource: 'pipeline'   },
  { type: 'group' as const, label: '集成配置' },
  { key: '/settings/jenkins',            icon: 'jenkins',   label: 'Jenkins 实例', resource: 'jenkins'    },
  { key: '/settings/vars',               icon: 'vars',      label: '公共变量池',   resource: 'vars'       },
  { key: '/settings/dimensions',      icon: 'dims',      label: '数据字典',     resource: 'dimensions' },
  { key: '/settings/notification-rules', icon: 'notify',    label: '通知规则',     resource: 'notification_rule' },
  { type: 'group' as const, label: '平台治理' },
  { key: '/admin/users',                 icon: 'users',     label: '用户管理',     resource: 'users'             },
  { key: '/admin/roles',                 icon: 'roles',     label: '角色管理',     resource: 'roles'             },
  { key: '/admin/audit',                 icon: 'audit',     label: '审计日志',     resource: 'audit'             },
  { key: '/admin/cleanup',               icon: 'cleanup',   label: '数据清理',     resource: 'cleanup'           },
]

const PINNED_WORKTABS_PREF = 'worktabs.pinned.v1'
const HOME_WORKTAB_KEY = '/dashboard'

function compactText(value?: string | null) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function sameStringArray(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function buttonLabelOf(element: HTMLElement) {
  const auditLabel = compactText(element.dataset.auditLabel)
  const aria = compactText(element.getAttribute('aria-label'))
  const title = compactText(element.getAttribute('title'))
  const text = compactText(element.textContent)
  return auditLabel || aria || text || title
}

export default function MainLayout() {
  const loc       = useLocation()
  const navigate  = useNavigate()
  const user      = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [openTabs, setOpenTabs] = useState<string[]>([HOME_WORKTAB_KEY])
  const [pinnedTabs, setPinnedTabs] = useState<string[]>([HOME_WORKTAB_KEY])
  const [pinnedTabsLoaded, setPinnedTabsLoaded] = useState(false)
  const [worktabsScrollState, setWorktabsScrollState] = useState({ canScrollLeft: false, canScrollRight: false })
  const { trackClick, trackEvent } = useAudit()
  useDynamicTitle()
  useLoadPermissions() // Load user permissions on app init

  const closingTabsRef = useRef(new Set<string>())
  const worktabsRef = useRef<HTMLDivElement | null>(null)
  const worktabRefs = useRef(new Map<string, HTMLDivElement>())
  const lastAutoScrolledTabRef = useRef<string | null>(null)
  const loadedPinnedTabsKeyRef = useRef('')
  const savedPinnedTabsValueRef = useRef('')

  // 路由变化时取消上一个页面的未完成请求
  const prevPathRef = useRef(loc.pathname)
  useEffect(() => {
    if (prevPathRef.current !== loc.pathname) {
      // 取消上一个页面的所有请求
      requestCancelManager.cancelPage(prevPathRef.current)
      prevPathRef.current = loc.pathname
    }
  }, [loc.pathname])

  useEffect(() => {
    setMobileNavOpen(false)
  }, [loc.pathname])

  // Hooks must be called before any conditional logic
  const { can, isSuperAdmin } = usePermission()
  const canViewUsers = isSuperAdmin || can('users', 'view')
  const canViewRoles = isSuperAdmin || can('roles', 'view')
  // Fetch counts only when the current user is allowed to view those resources.
  const { data: usersData } = useSWR(canViewUsers ? 'nav-users-count' : null, () => userApi.list({ page: 1, pageSize: 1 }))
  const { data: rolesData } = useSWR(canViewRoles ? 'nav-roles-count' : null, roleApi.list)
  const { data: notificationUnread = 0, mutate: mutateNotificationUnread } = useSWR(
    isAuthenticated ? 'nav-notifications-unread-count' : null,
    notificationApi.unreadCount,
    { refreshInterval: 15_000, revalidateOnFocus: true },
  )
  const userCount = usersData?.total ?? 0
  const roleCount = rolesData?.length ?? 0
  const navRoutes = useMemo(
    () => NAV_ITEMS.filter((item): item is NavRouteItem => !isNavGroup(item)),
    []
  )
  const routeMetaMap = useMemo(
    () => new Map(navRoutes.map((item) => [item.key, item])),
    [navRoutes]
  )

  // ICON_MAP inside component to avoid module-level JSX initialization issues
  const ICON_MAP: Record<string, React.ReactNode> = useMemo(() => ({
    dashboard: <DashboardOutlined />,
    history:   <HistoryOutlined />,
    trend:     <LineChartOutlined />,
    pipeline:  <DeploymentUnitOutlined />,
    jenkins:   <ApiOutlined />,
    vars:      <KeyOutlined />,
    dims:      <FieldBinaryOutlined />,
    notify:    <BellOutlined />,
    versions:  <BranchesOutlined />,
    users:     <TeamOutlined />,
    roles:     <UsergroupAddOutlined />,
    audit:     <AuditOutlined />,
    cleanup:   <DeleteOutlined />,
  }), [])

  // Build menu items filtered by view permission — no Link components to avoid flicker
  // Only filter when permissions are loaded — avoid flicker during initial load
  const { loaded: permLoaded } = usePermission()
  useEffect(() => {
    if (!isAuthenticated) return
    const refreshUnread = () => {
      void mutateNotificationUnread()
    }
    window.addEventListener(NOTIFICATION_CHANGED_EVENT, refreshUnread)
    return () => window.removeEventListener(NOTIFICATION_CHANGED_EVENT, refreshUnread)
  }, [isAuthenticated, mutateNotificationUnread])

  const clearAllUnreadFromNav = async () => {
    try {
      await notificationApi.markAllRead()
      notifyNotificationChanged()
      await mutateNotificationUnread(0, { revalidate: true })
      message.success('已将全部未读消息标为已读')
    } catch (error) {
      message.error('操作失败，请稍后重试')
      throw error
    }
  }

  const availableRouteKeyList = useMemo(() => (
    navRoutes
      .filter((item) => !(permLoaded && !isSuperAdmin && item.resource && !can(item.resource, 'view')))
      .map((item) => item.key)
  ), [can, isSuperAdmin, navRoutes, permLoaded])
  const availableRouteKeys = useMemo(() => new Set(availableRouteKeyList), [availableRouteKeyList])
  const availableRouteKeySignature = availableRouteKeyList.join('|')

  const menuItems = useMemo<MenuProps['items']>(() => {
    const filtered: NonNullable<MenuProps['items']> = []
    let pendingGroup: { type: 'group'; label: React.ReactNode; children: NonNullable<MenuProps['items']> } | null = null
    const flushGroup = () => {
      if (pendingGroup && pendingGroup.children.length > 0) {
        filtered.push(pendingGroup)
      }
      pendingGroup = null
    }

    for (const item of NAV_ITEMS) {
      if (isNavGroup(item)) {
        flushGroup()
        pendingGroup = {
          type: 'group',
          label: item.label,
          children: [],
        }
        continue
      }
      // Only apply permission filter after permissions are fully loaded
      if (permLoaded && !isSuperAdmin && item.resource && !can(item.resource, 'view')) continue
      let menuLabel: any = item.label
      if (item.key === '/admin/users' && userCount > 0) {
        menuLabel = <span className="atop-nav-label">{item.label}<Badge count={userCount} size="small" className="atop-nav-badge atop-nav-badge-danger" /></span>
      } else if (item.key === '/admin/roles' && roleCount > 0) {
        menuLabel = <span className="atop-nav-label">{item.label}<Badge count={roleCount} size="small" className="atop-nav-badge atop-nav-badge-danger" /></span>
      } else if (item.key === '/notifications' && notificationUnread > 0) {
        menuLabel = (
          <span className="atop-nav-label">
            {item.label}
            <DraggableUnreadBadge
              count={notificationUnread}
              className="atop-nav-draggable-badge"
              onClear={clearAllUnreadFromNav}
            />
          </span>
        )
      }
      const menuItem = { key: item.key, icon: ICON_MAP[item.icon], label: menuLabel }
      if (pendingGroup) {
        pendingGroup.children.push(menuItem)
      } else {
        filtered.push(menuItem)
      }
    }
    flushGroup()
    return filtered
  }, [can, isSuperAdmin, ICON_MAP, clearAllUnreadFromNav, notificationUnread, permLoaded, userCount, roleCount])

  const selectedKey = useMemo(() => {
    const segs = loc.pathname.split('/').filter(Boolean)
    if (segs.length === 0) return '/'
    // /runs/:id and /reported-runs/:id should highlight /run-history
    if (segs[0] === 'runs' || segs[0] === 'reported-runs') return '/run-history'
    const full = '/' + segs.slice(0, 2).join('/')
    const known = [
      '/pipelines', '/settings/jenkins', '/settings/vars',
      '/settings/dimensions', '/settings/notification-rules',
      '/admin/users', '/admin/roles', '/admin/audit', '/admin/cleanup',
      '/dashboard', '/run-history', '/trends', '/notifications', '/versions',
    ]
    if (segs.length >= 2 && known.includes(full)) return full
    return '/' + segs[0]
  }, [loc.pathname])

  useEffect(() => {
    closingTabsRef.current.forEach((key) => {
      if (key !== selectedKey) closingTabsRef.current.delete(key)
    })
  }, [selectedKey])

  useEffect(() => {
    if (!routeMetaMap.has(selectedKey)) return
    if (permLoaded && !availableRouteKeys.has(selectedKey)) return
    if (closingTabsRef.current.has(selectedKey)) return
    setOpenTabs((prev) => prev.includes(selectedKey) ? prev : [...prev, selectedKey])
  }, [availableRouteKeys, permLoaded, routeMetaMap, selectedKey])

  useEffect(() => {
    if (!permLoaded) return
    setOpenTabs((prev) => {
      const next = prev.filter((key) => availableRouteKeys.has(key))
      const normalized = next.includes(HOME_WORKTAB_KEY) ? next : [HOME_WORKTAB_KEY, ...next]
      return sameStringArray(prev, normalized) ? prev : normalized
    })
    setPinnedTabs((prev) => {
      const next = prev.filter((key) => key === HOME_WORKTAB_KEY || availableRouteKeys.has(key))
      const normalized = next.includes(HOME_WORKTAB_KEY) ? next : [HOME_WORKTAB_KEY, ...next]
      return sameStringArray(prev, normalized) ? prev : normalized
    })
  }, [availableRouteKeySignature, availableRouteKeys, permLoaded])

  useEffect(() => {
    if (!isAuthenticated || !permLoaded) return
    const loadKey = `${user?.id ?? user?.email ?? 'anonymous'}|${availableRouteKeySignature}`
    if (loadedPinnedTabsKeyRef.current === loadKey) return
    loadedPinnedTabsKeyRef.current = loadKey

    let cancelled = false
    preferenceApi.get<string[]>(PINNED_WORKTABS_PREF)
      .then((stored) => {
        if (cancelled) return
        const valid = Array.isArray(stored)
          ? stored.filter((key): key is string => typeof key === 'string' && (key === HOME_WORKTAB_KEY || availableRouteKeys.has(key)))
          : []
        const next = valid.includes(HOME_WORKTAB_KEY) ? valid : [HOME_WORKTAB_KEY, ...valid]
        setPinnedTabs((prev) => sameStringArray(prev, next) ? prev : next)
        setOpenTabs((prev) => {
          const normalized = Array.from(new Set([HOME_WORKTAB_KEY, ...next, ...prev.filter((key) => availableRouteKeys.has(key))]))
          return sameStringArray(prev, normalized) ? prev : normalized
        })
      })
      .catch(() => {
        // 偏好读取失败不阻断主流程，避免后端临时不可用时反复打断用户。
      })
      .finally(() => {
        if (!cancelled) setPinnedTabsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [availableRouteKeySignature, isAuthenticated, permLoaded, user?.email, user?.id])

  useEffect(() => {
    if (!isAuthenticated || !pinnedTabsLoaded) return
    const next = Array.from(new Set([HOME_WORKTAB_KEY, ...pinnedTabs]))
    const serialized = JSON.stringify(next)
    if (savedPinnedTabsValueRef.current === serialized) return
    savedPinnedTabsValueRef.current = serialized

    const timer = window.setTimeout(() => {
      preferenceApi.save(PINNED_WORKTABS_PREF, next).catch(() => {
        // 偏好保存失败由全局接口错误提示兜底。
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [isAuthenticated, pinnedTabs, pinnedTabsLoaded])

  const updateWorktabsScrollState = useCallback(() => {
    const container = worktabsRef.current
    if (!container) return

    const next = {
      canScrollLeft: container.scrollLeft > 1,
      canScrollRight: container.scrollLeft + container.clientWidth < container.scrollWidth - 1,
    }
    setWorktabsScrollState((prev) => (
      prev.canScrollLeft === next.canScrollLeft && prev.canScrollRight === next.canScrollRight ? prev : next
    ))
  }, [])

  useLayoutEffect(() => {
    if (lastAutoScrolledTabRef.current === selectedKey) return

    const scrollActiveTabIntoView = () => {
      const container = worktabsRef.current
      const activeTab = worktabRefs.current.get(selectedKey)
      if (!container || !activeTab) return

      const containerRect = container.getBoundingClientRect()
      const activeRect = activeTab.getBoundingClientRect()
      const activeLeft = activeRect.left - containerRect.left + container.scrollLeft
      const targetLeft = activeLeft - (container.clientWidth - activeRect.width) / 2
      const maxScrollLeft = container.scrollWidth - container.clientWidth
      container.scrollLeft = Math.max(0, Math.min(targetLeft, maxScrollLeft))
      lastAutoScrolledTabRef.current = selectedKey
      updateWorktabsScrollState()
    }

    scrollActiveTabIntoView()
    let timeout: number | undefined
    const frame = window.requestAnimationFrame(() => {
      scrollActiveTabIntoView()
      timeout = window.setTimeout(scrollActiveTabIntoView, 80)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (timeout) window.clearTimeout(timeout)
    }
  }, [openTabs, selectedKey, updateWorktabsScrollState])

  useEffect(() => {
    const container = worktabsRef.current
    if (!container) return

    updateWorktabsScrollState()
    container.addEventListener('scroll', updateWorktabsScrollState, { passive: true })
    window.addEventListener('resize', updateWorktabsScrollState)

    return () => {
      container.removeEventListener('scroll', updateWorktabsScrollState)
      window.removeEventListener('resize', updateWorktabsScrollState)
    }
  }, [openTabs, updateWorktabsScrollState])

  const scrollWorktabsBy = (direction: -1 | 1) => {
    const container = worktabsRef.current
    if (!container) return

    const left = container.scrollLeft + direction * Math.max(160, container.clientWidth * 0.72)
    container.scrollTo({ left, behavior: 'smooth' })
    window.setTimeout(updateWorktabsScrollState, 180)
  }

  const closeTabsByKeys = (keys: string[]) => {
    const pinned = new Set(pinnedTabs)
    const closingKeys = keys.filter((key) => key !== HOME_WORKTAB_KEY && !pinned.has(key))
    if (closingKeys.length === 0) return

    const closing = new Set(closingKeys)
    const nextTabs = openTabs.filter((item) => !closing.has(item))
    if (closing.has(selectedKey)) closingTabsRef.current.add(selectedKey)
    const normalizedTabs = nextTabs.includes(HOME_WORKTAB_KEY) ? nextTabs : [HOME_WORKTAB_KEY, ...nextTabs]
    setOpenTabs(normalizedTabs)

    if (closing.has(selectedKey)) {
      const closedIndex = openTabs.indexOf(selectedKey)
      const fallback = normalizedTabs[Math.max(0, closedIndex - 1)] ?? normalizedTabs[0] ?? HOME_WORKTAB_KEY
      navigate(fallback)
    }
  }

  const closeOpenTab = (key: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    closeTabsByKeys([key])
  }

  const togglePinnedTab = (key: string) => {
    if (key === HOME_WORKTAB_KEY) return
    setPinnedTabs((prev) => (
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    ))
  }

  const buildWorktabMenu = (key: string): MenuProps => {
    const index = openTabs.indexOf(key)
    const pinned = new Set(pinnedTabs)
    const unpinnedLeft = openTabs.slice(0, index).filter((item) => item !== HOME_WORKTAB_KEY && !pinned.has(item))
    const unpinnedRight = openTabs.slice(index + 1).filter((item) => item !== HOME_WORKTAB_KEY && !pinned.has(item))
    const otherUnpinned = openTabs.filter((item) => item !== HOME_WORKTAB_KEY && item !== key && !pinned.has(item))
    const allUnpinned = openTabs.filter((item) => item !== HOME_WORKTAB_KEY && !pinned.has(item))
    const isPinned = pinned.has(key)
    const isHome = key === HOME_WORKTAB_KEY

    return {
      items: [
        {
          key: 'pin',
          icon: <PushpinOutlined />,
          label: isHome ? '默认固定标签' : isPinned ? '取消固定标签' : '固定标签',
          disabled: isHome,
        },
        { type: 'divider' as const },
        {
          key: 'close-others',
          label: '关闭其他',
          disabled: otherUnpinned.length === 0,
        },
        {
          key: 'close-left',
          label: '关闭左侧',
          disabled: unpinnedLeft.length === 0,
        },
        {
          key: 'close-right',
          label: '关闭右侧',
          disabled: unpinnedRight.length === 0,
        },
        {
          key: 'close-all',
          label: '关闭全部未固定',
          disabled: allUnpinned.length === 0,
        },
      ],
      onClick: ({ key: action, domEvent }) => {
        domEvent.stopPropagation()
        if (action === 'pin') {
          togglePinnedTab(key)
          return
        }
        if (action === 'close-others') closeTabsByKeys(otherUnpinned)
        if (action === 'close-left') closeTabsByKeys(unpinnedLeft)
        if (action === 'close-right') closeTabsByKeys(unpinnedRight)
        if (action === 'close-all') closeTabsByKeys(allUnpinned)
      },
    }
  }

  const handleLogout = async () => {
    await authApi.logout()
    clearAuth()
    navigate('/login')
  }

  const userMenu = {
    items: [
      { key: 'profile', icon: <UserOutlined />, label: '个人设置' },
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      const label = key === 'logout' ? '退出登录' : '个人设置'
      trackEvent({ action: '点击菜单', resourceType: '用户菜单', resourceName: label, button: label })
      if (key === 'logout') handleLogout()
      else if (key === 'profile') navigate('/profile')
    },
  }

  const handleShellClickCapture = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null
    const clickable = target?.closest('button, [role="button"]') as HTMLElement | null
    if (!clickable || clickable.closest('.ant-menu')) return
    const label = buttonLabelOf(clickable)
    if (!label) return
    trackClick(label)
    trackEvent({
      action: '点击按钮',
      resourceType: '按钮',
      resourceName: label,
      button: label,
      module: loc.pathname,
    })
  }

  const initials = user?.username?.slice(0, 1).toUpperCase() ?? '?'
  const avatarUrl = user?.avatarUrl?.trim()
  const toggleNavigation = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches) {
      setMobileNavOpen((open) => !open)
      return
    }
    setCollapsed((open) => !open)
  }

  return (
    <Layout style={{ minHeight: '100vh', overflow: 'hidden' }} onClickCapture={handleShellClickCapture}>

      <Sider
        width={248}
        collapsedWidth={72}
        collapsed={collapsed}
        className={`atop-sidebar${mobileNavOpen ? ' atop-sidebar-mobile-open' : ''}`}
        style={{
          background: '#fff',
          borderRight: '0.5px solid rgba(0,0,0,0.08)',
          overflow: 'hidden',
          position: 'sticky',
          top: 0,
          height: '100vh',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          className="atop-brand"
          onClick={() => navigate('/dashboard')}
          style={{
            padding: collapsed ? '16px 0' : '16px 18px',
            borderBottom: '0.5px solid rgba(0,0,0,0.08)',
            display: 'flex', alignItems: 'center', gap: 12,
            cursor: 'pointer',
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <div style={{
            width: 38, height: 38, borderRadius: 10, background: '#E6F1FB',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 16, color: '#185FA5', flexShrink: 0,
          }}>A</div>
          {!collapsed && (
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, lineHeight: 1.15, color: '#1A1A18' }}>ATOP</div>
              <div style={{ fontSize: 12, color: '#5F5E5A', lineHeight: 1.35, marginTop: 3 }}>自动化编排调度平台</div>
            </div>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          inlineCollapsed={collapsed}
          className="atop-sidebar-menu"
          style={{ border: 'none', padding: collapsed ? '10px 8px' : '12px 10px 18px', fontSize: 14 }}
          motion={undefined}
          onClick={({ key }) => {
            if (key.startsWith('/')) {
              const meta = routeMetaMap.get(key)
              trackEvent({
                action: '点击菜单',
                resourceType: '菜单',
                resourceName: meta?.label ?? key,
                button: meta?.label ?? key,
                module: loc.pathname,
              })
              setMobileNavOpen(false)
              navigate(key)
            }
          }}
        />
      </Sider>
      {mobileNavOpen && (
        <button
          type="button"
          className="atop-mobile-nav-backdrop"
          aria-label="关闭侧边栏"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Main — fixed height so only Content scrolls, Header stays sticky */}
      <Layout style={{ overflow: 'hidden', minWidth: 0, height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header style={{
          background: '#fff',
          borderBottom: '0.5px solid rgba(0,0,0,0.08)',
          padding: '0 24px',
          display: 'flex', alignItems: 'center', gap: 10,
          position: 'sticky', top: 0, zIndex: 100,
          height: 52, flexShrink: 0,
        }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            onClick={toggleNavigation}
            style={{ color: '#9C9A92', fontSize: 16 }}
          />

          <div className="atop-worktabs-shell">
            <div className="atop-worktabs-meta" aria-hidden="true">
              <span>已打开任务</span>
              <small>可切换/关闭</small>
            </div>
            <div className="atop-worktabs-frame">
              <button
                type="button"
                className="atop-worktabs-scroll"
                aria-label="向左滚动已打开任务"
                title="向左滚动"
                disabled={!worktabsScrollState.canScrollLeft}
                onClick={() => scrollWorktabsBy(-1)}
              >
                <LeftOutlined />
              </button>
              <div ref={worktabsRef} className="atop-worktabs" role="tablist" aria-label="已打开任务，可切换或关闭">
                {openTabs.map((key) => {
                  const meta = routeMetaMap.get(key)
                  if (!meta) return null
                  const active = key === selectedKey
                  const isPinned = pinnedTabs.includes(key)
                  const canClose = key !== HOME_WORKTAB_KEY && openTabs.length > 1 && !isPinned
                  const menu = buildWorktabMenu(key)
                  return (
                    <Dropdown key={key} menu={menu} trigger={['contextMenu']} placement="bottomLeft">
                      <div
                        ref={(element) => {
                          if (element) worktabRefs.current.set(key, element)
                          else worktabRefs.current.delete(key)
                        }}
                        className={`atop-worktab${active ? ' atop-worktab-active' : ''}${key === HOME_WORKTAB_KEY ? ' atop-worktab-home' : ''}`}
                        role="tab"
                        aria-selected={active}
                        title={`${meta.label}${active ? '，当前任务' : '，点击切换；右键打开标签菜单'}`}
                      >
                        <button
                          type="button"
                          className="atop-worktab-main"
                          onClick={() => navigate(key)}
                        >
                          <span className="atop-worktab-icon">{ICON_MAP[meta.icon]}</span>
                          <span className="atop-worktab-label">{meta.label}</span>
                          {isPinned && <PushpinOutlined className="atop-worktab-pin" />}
                        </button>
                        {canClose && (
                          <button
                            type="button"
                            className="atop-worktab-close"
                            aria-label={`关闭已打开任务：${meta.label}`}
                            title={`关闭${meta.label}`}
                            onClick={(event) => closeOpenTab(key, event)}
                          >
                            <CloseOutlined />
                          </button>
                        )}
                        <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
                          <button
                            type="button"
                            className="atop-worktab-more"
                            aria-label={`打开${meta.label}标签菜单`}
                            title="标签操作"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                          >
                            <MoreOutlined />
                          </button>
                        </Dropdown>
                      </div>
                    </Dropdown>
                  )
                })}
              </div>
              <button
                type="button"
                className="atop-worktabs-scroll"
                aria-label="向右滚动已打开任务"
                title="向右滚动"
                disabled={!worktabsScrollState.canScrollRight}
                onClick={() => scrollWorktabsBy(1)}
              >
                <RightOutlined />
              </button>
            </div>
          </div>

          <GlobalCommandPalette />

          <Button
            type="primary"
            icon={<PlusOutlined />}
            size="middle"
            onClick={() => navigate('/pipelines')}
          >
            触发运行
          </Button>

          <VersionCenter />

          <NotificationBell />

          <Dropdown menu={userMenu} placement="bottomRight" trigger={['click']}>
            <div
              className="atop-user-menu"
              title={user?.username}
              role="button"
              tabIndex={0}
              aria-label="打开用户菜单"
              data-audit-label="打开用户菜单"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.currentTarget.click()
                }
              }}
            >
              <Avatar size={30} src={avatarUrl || undefined} style={{ background: '#E6F1FB', color: '#185FA5', fontWeight: 600, fontSize: 13 }}>
                {!avatarUrl ? initials : null}
              </Avatar>
              <Text className="atop-user-menu-name">{user?.username}</Text>
            </div>
          </Dropdown>
        </Header>

        <Content style={{ padding: 24, overflow: 'auto', minWidth: 0, flex: 1, height: 0 }}>
          <Suspense fallback={
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '30vh' }}>
              <Spin size="large" />
            </div>
          }>
            <div className="page-enter" style={{ height: '100%' }}>
              <Outlet />
            </div>
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  )
}
