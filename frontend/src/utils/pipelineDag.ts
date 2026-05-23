import type { Pipeline, PipelineDAGConfig, PipelineDAGEdge, PipelineDAGNode, TriggerType } from '@/types'

type TriggerMeta = {
  label: string
  color: string
  description: string
  detail: string
}

const TRIGGER_META: Record<string, Omit<TriggerMeta, 'detail'>> = {
  manual: {
    label: '手动',
    color: '#185FA5',
    description: '由用户在平台内手动触发运行。',
  },
  cron: {
    label: 'Cron',
    color: '#085041',
    description: '按定时表达式自动触发运行。',
  },
  webhook: {
    label: 'Webhook',
    color: '#633806',
    description: '由外部系统调用平台 Webhook 触发。',
  },
  child: {
    label: '子流水线',
    color: '#5F5E5A',
    description: '由上游流水线或组件继续触发。',
  },
}

export function parsePipelineDagConfig(raw?: Pipeline['dagConfigJson'] | unknown): PipelineDAGConfig | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as PipelineDAGConfig
    } catch {
      return null
    }
  }
  return raw as PipelineDAGConfig
}

export function getPipelineDagNodes(raw?: Pipeline['dagConfigJson'] | unknown): PipelineDAGNode[] {
  const dag = parsePipelineDagConfig(raw)
  return Array.isArray(dag?.nodes) ? dag.nodes : []
}

export function getPipelineDagEdges(raw?: Pipeline['dagConfigJson'] | unknown): PipelineDAGEdge[] {
  const dag = parsePipelineDagConfig(raw)
  if (Array.isArray(dag?.designer?.edges) && dag.designer.edges.length) return dag.designer.edges
  return Array.isArray(dag?.edges) ? dag.edges : []
}

export function getJenkinsDagNodes(raw?: Pipeline['dagConfigJson'] | unknown): PipelineDAGNode[] {
  return getPipelineDagNodes(raw).filter((node) => node.type === 'jenkins')
}

export function getPipelineJenkinsSummary(
  pipeline: Pick<Pipeline, 'dagConfigJson' | 'jenkinsBindings'>,
): {
  componentCount: number
  uniqueJobCount: number
  jobNames: string[]
} {
  const dagJobNames = getJenkinsDagNodes(pipeline.dagConfigJson)
    .map((node) => String(node.config?.jobName ?? '').trim())
    .filter(Boolean)

  const legacyJobNames = (pipeline.jenkinsBindings ?? [])
    .map((binding) => String(binding.jobName ?? '').trim())
    .filter(Boolean)

  const jobNames = Array.from(new Set(dagJobNames.length ? dagJobNames : legacyJobNames))
  const componentCount = dagJobNames.length || legacyJobNames.length

  return {
    componentCount,
    uniqueJobCount: jobNames.length,
    jobNames,
  }
}

export function getTriggerTypeMeta(triggerType?: TriggerType | string, cronExpr?: string | null): TriggerMeta {
  const base = TRIGGER_META[String(triggerType || 'manual')] ?? {
    label: String(triggerType || '未知'),
    color: '#5F5E5A',
    description: '当前触发类型没有预置说明。',
  }

  if (triggerType === 'cron') {
    return {
      ...base,
      detail: cronExpr
        ? `Cron 表达式：${cronExpr}\n${base.description}`
        : `未配置 Cron 表达式。\n${base.description}`,
    }
  }

  return {
    ...base,
    detail: base.description,
  }
}
