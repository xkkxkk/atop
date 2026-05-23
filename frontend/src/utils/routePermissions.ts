// Route-to-resource permission mapping.
// Dashboard / trends / run history stay open to all authenticated users unless listed here.
export const ROUTE_RESOURCE_MAP: Record<string, { resource: string; label: string }> = {
  '/pipelines': { resource: 'pipeline', label: '流水线' },
  '/settings/jenkins': { resource: 'jenkins', label: 'Jenkins 实例' },
  '/settings/vars': { resource: 'vars', label: '公共变量池' },
  '/settings/dimensions': { resource: 'dimensions', label: '数据字典' },
  '/settings/notification-rules': { resource: 'notification_rule', label: '通知规则' },
  '/admin/users': { resource: 'users', label: '用户管理' },
  '/admin/roles': { resource: 'roles', label: '角色管理' },
  '/admin/audit': { resource: 'audit', label: '审计日志' },
  '/admin/cleanup': { resource: 'cleanup', label: '数据清理' },
  '/runs': { resource: 'pipeline', label: '运行记录' },
}

export interface RouteInfo {
  resource: string
  label: string
}

export function getRouteInfo(pathname: string): RouteInfo | null {
  if (ROUTE_RESOURCE_MAP[pathname]) return ROUTE_RESOURCE_MAP[pathname]
  for (const [route, info] of Object.entries(ROUTE_RESOURCE_MAP)) {
    if (pathname.startsWith(route + '/') || pathname === route) {
      return info
    }
  }
  return null
}

export function getRouteResource(pathname: string): string | null {
  return getRouteInfo(pathname)?.resource ?? null
}
