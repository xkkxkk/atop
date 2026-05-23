import axios, { AxiosHeaders, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { message } from 'antd'
import { useAuthStore } from '@/store/auth'
import type { ApiError } from '@/types'

class RequestCancelManager {
  private controllers = new Map<string, AbortController>()
  private pageControllers = new Map<string, Set<string>>()

  private genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  create(pageKey?: string): { id: string; signal: AbortSignal } {
    const id = this.genId()
    const controller = new AbortController()
    this.controllers.set(id, controller)

    if (pageKey) {
      if (!this.pageControllers.has(pageKey)) {
        this.pageControllers.set(pageKey, new Set())
      }
      this.pageControllers.get(pageKey)?.add(id)
    }

    return { id, signal: controller.signal }
  }

  remove(id: string): void {
    this.controllers.delete(id)
    for (const [, ids] of this.pageControllers) {
      ids.delete(id)
    }
  }

  cancelPage(pageKey: string): void {
    const ids = this.pageControllers.get(pageKey)
    if (!ids) {
      return
    }

    for (const id of ids) {
      const controller = this.controllers.get(id)
      if (controller) {
        controller.abort()
        this.controllers.delete(id)
      }
    }

    this.pageControllers.delete(pageKey)
  }

  cancelAll(): void {
    for (const [, controller] of this.controllers) {
      controller.abort()
    }
    this.controllers.clear()
    this.pageControllers.clear()
  }
}

export const requestCancelManager = new RequestCancelManager()

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

const refreshClient = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

let refreshing = false
let refreshQueue: Array<{ resolve: (token: string) => void; reject: (error: unknown) => void }> = []

function flushRefreshQueue(error?: unknown, token?: string) {
  const currentQueue = refreshQueue
  refreshQueue = []

  for (const item of currentQueue) {
    if (error) {
      item.reject(error)
      continue
    }
    if (token) {
      item.resolve(token)
    }
  }
}

function networkErrorMessage(error: AxiosError<ApiError>) {
  const detail = String(error.message ?? '')
  if (detail.includes('setRequestHeader')) {
    return '请求发送失败：浏览器拒绝了非法请求头，请刷新页面后重试'
  }
  return 'ATOP 平台接口未响应，请检查后端服务或 API 网关网络'
}

let lastGetErrorAt = 0
let lastGetErrorText = ''

function showThrottledGetError(text: string) {
  const now = Date.now()
  if (text === lastGetErrorText && now - lastGetErrorAt < 5000) {
    return
  }

  lastGetErrorAt = now
  lastGetErrorText = text
  message.error(text)
}

function redirectToLogin() {
  useAuthStore.getState().clearAuth()
  const currentPath = `${window.location.pathname}${window.location.search}`
  const returnUrl = encodeURIComponent(currentPath || '/dashboard')
  window.location.href = `/login?returnUrl=${returnUrl}`
}

function redirectToLoginWithMessage(messageText?: string) {
  if (messageText) {
    message.warning(messageText)
  }
  window.setTimeout(() => redirectToLogin(), 300)
}

client.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<ApiError>) => {
    if (axios.isCancel(error)) {
      return Promise.reject(error)
    }

    const status = error.response?.status
    const apiErr = error.response?.data
    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined
    const requestUrl = originalRequest?.url ?? ''

    if (status === 401 && requestUrl.includes('/auth/login')) {
      return Promise.reject(error)
    }

    if (status === 401 && requestUrl.includes('/auth/refresh')) {
      redirectToLoginWithMessage(apiErr?.message)
      return Promise.reject(error)
    }

    if (status === 401 && apiErr?.message?.includes('其他地方登录')) {
      redirectToLoginWithMessage(apiErr.message)
      return Promise.reject(error)
    }

    if (status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true

      if (refreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (newToken) => {
              const headers = AxiosHeaders.from(originalRequest.headers)
              headers.set('Authorization', `Bearer ${newToken}`)
              originalRequest.headers = headers
              resolve(client(originalRequest))
            },
            reject,
          })
        })
      }

      refreshing = true
      try {
        const resp = await refreshClient.post<{ data: { accessToken: string } }>('/auth/refresh', {})
        const newToken = resp.data.data.accessToken
        useAuthStore.getState().setAccessToken(newToken)
        flushRefreshQueue(undefined, newToken)
        const headers = AxiosHeaders.from(originalRequest.headers)
        headers.set('Authorization', `Bearer ${newToken}`)
        originalRequest.headers = headers
        return client(originalRequest)
      } catch (refreshError) {
        flushRefreshQueue(refreshError)
        const refreshAxiosError = refreshError as AxiosError<ApiError>
        redirectToLoginWithMessage(refreshAxiosError.response?.data?.message)
        return Promise.reject(refreshError)
      } finally {
        refreshing = false
      }
    }

    if (requestUrl.includes('/audit/track')) {
      return Promise.reject(error)
    }

    if (status === 403) {
      const method = error.config?.method?.toUpperCase() ?? 'GET'
      if (method === 'GET') {
        showThrottledGetError('无权限执行此操作，请联系管理员')
      }
      return Promise.reject(error)
    }

    if (status === 429) {
      return Promise.reject(error)
    }

    if ((error.config?.method ?? 'get').toUpperCase() !== 'GET') {
      return Promise.reject(error)
    }

    if (status === 500) {
      showThrottledGetError('服务器异常，请稍后重试')
      return Promise.reject(error)
    }

    if (apiErr?.message) {
      showThrottledGetError(apiErr.message)
    } else if (error.code === 'ECONNABORTED') {
      showThrottledGetError('请求超时，请稍后重试')
    } else if (!error.response) {
      showThrottledGetError(networkErrorMessage(error))
    }

    return Promise.reject(error)
  },
)

export default client
