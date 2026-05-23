import type { ReactNode } from 'react'
import { Space } from 'antd'

interface PageHeaderProps {
  title: ReactNode
  eyebrow?: string
  subtitle?: string
  extra?: ReactNode
}

export default function PageHeader({ title, eyebrow, subtitle, extra }: PageHeaderProps) {
  return (
    <div className={`atop-page-head${eyebrow ? ' atop-page-head-hero' : ''}`}>
      <div>
        {eyebrow && <div className="atop-page-eyebrow">{eyebrow}</div>}
        <div className={eyebrow ? 'atop-page-title' : 'atop-page-title atop-page-title-compact'}>{title}</div>
        {subtitle && (
          <div className="atop-page-subtitle">{subtitle}</div>
        )}
      </div>
      {extra && <Space size={8} wrap>{extra}</Space>}
    </div>
  )
}
