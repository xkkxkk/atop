import client from './client'
import type { UserRecord, AuditLog, PageResult } from '@/types'

const unwrap = <T>(r: any): T => r.data.data
const unwrapPage = <T>(r: any): PageResult<T> => {
  const d = r.data.data
  return { items: d?.items ?? [], total: d?.total ?? 0, page: d?.page ?? 1, pageSize: d?.pageSize ?? 20 }
}

export const userApi = {
  list: (params?: {
    keyword?: string; role?: string; status?: string
    page?: number; pageSize?: number
  }) =>
    client.get('/admin/users', { params }).then(unwrapPage<UserRecord>),

  create: (data: Partial<UserRecord> & { password?: string }) =>
    client.post('/admin/users', data).then(unwrap<UserRecord>),

  update: (id: string, data: Partial<UserRecord>) =>
    client.put(`/admin/users/${id}`, data).then((r) => r.data),

  updateStatus: (id: string, status: 'active' | 'disabled') =>
    client.put(`/admin/users/${id}/status`, { status }).then((r) => r.data),

  resetPassword: (id: string) =>
    client.post(`/admin/users/${id}/reset-password`)
      .then(unwrap<{ tempPassword: string; emailSent?: boolean; expiresAt?: string; note?: string }>),

  delete: (id: string) =>
    client.delete(`/admin/users/${id}`)
      .then((r: any) => r.data),

  getHistory: (id: string) =>
    client.get(`/admin/users/${id}/history`)
      .then((r: any) => r.data.data ?? []),

  batchImport: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return client.post('/admin/users/batch-import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r: any) => r.data)
  },
}

export const auditApi = {
  list: (params?: {
    keyword?: string; action?: string; resourceType?: string
    startDate?: string; endDate?: string; page?: number; pageSize?: number
  }) =>
    client.get('/admin/audit', { params }).then(unwrapPage<AuditLog>),

  export: async (params?: {
    keyword?: string; action?: string; resourceType?: string
    startDate?: string; endDate?: string
  }) => {
    const resp = await client.get('/admin/audit/export', {
      params,
      responseType: 'blob',
    })
    const url  = URL.createObjectURL(new Blob([resp.data]))
    const link = document.createElement('a')
    link.href  = url
    link.download = `audit_${new Date().toISOString().slice(0,10)}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  },
}
