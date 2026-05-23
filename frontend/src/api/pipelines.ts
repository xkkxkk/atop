import client from './client'
import type { Pipeline, PipelineRun, TaskRun, PageResult, LogStatus } from '@/types'

const unwrap = <T>(r: any): T => r.data.data
const unwrapPage = <T>(r: any): PageResult<T> => {
  const d = r.data.data
  return { items: d?.items ?? [], total: d?.total ?? 0, page: d?.page ?? 1, pageSize: d?.pageSize ?? 20 }
}

export const pipelineApi = {
  list: (params?: {
    keyword?: string
    project?: string
    environment?: string
    product?: string
    os?: string
    runType?: string
    triggerType?: string
    lastRunStatus?: string
    page?: number
    pageSize?: number
  }) =>
    client.get('/pipelines', { params }).then(unwrapPage<Pipeline>),

  get: (id: string) =>
    client.get(`/pipelines/${id}`).then(unwrap<Pipeline>),

  create: (data: Partial<Pipeline>) =>
    client.post('/pipelines', data).then(unwrap<{ id: string; name: string }>),

  update: (id: string, data: Partial<Pipeline>) =>
    client.put(`/pipelines/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    client.delete(`/pipelines/${id}`).then((r) => r.data),

  validateRun: (id: string) =>
    client.post(`/pipelines/${id}/validate-run`)
      .then(unwrap<{ ok: boolean; bindingCount: number; checkedAt: string }>),

  triggerRun: (id: string, payload: {
    filterType?: string
    projects?: string[]
    tags?: string[]
    runtimeParams?: Record<string, string>
    remark?: string
  }) =>
    client.post(`/pipelines/${id}/run`, payload)
      .then(unwrap<{ runId: string; totalCount: number }>),
}

export const runApi = {
  list: (params?: { pipelineId?: string; status?: string; keyword?: string; startedBeforeMinutes?: number; page?: number; pageSize?: number }) =>
    client.get('/pipeline-runs', { params }).then(unwrapPage<PipelineRun>),

  get: (id: string) =>
    client.get(`/pipeline-runs/${id}`).then(unwrap<PipelineRun>),

  abort: (id: string) =>
    client.post(`/pipeline-runs/${id}/abort`).then((r) => r.data),

  rebuild: (id: string) =>
    client.post(`/pipeline-runs/${id}/rebuild`)
      .then(unwrap<{ runId: string; totalCount: number; fromRunId: string; mode?: string }>),

  getChildRuns: (id: string) =>
    client.get(`/pipeline-runs/${id}/children`).then((r) => r.data.data ?? []),

  getTaskRuns: (
    id: string,
    params?: { project?: string; status?: string; page?: number; pageSize?: number }
  ) =>
    client.get(`/pipeline-runs/${id}/tasks`, { params }).then(unwrapPage<TaskRun>),
}

export const taskRunApi = {
  abort: (id: string) =>
    client.post(`/task-runs/${id}/abort`).then((r) => r.data),

  getStages: (id: string) =>
    client.get(`/task-runs/${id}/stages`).then((r) => r.data.data ?? []),

  checkLog: (id: string) =>
    client.post(`/task-runs/${id}/check-log`)
      .then(unwrap<{ logStatus: LogStatus; logCheckedAt: string; jenkinsBuildUrl?: string }>),

  batchCheckLog: (taskRunIds: string[]) =>
    client.post('/task-runs/batch-check-log', { taskRunIds })
      .then(unwrap<{ jobId: string; total: number }>),
}
