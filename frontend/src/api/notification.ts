import client from './client'

export interface NotificationItem {
  id:        string
  event:     string
  title:     string
  body:      string
  link?:     string
  isRead:    boolean
  refId?:    string
  refType?:  string
  createdAt: string
}

export interface NotificationPreference {
  inAppEnabled:   boolean
  emailEnabled:   boolean
  webhookEnabled: boolean
  webhookUrl:     string
  eventSwitches:  Record<string, boolean>
}

export const NOTIFICATION_CHANGED_EVENT = 'atop:notifications-changed'

export function notifyNotificationChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(NOTIFICATION_CHANGED_EVENT))
}

export const notificationApi = {
  list: (params: { page?: number; pageSize?: number; status?: 'all' | 'unread' | 'read' } = {}) =>
    client.get<{ data: { items: NotificationItem[]; total: number; unreadCount: number; page: number; pageSize: number } }>(
      '/notifications',
      { params: { page: params.page, pageSize: params.pageSize, status: params.status === 'all' ? undefined : params.status } }
    ).then(r => r.data.data),

  recent: () =>
    client.get<{ data: { items: NotificationItem[]; unreadCount: number } }>('/notifications/recent')
      .then(r => r.data.data),

  get: (id: string) =>
    client.get<{ data: NotificationItem }>(`/notifications/item/${id}`)
      .then(r => r.data.data),

  unreadCount: () =>
    client.get<{ data: { count: number } }>('/notifications/unread')
      .then(r => r.data.data.count),

  markRead: (id: string) =>
    client.put(`/notifications/item/${id}/read`).then(r => r.data),

  markAllRead: () =>
    client.put('/notifications/all/read').then(r => r.data),

  batchUpdate: (ids: string[], isRead: boolean) =>
    client.put('/notifications/batch', { ids, isRead }).then(r => r.data),

  batchDelete: (ids: string[]) =>
    client.delete('/notifications/batch', { data: { ids } }).then(r => r.data),

  delete: (id: string) =>
    client.delete(`/notifications/item/${id}`).then(r => r.data),

  getPreference: () =>
    client.get<{ data: NotificationPreference }>('/notifications/preference')
      .then(r => r.data.data),

  updatePreference: (pref: NotificationPreference) =>
    client.put('/notifications/preference', pref).then(r => r.data),
}

export const EVENT_LABELS: Record<string, string> = {
  pipeline_complete: '流水线完成',
  pipeline_failed:   '流水线失败',
  pipeline_aborted:  '流水线中止',
  user_disabled:     '账户被禁用',
  password_reset:    '密码被重置',
}

export const EVENT_ICONS: Record<string, string> = {
  pipeline_complete: '✅',
  pipeline_failed:   '❌',
  pipeline_aborted:  '⚠️',
  user_disabled:     '🔒',
  password_reset:    '🔑',
}
