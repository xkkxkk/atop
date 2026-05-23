import type { CSSProperties, ReactNode } from 'react'
import { Tooltip } from 'antd'
import { fmtDatetime, fmtRelative } from '@/utils/format'

interface RelativeTimeTextProps {
  value?: string | null
  className?: string
  style?: CSSProperties
  emptyText?: ReactNode
}

export default function RelativeTimeText({
  value,
  className,
  style,
  emptyText = '—',
}: RelativeTimeTextProps) {
  if (!value) {
    return <span className={className} style={style}>{emptyText}</span>
  }

  return (
    <Tooltip title={fmtDatetime(value)}>
      <span className={className} style={{ cursor: 'help', ...style }}>
        {fmtRelative(value)}
      </span>
    </Tooltip>
  )
}
