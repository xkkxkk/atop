import { useState, useRef, useCallback, useEffect } from 'react'
import { Drawer } from 'antd'
import type { DrawerProps } from 'antd'

interface ResizableDrawerProps extends Omit<DrawerProps, 'width'> {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
}

/**
 * A Drawer that can be resized by dragging the left edge.
 * Works for placement="right" drawers only.
 */
export default function ResizableDrawer({
  defaultWidth = 860,
  minWidth = 480,
  maxWidth = 1400,
  children,
  ...props
}: ResizableDrawerProps) {
  const [width, setWidth]     = useState(defaultWidth)
  const dragging              = useRef(false)
  const startX                = useRef(0)
  const startWidth            = useRef(0)

  const maxAllowedWidth = useCallback(() => (
    Math.min(maxWidth, Math.max(minWidth, window.innerWidth - 80))
  ), [maxWidth, minWidth])

  const clampWidth = useCallback((nextWidth: number) => (
    Math.min(maxAllowedWidth(), Math.max(minWidth, nextWidth))
  ), [maxAllowedWidth, minWidth])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current   = true
    startX.current     = e.clientX
    startWidth.current = width
    document.body.style.cursor    = 'ew-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta    = startX.current - e.clientX
      setWidth(clampWidth(startWidth.current + delta))
    }
    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [clampWidth])

  useEffect(() => {
    if (props.open) {
      setWidth(width => clampWidth(width))
    }
  }, [props.open, clampWidth])

  return (
    <Drawer {...props} width={width}>
      {/* Drag handle on left edge */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: 6,
          cursor: 'ew-resize',
          zIndex: 10,
          background: 'transparent',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(56,139,253,0.25)')}
        onMouseLeave={e => { if (!dragging.current) e.currentTarget.style.background = 'transparent' }}
        title="拖动调整宽度"
      >
        {/* Visual indicator */}
        <div style={{
          position: 'absolute',
          left: 2, top: '50%',
          transform: 'translateY(-50%)',
          width: 2, height: 40,
          borderRadius: 1,
          background: 'rgba(56,139,253,0.4)',
          opacity: 0,
          transition: 'opacity 0.15s',
        }} className="drag-indicator" />
      </div>
      {children}
    </Drawer>
  )
}
