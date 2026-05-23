import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Button, Card, Checkbox, Drawer, Empty, Input, List, Modal, Pagination,
  Segmented, Space, Spin, Tag, Tooltip, message,
} from 'antd'
import {
  BellOutlined, CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined,
  EyeInvisibleOutlined, LinkOutlined, MailOutlined, ReloadOutlined,
  WarningOutlined, LockOutlined, KeyOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  EVENT_LABELS,
  NOTIFICATION_CHANGED_EVENT,
  notificationApi,
  notifyNotificationChanged,
  type NotificationItem,
} from '@/api/notification'
import PageHeader from '@/components/common/PageHeader'
import RelativeTimeText from '@/components/common/RelativeTimeText'

type StatusFilter = 'all' | 'unread' | 'read'

const PAGE_SIZE = 12

function eventIcon(event: string) {
  const map: Record<string, React.ReactNode> = {
    pipeline_complete: <CheckCircleOutlined />,
    pipeline_failed: <CloseCircleOutlined />,
    pipeline_aborted: <WarningOutlined />,
    user_disabled: <LockOutlined />,
    password_reset: <KeyOutlined />,
  }
  return map[event] ?? <BellOutlined />
}

function eventTone(event: string) {
  if (event.includes('failed') || event.includes('disabled')) return 'red'
  if (event.includes('complete')) return 'green'
  if (event.includes('aborted')) return 'orange'
  if (event.includes('password')) return 'blue'
  return 'default'
}

function containsText(item: NotificationItem, keyword: string) {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true
  return `${item.title} ${item.body} ${EVENT_LABELS[item.event] ?? item.event}`.toLowerCase().includes(needle)
}

