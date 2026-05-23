import { useCallback, useEffect, cloneElement } from 'react'
import type { ReactElement } from 'react'
import { Tooltip } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/store/auth'
import { usePermissionStore } from '@/store/permission'
import { permissionApi } from '@/api/permission'

// ── Load permissions on app init ──────────────────────────────────────────
export function useLoadPermissions() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const loaded          = usePermissionStore(s => s.loaded)
  const setPerms        = usePermissionStore(s => s.setPerms)
  const clear           = usePermissionStore(s => s.clear)

  useEffect(() => {
    if (!isAuthenticated) { clear(); return }
    if (loaded) return
    permissionApi.getMyPermissions()
      .then(setPerms)
      .catch(() => {/* On error, keep empty — server enforces anyway */})
  }, [isAuthenticated, loaded, setPerms, clear])
}

// Call this after permission changes to force a fresh reload from server
// Does NOT clear first — keeps old perms until new ones arrive to avoid flicker
export function useReloadPermissions() {
  const setPerms = usePermissionStore(s => s.setPerms)
  const clear    = usePermissionStore(s => s.clear)
  return () => {
    permissionApi.getMyPermissions()
      .then((newPerms) => {
        clear()      // clear old state
        setPerms(newPerms)  // set new state immediately after
      })
      .catch(() => {})
  }
}

// ── Main permission hook ──────────────────────────────────────────────────
export function usePermission() {
  const can    = usePermissionStore(s => s.can)
  const loaded = usePermissionStore(s => s.loaded)
  const user   = useAuthStore(s => s.user)
  const isSuperAdmin = user?.roles?.includes('super_admin') || user?.role === 'super_admin'

  const check = useCallback((resource: string, action: string): boolean => {
    if (isSuperAdmin) return true
    if (!loaded) return true // optimistic while loading
    return can(resource, action)
  }, [can, isSuperAdmin, loaded])

  return { can: check, isSuperAdmin, loaded }
}

// ── PermGuard component ───────────────────────────────────────────────────
// Wraps a button and disables it with tooltip when no permission.
interface PermGuardProps {
  resource:      string
  action:        string
  children:      ReactElement
  hideIfDenied?: boolean
}

export function PermGuard({ resource, action, children, hideIfDenied = false }: PermGuardProps) {
  const { can } = usePermission()
  const allowed = can(resource, action)

  if (!allowed && hideIfDenied) return null
  if (allowed) return children

  const disabled = cloneElement(children, {
    disabled: true,
    onClick:  undefined,
    style: { ...(children.props?.style ?? {}), pointerEvents: 'none' as const },
  })

  return (
    <Tooltip title={<><LockOutlined style={{ marginRight: 4 }} />无权限，请联系管理员</>}>
      <span style={{ display: 'inline-block', cursor: 'not-allowed' }}>
        {disabled}
      </span>
    </Tooltip>
  )
}
