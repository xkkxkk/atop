import type { ReactNode } from 'react'

interface MetricCardProps {
  label: string
  value: ReactNode
  icon?: ReactNode
  color?: string
  foot?: ReactNode
  size?: 'default' | 'large'
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info'
}

export default function MetricCard({
  label,
  value,
  icon,
  color,
  foot,
  size = 'default',
  tone = 'default',
}: MetricCardProps) {
  return (
    <div className={`atop-metric-card atop-metric-card-${tone}${size === 'large' ? ' atop-metric-card-large' : ''}`}>
      <div className="atop-metric-head">
        <div className="atop-metric-label">{label}</div>
        {icon && <span className="atop-metric-icon">{icon}</span>}
      </div>
      <div className="atop-metric-value" style={{
        fontSize: size === 'large' ? 30 : 26,
        fontWeight: 800,
        color: color ?? '#1A1A18',
        lineHeight: 1.1,
        letterSpacing: '-0.02em',
      }}>
        {value}
      </div>
      {foot && <div className={tone === 'success' ? 'atop-metric-foot atop-metric-foot-good' : 'atop-metric-foot'}>{foot}</div>}
    </div>
  )
}
