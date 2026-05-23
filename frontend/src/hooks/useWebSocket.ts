import { useEffect, useRef, useCallback, useState } from 'react'

type WSStatus = 'connecting' | 'open' | 'closed' | 'error'

interface UseWebSocketOptions<T> {
  url: string | null          // null = don't connect
  onMessage: (data: T) => void
  enabled?: boolean
}

export function useWebSocket<T = unknown>({ url, onMessage, enabled = true }: UseWebSocketOptions<T>) {
  const wsRef        = useRef<WebSocket | null>(null)
  const retryCount   = useRef(0)
  const retryTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const [status, setStatus] = useState<WSStatus>('closed')

  const connect = useCallback(() => {
    if (!url || !enabled) return

    setStatus('connecting')
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('open')
      retryCount.current = 0
    }

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as T
        onMessageRef.current(data)
      } catch {
        // non-JSON message, ignore
      }
    }

    ws.onclose = () => {
      setStatus('closed')
      // Exponential back-off: 1s, 2s, 4s, 8s, 16s (max 5 retries)
      if (retryCount.current < 5) {
        const delay = Math.min(1000 * 2 ** retryCount.current, 30_000)
        retryCount.current++
        retryTimer.current = setTimeout(connect, delay)
      } else {
        setStatus('error')
      }
    }

    ws.onerror = () => {
      setStatus('error')
      ws.close()
    }
  }, [url, enabled])

  useEffect(() => {
    connect()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { status, send }
}
