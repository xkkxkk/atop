import { Button, Empty, Tooltip } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { usePermission } from '@/hooks/usePermission'

interface EmptyStateProps {
  description?: string
  createLabel?: string
  onCreate?: () => void
  /** 权限控制：资源名 */
  resource?: string
  /** 权限控制：操作名，默认 create */
  action?: string
}

export default function EmptyState({
  description = '暂无数据',
  createLabel,
  onCreate,
  resource,
  action = 'create',
}: EmptyStateProps) {
  const { can } = usePermission()
  
  // 如果指定了 resource，检查权限
  const hasPermission = resource ? can(resource, action) : true
  const showButton = onCreate && createLabel

  if (!showButton) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center' }}>
        <Empty
          description={<span style={{ color: '#9C9A92', fontSize: 13 }}>{description}</span>}
          imageStyle={{ height: 60 }}
        />
      </div>
    )
  }

  return (
    <div style={{ padding: '40px 0', textAlign: 'center' }}>
      <Empty
        description={<span style={{ color: '#9C9A92', fontSize: 13 }}>{description}</span>}
        imageStyle={{ height: 60 }}
      >
        {hasPermission ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {createLabel}
          </Button>
        ) : (
          <Tooltip title="无权限，请联系管理员">
            <span style={{ display: 'inline-block' }}>
              <Button type="primary" icon={<PlusOutlined />} disabled>
                {createLabel}
              </Button>
            </span>
          </Tooltip>
        )}
      </Empty>
    </div>
  )
}
