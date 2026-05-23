import type { ReactNode } from 'react'

interface SectionTitleProps {
  icon: ReactNode
  title: ReactNode
  note?: ReactNode
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
}

export default function SectionTitle({
  icon,
  title,
  note,
  tone = 'info',
}: SectionTitleProps) {
  return (
    <div className="atop-section-heading">
      <span className={`atop-section-icon atop-section-icon-${tone}`}>{icon}</span>
      <div className="atop-section-copy">
        <div className="atop-panel-title">{title}</div>
        {note && <div className="atop-panel-note">{note}</div>}
      </div>
    </div>
  )
}
