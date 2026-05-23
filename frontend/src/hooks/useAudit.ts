import { useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import client from '@/api/client'
import { useAuthStore } from '@/store/auth'

export interface AuditEventPayload {
  action?: string
  resourceType?: string
  resourceId?: string
  resourceName?: string
  button?: string
  module?: string
  diffJson?: unknown
}

/**
 * useAudit provides helpers for audit events.
 * Usage: const { trackClick } = useAudit()
 *        <Button onClick={() => { trackClick('新建测试集'); handleCreate() }}>
 *
 * For write operations, audit is recorded server-side automatically.
 * For read/view operations that need tracking, use trackView or trackEvent manually.
 */
export function useAudit() {
  const location  = useLocation()
  const user      = useAuthStore(s => s.user)

  const trackEvent = useCallback((payload: AuditEventPayload) => {
    if (!user) return
    const button = String(payload.button ?? payload.resourceName ?? '').trim()
    const resourceName = String(payload.resourceName ?? button ?? '').trim()
    const resourceType = String(payload.resourceType ?? '界面').trim()
    if (!button && !resourceName && resourceType === '界面') return

    client.post('/audit/track', {
      action: payload.action || '点击',
      resourceType,
      resourceId: payload.resourceId,
      resourceName,
      button,
      module: payload.module || location.pathname,
      diffJson: payload.diffJson,
    }).catch(() => {})
  }, [user, location.pathname])

  // Kept for existing callers. Global click capture records the click with trackEvent.
  // Do not put Chinese labels into request headers; browsers reject non-Latin-1 header values.
  const trackClick = useCallback((buttonLabel: string) => {
    const label = String(buttonLabel ?? '').trim()
    if (!label) return
  }, [])

  // For pure read/view operations that have no backend call,
  // we can fire a lightweight audit event directly
  const trackView = useCallback((resourceType: string, resourceName: string) => {
    trackEvent({
      action:       '查看',
      resourceType,
      resourceName,
      button:       '查看',
      module:       location.pathname,
    })
  }, [trackEvent, location.pathname])

  return { trackClick, trackView, trackEvent }
}
