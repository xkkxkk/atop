import { http, HttpResponse, delay } from 'msw'
import {
  MOCK_USER, MOCK_DIMENSIONS, MOCK_JENKINS, MOCK_AGENT_LABELS,
  MOCK_VARS, MOCK_TEST_SETS, MOCK_PIPELINES, MOCK_PIPELINE_RUN,
  MOCK_TASK_RUNS, MOCK_USERS, MOCK_AUDIT_LOGS,
} from './data'

const API = '/api'
const D = 200

function paginate<T>(items: T[], page = 1, pageSize = 20) {
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

export const handlers = [
  http.post(`${API}/auth/login`, async ({ request }) => {
    await delay(D)
    const body = (await request.json()) as { email: string; password: string }
    if (body.email && body.password) {
      return HttpResponse.json({
        code: 'OK',
        message: 'success',
        data: {
          accessToken: 'mock-access-token-xyz',
          mustChangePwd: false,
          user: { ...MOCK_USER, mustChangePwd: false },
        },
      })
    }
    return HttpResponse.json({ code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' }, { status: 401 })
  }),

  http.post(`${API}/auth/refresh`, async () => {
    await delay(100)
    return HttpResponse.json({
      code: 'OK',
      message: 'success',
      data: { accessToken: 'mock-access-token-refreshed' },
    })
  }),

  http.post(`${API}/auth/logout`, async () => {
    await delay(100)
    return HttpResponse.json({ code: 'OK', message: 'success', data: { ok: true } })
  }),

  http.get(`${API}/dimension-dict`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const dim = url.searchParams.get('dimension')
    const data = dim ? MOCK_DIMENSIONS.filter((d) => d.dimension === dim) : MOCK_DIMENSIONS
    return HttpResponse.json(data)
  }),

  http.post(`${API}/dimension-dict`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ id: `d${Date.now()}`, ...body })
  }),

  http.put(`${API}/dimension-dict/:id`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json(body)
  }),

  http.delete(`${API}/dimension-dict/:id`, async () => {
    await delay(D)
    return HttpResponse.json({ ok: true })
  }),

  http.get(`${API}/settings/jenkins`, async () => {
    await delay(D)
    return HttpResponse.json(MOCK_JENKINS)
  }),

  http.post(`${API}/settings/jenkins/:id/ping`, async ({ params }) => {
    await delay(600)
    const inst = MOCK_JENKINS.find((j) => j.id === params.id)
    if (inst?.status === 'unreachable') {
      return HttpResponse.json({ status: 'unreachable' })
    }
    return HttpResponse.json({ status: 'ok', version: '2.462.1', latencyMs: 45 })
  }),

  http.post(`${API}/settings/jenkins/:id/sync-agents`, async () => {
    await delay(800)
    return HttpResponse.json({ synced: 4 })
  }),

  http.get(`${API}/settings/agent-labels`, async () => {
    await delay(D)
    return HttpResponse.json(MOCK_AGENT_LABELS)
  }),

  http.get(`${API}/settings/vars`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const scope = url.searchParams.get('scope')
    const data = scope ? MOCK_VARS.filter((v) => v.scope === scope) : MOCK_VARS
    return HttpResponse.json(data)
  }),

  http.post(`${API}/settings/vars`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ id: `v${Date.now()}`, ...body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  }),

  http.put(`${API}/settings/vars/:id`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ ...body, updatedAt: new Date().toISOString() })
  }),

  http.delete(`${API}/settings/vars/:id`, async () => {
    await delay(D)
    return HttpResponse.json({ ok: true })
  }),

  http.get(`${API}/test-sets`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const project = url.searchParams.get('project')
    const env = url.searchParams.get('environment')
    const product = url.searchParams.get('product')
    const status = url.searchParams.get('status')
    const keyword = url.searchParams.get('keyword')
    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...MOCK_TEST_SETS]
    if (project) items = items.filter((t) => t.project === project)
    if (env) items = items.filter((t) => t.environment === env)
    if (product) items = items.filter((t) => t.product === product)
    if (status) items = items.filter((t) => t.status === status)
    if (keyword) items = items.filter((t) => t.name.toLowerCase().includes(keyword.toLowerCase()))

    return HttpResponse.json(paginate(items, page, pageSize))
  }),

  http.get(`${API}/test-sets/:id`, async ({ params }) => {
    await delay(D)
    const ts = MOCK_TEST_SETS.find((t) => t.id === params.id)
    if (!ts) return HttpResponse.json({ code: 'NOT_FOUND', message: '测试集不存在' }, { status: 404 })
    return HttpResponse.json(ts)
  }),

  http.post(`${API}/test-sets`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ id: `ts${Date.now()}`, ...body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { status: 201 })
  }),

  http.put(`${API}/test-sets/:id`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ ...body, updatedAt: new Date().toISOString() })
  }),

  http.delete(`${API}/test-sets/:id`, async () => {
    await delay(D)
    return HttpResponse.json({ ok: true })
  }),

  http.put(`${API}/test-sets/:id/status`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as { status: string }
    return HttpResponse.json({ status: body.status })
  }),

  http.get(`${API}/test-sets/:id/preview-json`, async ({ params }) => {
    await delay(300)
    const ts = MOCK_TEST_SETS.find((t) => t.id === params.id)
    return HttpResponse.json({
      task_id: 'preview-task-id',
      platform_webhook_url: 'http://atop.internal:8080/api/webhook/task/...',
      agent_label: ts?.agentLabel ?? 'V3_CMODEL',
      timeout_minutes: 120,
      setup: ts?.configJson.setup ?? {},
      execCmds: ts?.configJson.execCmds ?? [],
      shared_libs: { 'sh/system/download_utils.sh': 'IyEvYmluL2Jhc2g...' },
      teardown: ts?.configJson.teardown ?? {},
    })
  }),

  http.post(`${API}/test-sets/:id/run`, async () => {
    await delay(400)
    return HttpResponse.json({ runId: `run-single-${Date.now()}` })
  }),

  http.get(`${API}/pipelines`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const proj = url.searchParams.get('project')
    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
    const items = proj ? MOCK_PIPELINES.filter((p) => p.project === proj) : MOCK_PIPELINES
    return HttpResponse.json(paginate(items, page, pageSize))
  }),

  http.get(`${API}/pipelines/:id`, async ({ params }) => {
    await delay(D)
    const pl = MOCK_PIPELINES.find((p) => p.id === params.id)
    if (!pl) return HttpResponse.json({ code: 'NOT_FOUND', message: '流水线不存在' }, { status: 404 })
    return HttpResponse.json(pl)
  }),

  http.post(`${API}/pipelines/:id/run`, async () => {
    await delay(500)
    return HttpResponse.json({ runId: 'run048' })
  }),

  http.get(`${API}/pipeline-runs`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    return HttpResponse.json(paginate([MOCK_PIPELINE_RUN], page, 20))
  }),

  http.get(`${API}/pipeline-runs/:id`, async () => {
    await delay(D)
    return HttpResponse.json(MOCK_PIPELINE_RUN)
  }),

  http.post(`${API}/pipeline-runs/:id/abort`, async () => {
    await delay(300)
    return HttpResponse.json({ ok: true })
  }),

  http.get(`${API}/pipeline-runs/:id/tasks`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    return HttpResponse.json(paginate(MOCK_TASK_RUNS, page, 20))
  }),

  http.post(`${API}/task-runs/:id/check-log`, async () => {
    await delay(400)
    return HttpResponse.json({ logStatus: 'available', logCheckedAt: new Date().toISOString() })
  }),

  http.post(`${API}/task-runs/batch-check-log`, async () => {
    await delay(200)
    return HttpResponse.json({ jobId: `batch-${Date.now()}` })
  }),

  http.get(`${API}/task-runs/batch-check-log/:jobId`, async () => {
    await delay(600)
    return HttpResponse.json({
      total: 5,
      done: 5,
      cancelled: false,
      results: MOCK_TASK_RUNS.slice(0, 5).map((t) => ({
        id: t.id,
        logStatus: 'available',
        logCheckedAt: new Date().toISOString(),
      })),
    })
  }),

  http.post(`${API}/task-runs/:id/abort`, async () => {
    await delay(300)
    return HttpResponse.json({ ok: true })
  }),

  http.get(`${API}/task-runs/:id/stages`, async ({ params }) => {
    await delay(D)
    const tr = MOCK_TASK_RUNS.find((t) => t.id === params.id)
    return HttpResponse.json(tr?.stageSummaryJson ?? [])
  }),

  http.get(`${API}/admin/users`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    return HttpResponse.json(paginate(MOCK_USERS, page, 20))
  }),

  http.post(`${API}/admin/users`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as object
    return HttpResponse.json({ id: `u${Date.now()}`, ...body, status: 'active', createdAt: new Date().toISOString() }, { status: 201 })
  }),

  http.put(`${API}/admin/users/:id/status`, async ({ request }) => {
    await delay(D)
    const body = await request.json() as { status: string }
    return HttpResponse.json({ status: body.status })
  }),

  http.post(`${API}/admin/users/:id/reset-password`, async () => {
    await delay(D)
    return HttpResponse.json({
      tempPassword: 'R8#mK2sQ%7xLp4?A',
      emailSent: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
  }),

  http.post(`${API}/users/batch-import`, async () => {
    await delay(800)
    return HttpResponse.json({ success: 3, failed: 0, errors: [] })
  }),

  http.get(`${API}/admin/audit`, async ({ request }) => {
    await delay(D)
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    return HttpResponse.json(paginate(MOCK_AUDIT_LOGS, page, 20))
  }),
]
