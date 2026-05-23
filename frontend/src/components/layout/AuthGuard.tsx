import { useEffect, useRef } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { message } from 'antd'
import { useAuthStore } from '@/store/auth'
import { usePermissionStore } from '@/store/permission'
import { getRouteInfo } from '@/utils/routePermissions'

export default function AuthGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const mustChangePwd = useAuthStore((s) => s.mustChangePwd)
  const location = useLocation()
  const navigate = useNavigate()
  const loaded = usePermissionStore((s) => s.loaded)
  const can = usePermissionStore((s) => s.can)
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'
  const lastDeniedRef = useRef('')

  useEffect(() => {
    if (!isAuthenticated || !loaded || isSuperAdmin) {
      return
    }

    const pathname = location.pathname
    const routeInfo = getRouteInfo(pathname)
    if (!routeInfo) {
      return
    }

    if (!can(routeInfo.resource, 'view')) {
      if (lastDeniedRef.current !== pathname) {
        lastDeniedRef.current = pathname
        message.warning({
          content: `“${routeInfo.label}” 无权限，请联系管理员`,
          key: 'no-permission',
          duration: 3,
        })
      }
      navigate('/dashboard', { replace: true })
      return
    }

    lastDeniedRef.current = ''
  }, [loaded, location.pathname, isAuthenticated, isSuperAdmin, can, navigate])

  if (!isAuthenticated) {
    const currentPath = location.pathname + location.search
    if (currentPath.includes('/login')) {
      return <Navigate to="/login" replace />
    }
    const returnUrl = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?returnUrl=${returnUrl}`} replace />
  }

  if (mustChangePwd && location.pathname !== '/force-change-pwd') {
    return <Navigate to="/force-change-pwd" replace />
  }

  return <Outlet />
}
