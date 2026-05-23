import client from './client'

export interface SharedLib {
  id: string
  name: string
  lang: 'sh' | 'py'
  scope: 'system' | 'project'
  projectId?: string
  content: string
  contentHash: string
  version: number
  refCount: number
  description?: string
  createdBy: string
  createdAt: string
  updatedBy?: string
  updatedAt: string
}

export interface SharedLibVersion {
  id: string
  libId: string
  version: number
  content: string
  changedBy: string
  createdAt: string
}

const unwrap = <T>(r: any): T => r.data.data

export const libsApi = {
  list: (params?: { scope?: string; lang?: string; projectId?: string; keyword?: string }) =>
    client.get('/shared-libs', { params })
      .then((r) => (r.data.data ?? []) as SharedLib[]),

  get: (id: string) =>
    client.get(`/shared-libs/${id}`).then(unwrap<SharedLib>),

  create: (data: Partial<SharedLib>) =>
    client.post('/shared-libs', data).then(unwrap<SharedLib>),

  update: (id: string, data: Partial<SharedLib>) =>
    client.put(`/shared-libs/${id}`, data).then(unwrap<SharedLib>),

  delete: (id: string) =>
    client.delete(`/shared-libs/${id}`).then((r) => r.data),

  listVersions: (id: string) =>
    client.get(`/shared-libs/${id}/versions`)
      .then((r) => (r.data.data ?? []) as SharedLibVersion[]),

  rollback: (id: string, version: number) =>
    client.post(`/shared-libs/${id}/rollback`, { version }).then((r) => r.data),
}
