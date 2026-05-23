import { Modal, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'

const { Text } = Typography

interface ConfirmOptions {
  title: string
  content?: string
  okText?: string
  okDanger?: boolean
  onOk: () => void | Promise<void>
}

export function showConfirm({ title, content, okText = '确认', okDanger = true, onOk }: ConfirmOptions) {
  Modal.confirm({
    title,
    icon: <ExclamationCircleOutlined style={{ color: okDanger ? '#DC2626' : '#2563EB' }} />,
    content: content ? <Text type="secondary" style={{ fontSize: 13 }}>{content}</Text> : null,
    okText,
    cancelText: '取消',
    okButtonProps: { danger: okDanger },
    onOk,
  })
}
