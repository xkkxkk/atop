import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Dropdown, Button, Spin, Empty, Tooltip } from 'antd'
import {
  BellOutlined, CheckOutlined, DeleteOutlined, CheckCircleOutlined,
  CloseCircleOutlined, WarningOutlined, LockOutlined, KeyOutlined,
} from '@ant-design/icons'
import {
  NOTIFICATION_CHANGED_EVENT,
  notificationApi,
  notifyNotificationChanged,
  type NotificationItem,
} from '@/api/notification'
import { useAuthStore } from '@/store/auth'
import RelativeTimeText from '@/components/common/RelativeTimeText'

function NotificationIcon({ event }: { event: string }) {
  const iconMap: Record<string, ReactNode> = {
    pipeline_complete: <CheckCircleOutlined />,
    pipeline_failed: <CloseCircleOutlined />,
    pipeline_aborted: <WarningOutlined />,
    user_disabled: <LockOutlined />,
    password_reset: <KeyOutlined />,
  }
  return <div className="atop-notification-mini-icon">{iconMap[event] ?? <BellOutlined />}</div>
}

function NotiItem({
  item, onRead, onDelete,
}: {
  item: NotificationItem
  onRead: (id: string) => void
  onDelete: (id: string) => void
}) {
  const navigate = useNavigate()

  const handleClick = () => {
    if (!item.isRead) onRead(item.id)
    if (item.link) navigate(item.link)
  }

  return (
    <div
      className={`atop-notification-mini-item${item.isRead ? '' : ' is-unread'}`}
      onClick={handleClick}
      role={item.link ? 'button' : undefined}
      tabIndex={item.link ? 0 : undefined}
    >
      <NotificationIcon event={item.event} />
      <div className="atop-notification-mini-body">
        <div className="atop-notification-mini-title">
          <span>{item.title}</span>
          {!item.isRead && <i aria-label="未读" />}
        </div>
        <div className="atop-notification-mini-text">{item.body}</div>
        <RelativeTimeText value={item.createdAt} className="atop-notification-mini-time" />
      </div>
      <div className="atop-notification-mini-actions" onClick={e => e.stopPropagation()}>
        {!item.isRead && (
          <Tooltip title="标为已读">
            <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => onRead(item.id)} />
          </Tooltip>
        )}
        <Tooltip title="删除">
          <Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => onDelete(item.id)} />
        </Tooltip>
      </div>
    </div>
  )
}

export default function NotificationBell() {
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    const poll = () => {
      notificationApi.unreadCount().then(setUnread).catch(() => {})
    }
    poll()
    const id = setInterval(poll, 15_000)
    return () => clearInterval(id)
  }, [isAuthenticated])

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const data = await notificationApi.recent()
      setItems(data.items)
      setUnread(data.unreadCount)
    } catch {
      // Header notification should never interrupt the main workflow.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) loadList()
  }, [open, loadList])

  useEffect(() => {
    if (!isAuthenticated) return
    const refresh = () => {
      if (open) {
        void loadList()
        return
      }
      notificationApi.unreadCount().then(setUnread).catch(() => {})
    }
    window.addEventListener(NOTIFICATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(NOTIFICATION_CHANGED_EVENT, refresh)
  }, [isAuthenticated, loadList, open])

  const handleRead = async (id: string) => {
    await notificationApi.markRead(id).catch(() => {})
    setItems(prev => prev.map(i => i.id === id ? { ...i, isRead: true } : i))
    setUnread(prev => Math.max(0, prev - 1))
    notifyNotificationChanged()
  }

  const handleDelete = async (id: string) => {
    await notificationApi.delete(id).catch(() => {})
    const deleted = items.find(i => i.id === id)
    setItems(prev => prev.filter(i => i.id !== id))
    if (deleted && !deleted.isRead) setUnread(prev => Math.max(0, prev - 1))
    notifyNotificationChanged()
  }

  const handleMarkAllRead = async () => {
    await notificationApi.markAllRead().catch(() => {})
    setItems(prev => prev.map(i => ({ ...i, isRead: true })))
    setUnread(0)
    notifyNotificationChanged()
  }

  const dropdownContent = (
    <div className="atop-notification-popover">
      <div className="atop-notification-popover-head">
        <div>
          <div className="atop-notification-popover-kicker">LATEST 10</div>
          <strong>消息提醒</strong>
        </div>
        {unread > 0 && <span className="atop-notification-count">{unread}</span>}
        {unread > 0 && (
          <Button type="link" size="small" onClick={handleMarkAllRead}>全部已读</Button>
        )}
      </div>

      <div className="atop-notification-mini-list">
        {loading ? (
          <div className="atop-notification-loading"><Spin size="small" /></div>
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" className="atop-notification-empty" />
        ) : (
          items.map(item => (
            <NotiItem
              key={item.id}
              item={item}
              onRead={handleRead}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      {isAuthenticated && (
        <div className="atop-notification-popover-foot">
          <Button type="primary" block onClick={() => { setOpen(false); navigate('/notifications') }}>
            查看全部消息
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      dropdownRender={() => dropdownContent}
      trigger={['click']}
      placement="bottomRight"
    >
      <Badge count={unread} size="small" offset={[-2, 2]} style={{ boxShadow: 'none' }}>
        <Button
          type="text"
          aria-label="打开消息提醒"
          icon={<BellOutlined style={{ fontSize: 18 }} />}
          style={{ color: unread > 0 ? '#2563EB' : '#9C9A92' }}
        />
      </Badge>
    </Dropdown>
  )
}
