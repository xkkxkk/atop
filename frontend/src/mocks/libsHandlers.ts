import { http, HttpResponse, delay } from 'msw'
import type { SharedLib } from '@/api/libs'

const MOCK_LIBS: SharedLib[] = [
  {
    id: 'lib01', name: 'download_utils', lang: 'sh', scope: 'system',
    content: '#!/bin/bash\n# 下载工具函数库\n\ndownload_with_retry() {\n  local url="$1"\n  local dest="$2"\n  local retries="${3:-3}"\n  for i in $(seq 1 $retries); do\n    wget -q -O "$dest" "$url" && return 0\n    echo "Retry $i/$retries..."\n    sleep 2\n  done\n  return 1\n}',
    contentHash: 'abc123', version: 3, refCount: 12,
    description: '通用下载工具，支持重试机制',
    createdBy: '张三', createdAt: '2025-01-10T00:00:00Z', updatedAt: '2025-03-01T00:00:00Z',
  },
  {
    id: 'lib02', name: 'report_utils', lang: 'py', scope: 'system',
    content: '# 报告工具函数库\nimport json\n\ndef format_error_summary(log_lines, max_lines=100):\n    """提取错误摘要"""\n    errors = [l for l in log_lines if any(k in l for k in ["ERROR", "FATAL", "Exception"])]\n    last = log_lines[-max_lines:] if len(log_lines) > max_lines else log_lines\n    combined = list(dict.fromkeys(errors + last))\n    return "\\n".join(combined)[:2000]',
    contentHash: 'def456', version: 5, refCount: 8,
    description: '测试报告格式化工具',
    createdBy: '张三', createdAt: '2025-01-15T00:00:00Z', updatedAt: '2025-02-20T00:00:00Z',
  },
  {
    id: 'lib03', name: 'env_check', lang: 'sh', scope: 'project', projectId: 'V2_SOFTWARE',
    content: '#!/bin/bash\n# V2 环境检查\n\ncheck_v2_env() {\n  echo "Checking V2 environment..."\n  [ -d "/workspace" ] || { echo "ERROR: workspace not found"; exit 1; }\n  echo "V2 environment OK"\n}',
    contentHash: 'ghi789', version: 2, refCount: 4,
    description: 'V2 项目环境检查脚本',
    createdBy: '李四', createdAt: '2025-02-01T00:00:00Z', updatedAt: '2025-03-10T00:00:00Z',
  },
  {
    id: 'lib04', name: 'v2_log_parser', lang: 'py', scope: 'project', projectId: 'V2_SOFTWARE',
    content: '# V2 日志解析\nimport re\n\ndef parse_test_result(log_file):\n    """解析 V2 测试结果"""\n    with open(log_file) as f:\n        content = f.read()\n    passed = len(re.findall(r"PASS", content))\n    failed = len(re.findall(r"FAIL", content))\n    total = passed + failed\n    return {"passed": passed, "failed": failed, "total": total,\n            "pass_rate": round(passed/total*100, 1) if total else 0}',
    contentHash: 'jkl012', version: 1, refCount: 3,
    description: 'V2 测试日志结果解析',
    createdBy: '李四', createdAt: '2025-02-15T00:00:00Z', updatedAt: '2025-02-15T00:00:00Z',
  },
]

export const libsHandlers = [
  http.get('/api/shared-libs', async ({ request }) => {
    await delay(200)
    const url     = new URL(request.url)
    const scope   = url.searchParams.get('scope')
    const lang    = url.searchParams.get('lang')
    const keyword = url.searchParams.get('keyword')
    let items = [...MOCK_LIBS]
    if (scope)   items = items.filter((l) => l.scope === scope)
    if (lang)    items = items.filter((l) => l.lang === lang)
    if (keyword) items = items.filter((l) => l.name.includes(keyword) || l.description?.includes(keyword))
    return HttpResponse.json(items)
  }),

  http.get('/api/shared-libs/:id', async ({ params }) => {
    await delay(150)
    const lib = MOCK_LIBS.find((l) => l.id === params.id)
    if (!lib) return HttpResponse.json({ code: 'NOT_FOUND', message: '函数库不存在' }, { status: 404 })
    return HttpResponse.json(lib)
  }),

  http.post('/api/shared-libs', async ({ request }) => {
    await delay(300)
    const body = await request.json() as Partial<SharedLib>
    return HttpResponse.json({
      id: `lib${Date.now()}`, ...body, version: 1, refCount: 0,
      contentHash: 'new', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, { status: 201 })
  }),

  http.put('/api/shared-libs/:id', async ({ request }) => {
    await delay(300)
    const body = await request.json() as Partial<SharedLib>
    return HttpResponse.json({ ...body, version: (body.version ?? 1) + 1, updatedAt: new Date().toISOString() })
  }),

  http.delete('/api/shared-libs/:id', async () => {
    await delay(200)
    return HttpResponse.json({ ok: true })
  }),

  http.get('/api/shared-libs/:id/versions', async ({ params }) => {
    await delay(200)
    const lib = MOCK_LIBS.find((l) => l.id === params.id)
    if (!lib) return HttpResponse.json([])
    return HttpResponse.json(
      Array.from({ length: Math.min(lib.version, 5) }, (_, i) => ({
        id: `v${i}`, libId: lib.id, version: lib.version - i,
        content: lib.content + (i > 0 ? `\n# v${lib.version - i}` : ''),
        changedBy: i % 2 === 0 ? '张三' : '李四',
        createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      }))
    )
  }),

  http.post('/api/shared-libs/:id/rollback', async () => {
    await delay(300)
    return HttpResponse.json({ ok: true })
  }),
]
