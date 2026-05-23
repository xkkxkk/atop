import client from './client'
import type { User } from '@/types'

export interface LoginResponse {
  accessToken:   string
  mustChangePwd: boolean
  user:          User & { mustChangePwd: boolean }
}

export const authApi = {
  login: (data: { email: string; password: string }) =>
    client.post<{ data: LoginResponse }>('/auth/login', data)
      .then((r) => r.data.data),

  logout: () =>
    client.post('/auth/logout').catch(() => {}),

  refresh: () =>
    client.post<{ data: { accessToken: string } }>('/auth/refresh', {})
      .then((r) => r.data.data),

  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    client.post<{ data: LoginResponse }>('/auth/change-password', data)
      .then((r) => r.data.data),

  updateAvatar: (avatarUrl: string) =>
    client.put<{ data: { user: User } }>('/users/me/avatar', { avatarUrl })
      .then((r) => r.data.data.user),

  forgotPassword: (email: string) =>
    client.post<{ data: { message: string } }>('/auth/forgot-password', { email })
      .then((r) => r.data.data),

  validateResetToken: (token: string) =>
    client.get<{ data: { valid: boolean; reason?: string; email?: string; username?: string } }>(
      `/auth/validate-reset-token?token=${token}`
    ).then((r) => r.data.data),

  resetPasswordByToken: (token: string, newPassword: string) =>
    client.post<{ data: LoginResponse & { message?: string } }>('/auth/reset-password', { token, newPassword })
      .then((r) => r.data.data),
}
