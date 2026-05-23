import { useRef, useState, type PointerEvent } from 'react'

const CLEAR_DISTANCE = 46

interface DraggableUnreadBadgeProps {
  count: number
  className?: string
  title?: string
  onClear: () => Promise<void> | void
}

interface DragState {
  active: boolean
  clearing: boolean
  startX: number
  startY: number
  x: number
  y: number
}

const initialDrag: DragState = {
  active: false,
  clearing: false,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
}

function formatCount(count: number) {
  return count > 99 ? '99+' : String(count)
}

export default function DraggableUnreadBadge({
  count,
  className = '',
  title = '拖拽后松开，可将全部未读消息标为已读',
  onClear,
}: DraggableUnreadBadgeProps) {
  const pointerIdRef = useRef<number | null>(null)
  const [drag, setDrag] = useState<DragState>(initialDrag)

  if (count <= 0) return null

  const distance = Math.hypot(drag.x, drag.y)
  const isArmed = drag.active && distance >= CLEAR_DISTANCE

  const resetDrag = (clearing = false) => {
    setDrag({ ...initialDrag, clearing })
  }

  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (drag.clearing) return
    event.preventDefault()
    event.stopPropagation()
    pointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      active: true,
      clearing: false,
      startX: event.clientX,
      startY: event.clientY,
      x: 0,
      y: 0,
    })
  }

  const handlePointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    if (!drag.active || pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setDrag(prev => ({
      ...prev,
      x: event.clientX - prev.startX,
      y: event.clientY - prev.startY,
    }))
  }

  const handlePointerUp = async (event: PointerEvent<HTMLSpanElement>) => {
    if (!drag.active || pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    pointerIdRef.current = null

    if (!isArmed) {
      resetDrag()
      return
    }

    resetDrag(true)
    try {
      await onClear()
    } finally {
      resetDrag()
    }
  }

  const handlePointerCancel = (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    pointerIdRef.current = null
    resetDrag()
  }

  return (
    <span
      className={`atop-draggable-badge-wrap ${className}`.trim()}
      title={title}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {drag.active && <span className="atop-draggable-badge-anchor" />}
      <span
        className={`atop-draggable-badge${drag.active ? ' is-dragging' : ''}${isArmed ? ' is-armed' : ''}${drag.clearing ? ' is-clearing' : ''}`}
        style={{ transform: `translate(${drag.x}px, ${drag.y}px) scale(${isArmed ? 1.08 : 1})` }}
        role="button"
        aria-label={`未读消息 ${count} 条，拖拽后松开可全部标为已读`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {formatCount(count)}
      </span>
    </span>
  )
}