export default function NotificationCenterPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detail, setDetail] = useState<NotificationItem | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const swrKey = ['notifications-center', status, page]
  const { data, isLoading, mutate } = useSWR(
    swrKey,
    () => notificationApi.list({ status, page, pageSize: PAGE_SIZE }),
    { revalidateOnFocus: false },
  )

  const items = useMemo(
    () => (data?.items ?? []).filter(item => containsText(item, keyword)),
    [data?.items, keyword],
  )
  const selectedCount = selectedIds.length
  const currentPageIds = useMemo(() => items.map(item => item.id), [items])
  const currentPageSelectedCount = currentPageIds.filter(id => selectedIds.includes(id)).length
  const isCurrentPageAllSelected = currentPageIds.length > 0 && currentPageSelectedCount === currentPageIds.length
  const isCurrentPagePartSelected = currentPageSelectedCount > 0 && !isCurrentPageAllSelected

  useEffect(() => {
    const refreshNotifications = () => {
      setSelectedIds([])
      void mutate()
    }
    window.addEventListener(NOTIFICATION_CHANGED_EVENT, refreshNotifications)
    return () => window.removeEventListener(NOTIFICATION_CHANGED_EVENT, refreshNotifications)
  }, [mutate])

  const refresh = async () => {
    setSelectedIds([])
    await mutate()
  }

  const clearSelectionAndRefresh = async () => {
    setSelectedIds([])
    await mutate()
  }

  const toggleCurrentPage = () => {
    setSelectedIds(prev => {
      if (isCurrentPageAllSelected) {
        return prev.filter(id => !currentPageIds.includes(id))
      }
      return Array.from(new Set([...prev, ...currentPageIds]))
    })
  }

  const patchItemReadState = async (id: string, isRead: boolean) => {
    await mutate((prev) => {
      if (!prev) return prev
      const changed = prev.items.some(item => item.id === id && item.isRead !== isRead)
      return {
        ...prev,
        items: prev.items.map(item => item.id === id ? { ...item, isRead } : item),
        unreadCount: changed && isRead ? Math.max(0, prev.unreadCount - 1) : prev.unreadCount,
      }
    }, false)
  }

  const batchSetRead = async (isRead: boolean) => {
    if (!selectedCount) {
      message.warning('请选择消息')
      return
    }
    await notificationApi.batchUpdate(selectedIds, isRead)
    message.success(isRead ? '已标记为已读' : '已标记为未读')
    notifyNotificationChanged()
    await clearSelectionAndRefresh()
  }

  const batchDelete = async () => {
    if (!selectedCount) {
      message.warning('请选择消息')
      return
    }
    Modal.confirm({
      title: `确认删除 ${selectedCount} 条消息？`,
      content: '删除后不可恢复，但不会影响运行记录和审计数据。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await notificationApi.batchDelete(selectedIds)
        message.success('消息已删除')
        notifyNotificationChanged()
        await clearSelectionAndRefresh()
      },
    })
  }

  const openDetail = async (item: NotificationItem) => {
    let nextItem = item
    if (!item.isRead) {
      nextItem = { ...item, isRead: true }
      await notificationApi.markRead(item.id).catch(() => {})
      await patchItemReadState(item.id, true)
      notifyNotificationChanged()
    }
    const latest = await notificationApi.get(item.id).catch(() => item)
    setDetail({ ...latest, isRead: latest.isRead || nextItem.isRead })
    setDetailOpen(true)
    void mutate()
  }

  const openLink = async (item: NotificationItem) => {
    if (!item.isRead) {
      await notificationApi.markRead(item.id).catch(() => {})
      await patchItemReadState(item.id, true)
      notifyNotificationChanged()
      void mutate()
    }
    if (item.link) navigate(item.link)
  }

  const markDetailRead = async () => {
    if (!detail) return
    await notificationApi.markRead(detail.id)
    message.success('已标记为已读')
    setDetail({ ...detail, isRead: true })
    await patchItemReadState(detail.id, true)
    notifyNotificationChanged()
  }

  return (
    <div className="atop-notification-center">
      <PageHeader
        title="消息通知"
        subtitle="集中查看你的平台提醒、流水线事件和账户安全消息，支持跨页选择与批量处理。"
      />

      <Card className="atop-notification-card">
        <div className="atop-notification-toolbar">
          <Segmented
            value={status}
            onChange={(v) => { setStatus(v as StatusFilter); setPage(1); setSelectedIds([]) }}
            options={[
              { label: '全部', value: 'all' },
              { label: '未读', value: 'unread' },
              { label: '已读', value: 'read' },
            ]}
          />
          <Input.Search
            allowClear
            placeholder="搜索标题、内容或事件类型"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="atop-notification-search"
          />
          <Button icon={<ReloadOutlined />} onClick={() => refresh()}>刷新</Button>
        </div>

        <div className="atop-notification-batchbar">
          <Space wrap>
            <Checkbox
              checked={isCurrentPageAllSelected}
              indeterminate={isCurrentPagePartSelected}
              disabled={currentPageIds.length === 0}
              onChange={toggleCurrentPage}
            >
              {isCurrentPageAllSelected ? '取消本页' : '本页全选'}
            </Checkbox>
            <span className="atop-notification-selected-count">
              已选择 <strong>{selectedCount}</strong> 条
            </span>
            {selectedCount > 0 && (
              <Button type="link" size="small" onClick={() => setSelectedIds([])}>
                清空选择
              </Button>
            )}
          </Space>
          <Space wrap>
            <Button icon={<CheckCircleOutlined />} disabled={!selectedCount} onClick={() => batchSetRead(true)}>
              标为已读
            </Button>
            <Button icon={<EyeInvisibleOutlined />} disabled={!selectedCount} onClick={() => batchSetRead(false)}>
              标为未读
            </Button>
            <Button danger icon={<DeleteOutlined />} disabled={!selectedCount} onClick={batchDelete}>
              批量删除
            </Button>
          </Space>
        </div>

        {isLoading ? (
          <div className="atop-notification-loading"><Spin /></div>
        ) : items.length === 0 ? (
          <Empty description="没有匹配的消息" className="atop-notification-page-empty" />
        ) : (
          <div className="atop-notification-scroll">
            <List
              className="atop-notification-list"
              dataSource={items}
              rowKey="id"
              renderItem={(item) => (
                <List.Item
                  className={`atop-notification-row${item.isRead ? '' : ' is-unread'}`}
                  onClick={() => openDetail(item)}
                >
                  <label className="atop-notification-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={(e) => {
                        setSelectedIds(prev => e.target.checked
                          ? Array.from(new Set([...prev, item.id]))
                          : prev.filter(id => id !== item.id))
                      }}
                      aria-label={`选择 ${item.title}`}
                    />
                  </label>
                  <div className="atop-notification-row-icon">{eventIcon(item.event)}</div>
                  <div className="atop-notification-row-main">
                    <div className="atop-notification-row-head">
                      <strong>{item.title}</strong>
                      {!item.isRead && <i aria-label="未读" />}
                    </div>
                    <p>{item.body}</p>
                    <Space size={8} wrap>
                      <Tag color={eventTone(item.event)}>{EVENT_LABELS[item.event] ?? item.event}</Tag>
                      {item.refType && <Tag>{item.refType}</Tag>}
                      <RelativeTimeText value={item.createdAt} className="atop-notification-row-time" />
                    </Space>
                  </div>
                  {item.link && (
                    <Tooltip title="打开关联页面">
                      <Button
                        type="text"
                        icon={<LinkOutlined />}
                        onClick={(e) => { e.stopPropagation(); void openLink(item) }}
                      />
                    </Tooltip>
                  )}
                </List.Item>
              )}
            />
          </div>
        )}

        <div className="atop-notification-pagination">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            showSizeChanger={false}
            onChange={(next) => setPage(next)}
          />
        </div>
      </Card>

      <Drawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={520}
        title={
          <div>
            <div className="atop-drawer-eyebrow">MESSAGE DETAIL</div>
            <div className="atop-drawer-title">消息详情</div>
          </div>
        }
      >
        {detail && (
          <div className="atop-notification-detail">
            <div className="atop-notification-detail-icon">{eventIcon(detail.event)}</div>
            <Tag color={eventTone(detail.event)}>{EVENT_LABELS[detail.event] ?? detail.event}</Tag>
            <h3>{detail.title}</h3>
            <p>{detail.body}</p>
            <div className="atop-notification-detail-meta">
              <span><MailOutlined /> 状态：{detail.isRead ? '已读' : '未读'}</span>
              <span>时间：<RelativeTimeText value={detail.createdAt} /></span>
              {detail.refType && <span>关联类型：{detail.refType}</span>}
              {detail.refId && <span>关联 ID：{detail.refId}</span>}
            </div>
            <Space wrap>
              {detail.link && <Button type="primary" icon={<LinkOutlined />} onClick={() => navigate(detail.link!)}>打开关联页面</Button>}
              {!detail.isRead && <Button onClick={markDetailRead}>标为已读</Button>}
            </Space>
          </div>
        )}
      </Drawer>
    </div>
  )
}
