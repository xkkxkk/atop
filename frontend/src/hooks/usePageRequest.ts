import { useEffect, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { requestCancelManager } from '@/api/client'

/**
 * 页面级请求取消 hook
 * 
 * 用法：
 * ```tsx
 * function MyPage() {
 *   const { getSignal } = usePageRequest()
 *   
 *   useEffect(() => {
 *     client.get('/api/data', { signal: getSignal() })
 *   }, [getSignal])
 * }
 * ```
 * 
 * 当页面切换时，所有通过 getSignal() 创建的请求都会被自动取消
 */
export function usePageRequest() {
  const location = useLocation()
  const pageKey = useRef(location.pathname)
  const requestIds = useRef<string[]>([])

  // 页面切换时取消所有请求
  useEffect(() => {
    const currentPageKey = pageKey.current

    return () => {
      // 组件卸载时取消该页面的所有请求
      requestCancelManager.cancelPage(currentPageKey)
      requestIds.current = []
    }
  }, [])

  // 更新 pageKey
  useEffect(() => {
    pageKey.current = location.pathname
  }, [location.pathname])

  // 获取一个 AbortSignal，用于传给 axios 请求
  const getSignal = useCallback(() => {
    const { id, signal } = requestCancelManager.create(pageKey.current)
    requestIds.current.push(id)
    return signal
  }, [])

  // 手动取消当前页面所有请求
  const cancelAll = useCallback(() => {
    requestCancelManager.cancelPage(pageKey.current)
    requestIds.current = []
  }, [])

  return { getSignal, cancelAll }
}

/**
 * 简化版：自动取消的 fetch wrapper
 * 用于 SWR 等场景
 */
export function createCancellableFetcher(pageKey: string) {
  return async <T>(url: string): Promise<T> => {
    const { signal } = requestCancelManager.create(pageKey)
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Fetch failed')
    return response.json()
  }
}
