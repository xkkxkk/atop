import client from './client'
import type { TestSet, PageResult } from '@/types'

export interface TestSetFilter {
  project?:     string
  environment?: string
  product?:     string
  os?:          string
  runType?:     string
  status?:      string
  keyword?:     string
  page?:        number
  pageSize?:    number
}

const unwrapPage = (r: any): PageResult<TestSet> => {
  const d = r.data.data
  return {
    items:    d?.items    ?? [],
    total:    d?.total    ?? 0,
    page:     d?.page     ?? 1,
    pageSize: d?.pageSize ?? 20,
  }
}

const unwrap = <T>(r: any): T => r.data.data

export const testSetApi = {
  list: (params?: TestSetFilter) =>
    client.get('/test-sets', { params }).then(unwrapPage),

  get: (id: string) =>
    client.get(`/test-sets/${id}`).then(unwrap<TestSet>),

  create: (data: Partial<TestSet>) =>
    client.post('/test-sets', data).then(unwrap<TestSet>),

  update: (id: string, data: Partial<TestSet>) =>
    client.put(`/test-sets/${id}`, data).then(unwrap<TestSet>),

  delete: (id: string) =>
    client.delete(`/test-sets/${id}`).then((r) => r.data),

  updateStatus: (id: string, status: 'enabled' | 'disabled') =>
    client.put(`/test-sets/${id}/status`, { status }).then((r) => r.data),

  batchUpdateStatus: (ids: string[], status: 'enabled' | 'disabled') =>
    client.put('/test-sets/batch-status', { ids, status }).then((r) => r.data),

  previewJson: (id: string) =>
    client.get(`/test-sets/${id}/preview-json`).then(unwrap<object>),

  triggerSingle: (_id: string) =>
    Promise.reject(new Error('Deprecated: use matchPipelines instead')),

  matchPipelines: (ids: string[]) =>
    client.post('/test-sets/match-pipelines', { ids }).then(unwrap<{
      items: Array<{ id: string; name: string; project: string; environment: string; product: string; os: string; runType: string }>
      total: number
    }>),

  clone: (id: string, name?: string) =>
    client.post(`/test-sets/${id}/clone`, name ? { name } : {}).then(unwrap<TestSet>),
}
