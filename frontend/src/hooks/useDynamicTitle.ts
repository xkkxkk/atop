import { useEffect, useRef } from 'react'

const DEFAULT_TITLE = 'ATOP · 自动化测试编排平台'
const MONITORING_TITLE = '📡 监控中… · ATOP'

/**
 * When the tab is hidden, show a monitoring indicator.
 * When focus returns, restore the real page title.
 */
export function useDynamicTitle(pageTitle?: string) {
  const realTitle = pageTitle ? `${pageTitle} · ATOP` : DEFAULT_TITLE
  const blinkRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    document.title = realTitle
  }, [realTitle])

  useEffect(() => {
    const handleHide = () => {
      let toggled = false
      blinkRef.current = setInterval(() => {
        document.title = toggled ? MONITORING_TITLE : '· ATOP'
        toggled = !toggled
      }, 1500)
    }

    const handleShow = () => {
      if (blinkRef.current) { clearInterval(blinkRef.current); blinkRef.current = null }
      document.title = realTitle
    }

    document.addEventListener('visibilitychange', () => {
      document.hidden ? handleHide() : handleShow()
    })

    return () => {
      if (blinkRef.current) clearInterval(blinkRef.current)
      document.removeEventListener('visibilitychange', handleHide)
      document.removeEventListener('visibilitychange', handleShow)
    }
  }, [realTitle])
}
