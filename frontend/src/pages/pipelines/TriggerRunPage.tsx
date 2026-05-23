import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import {
  Alert, Button, Divider, Input, Modal, Select, Spin, Tag, message,
} from 'antd'
import {
  ApartmentOutlined,
  BranchesOutlined,
  CaretRightOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  LoadingOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { pipelineApi } from '@/api/pipelines'
import { jenkinsApi } from '@/api/settings'
import PageHeader from '@/components/common/PageHeader'
import PipelineFlowPreview, {
  pipelineJobName as jobNameOf,
  pipelineNodeName as nodeName,
  pipelineNodeTypeClass as nodeTypeClass,
  pipelineNodeTypeLabel as nodeTypeLabel,
} from '@/components/pipeline/PipelineFlowPreview'
import type { PipelineDAGConfig, PipelineDAGEdge, PipelineParam } from '@/types'
import { FIELD_LIMITS, inputLimit } from '@/utils/fieldLimits'
import { getTriggerTypeMeta } from '@/utils/pipelineDag'

type PreviewSelection =
  | { kind: 'canvas' }
  | { kind: 'node'; id: string }

type PreflightIssue = {
  key: string
  level: 'error' | 'warning' | 'ok'
  title: string
  detail: string
}

function parseDagConfig(raw: unknown): PipelineDAGConfig | null {
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

function triggerTypeLabel(type?: string) {
  if (type === 'cron') return 'Cron 定时'
  if (type === 'webhook') return 'Webhook 外部触发'
  if (type === 'child') return '子流水线触发'
  return '手动触发'
}

function edgeTypeLabel(type?: PipelineDAGEdge['type']) {
  return type === 'detached' ? '异步启动' : '等待完成'
}

function mappingEntries(mapping?: Record<string, string>) {
  return Object.entries(mapping ?? {}).filter(([key, value]) => String(key).trim() || String(value).trim())
}

function isEmptyParamValue(value: unknown) {
  return String(value ?? '').trim() === ''
}

export default function TriggerRunPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data: pipeline, isLoading } = useSWR(
    id ? `pipeline-${id}` : null,
    () => pipelineApi.get(id!),
  )

  const params = useMemo<PipelineParam[]>(() => pipeline?.params ?? [], [pipeline?.params])
  const dag = useMemo(() => parseDagConfig(pipeline?.dagConfigJson), [pipeline?.dagConfigJson])
  const dagNodes = dag?.nodes ?? []
  const dagEdges = (dag?.designer?.edges?.length ? dag.designer.edges : dag?.edges) ?? []
  const incoming = useMemo(() => new Set(dagEdges.map((edge) => edge.target)), [dagEdges])
  const startNodes = dagNodes.filter((node) => !incoming.has(node.id))
  const jenkinsNodes = dagNodes.filter((node) => node.type === 'jenkins')
  const detachedCount = dagEdges.filter((edge) => edge.type === 'detached').length

  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [adHocParams, setAdHocParams] = useState<{ key: string; value: string }[]>([])
  const [remark, setRemark] = useState('')
  const [selectedPreviewTarget, setSelectedPreviewTarget] = useState<PreviewSelection>({ kind: 'canvas' })
  const [submitting, setSubmitting] = useState(false)
  const [checkingRun, setCheckingRun] = useState(false)
  const [preflightError, setPreflightError] = useState('')

  const { data: instances = [] } = useSWR('jenkins-list', jenkinsApi.list)
  const [jenkinsStatus, setJenkinsStatus] = useState<Record<string, 'ok' | 'fail' | 'loading'>>({})

  useEffect(() => {
    if (instances.length === 0) return
    instances.forEach((inst) => {
      setJenkinsStatus((state) => ({ ...state, [inst.id]: 'loading' }))
      jenkinsApi.ping(inst.id).then((res) => {
        setJenkinsStatus((state) => ({ ...state, [inst.id]: res.status === 'ok' ? 'ok' : 'fail' }))
      }).catch(() => {
        setJenkinsStatus((state) => ({ ...state, [inst.id]: 'fail' }))
      })
    })
  }, [instances.length])

  useEffect(() => {
    const defaults: Record<string, string> = {}
    params.forEach((param) => { defaults[param.name] = param.defaultValue ?? '' })
    setParamValues((prev) => ({ ...defaults, ...prev }))
  }, [params])

  useEffect(() => {
    if (selectedPreviewTarget.kind === 'node' && !dagNodes.some((node) => node.id === selectedPreviewTarget.id)) {
      setSelectedPreviewTarget({ kind: 'canvas' })
    }
  }, [dagNodes, selectedPreviewTarget])

  const instanceNameMap = instances.reduce<Record<string, string>>((acc, inst) => {
    acc[inst.id] = inst.name
    return acc
  }, {})

  const boundInstanceId = pipeline?.jenkinsBindings?.find((binding) => binding.jenkinsInstanceId)?.jenkinsInstanceId ?? ''
  const boundInstance = instances.find((inst) => inst.id === boundInstanceId)
  const boundStatus = boundInstanceId ? jenkinsStatus[boundInstanceId] : undefined
  const boundHealthy = !!boundInstanceId && (boundStatus === 'ok' || (!boundStatus && boundInstance?.status === 'ok'))
  const isChecking = Object.values(jenkinsStatus).some((status) => status === 'loading')
  const triggerMeta = getTriggerTypeMeta(pipeline?.triggerType, pipeline?.cronExpr)

  const localPreflightIssues = useMemo<PreflightIssue[]>(() => {
    const issues: PreflightIssue[] = []

    if (!dagNodes.length) {
      issues.push({
        key: 'empty-dag',
        level: 'error',
        title: '执行画布为空',
        detail: '当前流水线没有可执行组件，无法触发运行。',
      })
    } else if (!startNodes.length) {
      issues.push({
        key: 'no-start-node',
        level: 'error',
        title: '缺少起始组件',
        detail: '所有组件都有上游依赖，调度器无法找到第一步。',
      })
    }

    if (!boundInstanceId) {
      issues.push({
        key: 'jenkins-binding',
        level: 'error',
        title: '未绑定 Jenkins 实例',
        detail: '请先在流水线画布配置可用 Jenkins 实例。',
      })
    } else if (boundStatus === 'fail' || !boundHealthy) {
      issues.push({
        key: 'jenkins-health',
        level: boundStatus === 'loading' ? 'warning' : 'error',
        title: boundStatus === 'loading' ? 'Jenkins 正在检测' : 'Jenkins 连接异常',
        detail: boundStatus === 'loading' ? '连接检测完成前建议等待结果。' : '当前绑定实例不可用，请检查实例状态或网络。',
      })
    }

    jenkinsNodes
      .filter((node) => !jobNameOf(node))
      .slice(0, 5)
      .forEach((node) => {
        issues.push({
          key: `job-${node.id}`,
          level: 'error',
          title: 'Jenkins Job 未配置',
          detail: `${nodeName(node)} 缺少 Job 名称。`,
        })
      })

    params
      .filter((param) => param.required && isEmptyParamValue(paramValues[param.name] ?? param.defaultValue))
      .forEach((param) => {
        issues.push({
          key: `param-${param.name}`,
          level: 'error',
          title: '必填参数缺失',
          detail: `${param.name} 不能为空。`,
        })
      })

    const seenAdHocKeys = new Set<string>()
    adHocParams.forEach((param, index) => {
      const key = param.key.trim()
      if (!key && String(param.value ?? '').trim()) {
        issues.push({
          key: `adhoc-empty-${index}`,
          level: 'error',
          title: '临时参数缺少 key',
          detail: `第 ${index + 1} 行已有 value，但没有参数名。`,
        })
      }
      if (key) {
        const normalized = key.toLowerCase()
        if (seenAdHocKeys.has(normalized)) {
          issues.push({
            key: `adhoc-duplicate-${index}`,
            level: 'error',
            title: '临时参数重复',
            detail: `${key} 出现多次，请保留一项。`,
          })
        }
        seenAdHocKeys.add(normalized)
      }
    })

    if (issues.length === 0) {
      issues.push({
        key: 'ready',
        level: 'ok',
        title: '运行前检查就绪',
        detail: '画布、Jenkins 绑定和本次参数没有发现阻断项。',
      })
    }

    return issues
  }, [adHocParams, boundHealthy, boundInstanceId, boundStatus, dagNodes, jenkinsNodes, paramValues, params, startNodes])

  const localPreflightErrors = localPreflightIssues.filter((issue) => issue.level === 'error')

  const selectedNode = selectedPreviewTarget.kind === 'node'
    ? dagNodes.find((node) => node.id === selectedPreviewTarget.id)
    : undefined
  const selectedIncomingEdges = selectedNode
    ? dagEdges.filter((edge) => edge.target === selectedNode.id)
    : []
  const selectedOutgoingEdges = selectedNode
    ? dagEdges.filter((edge) => edge.source === selectedNode.id)
    : []
  const relationEdges = selectedNode
    ? dagEdges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    : dagEdges
  const selectedNodeDescription = String(selectedNode?.config?.description ?? '').trim()

  const getAllParams = () => {
    const merged: Record<string, string> = { ...paramValues }
    adHocParams.forEach((param) => {
      if (param.key) merged[param.key] = param.value
    })
    return merged
  }

  const hasAnyParams = params.length > 0 || adHocParams.some((param) => param.key)

  const doTrigger = async () => {
    if (!id) return
    setSubmitting(true)
    try {
      const res = await pipelineApi.triggerRun(id, {
        filterType: 'all',
        runtimeParams: getAllParams(),
        remark: remark || undefined,
      })
      message.success('已提交流水线运行，正在进入执行详情')
      navigate(`/runs/${res.runId}`)
    } catch {
      /* handled by request interceptor */
    } finally {
      setSubmitting(false)
    }
  }

  const openParamConfirm = () => {
    const allParams = getAllParams()
    Modal.confirm({
      title: '确认提交流水线',
      width: 640,
      icon: null,
      content: (
        <div className="atop-run-confirm">
          <div className="atop-run-confirm-summary">
            <span>组件 {dagNodes.length} 个</span>
            <span>Jenkins {jenkinsNodes.length} 个</span>
            <span>起始 {startNodes.length} 个</span>
            <span>参数 {Object.keys(allParams).length} 项</span>
          </div>
          {Object.keys(allParams).length === 0 ? (
            <div className="atop-run-confirm-empty">本次没有运行参数</div>
          ) : (
            <div className="atop-run-confirm-list">
              {Object.entries(allParams).map(([key, value], index) => (
                <div key={key} className="atop-run-confirm-row">
                  <span>{index + 1}</span>
                  <strong>{key}</strong>
                  <em>{value || '(空)'}</em>
                </div>
              ))}
            </div>
          )}
          {remark && <div className="atop-run-confirm-remark">备注：{remark}</div>}
        </div>
      ),
      okText: '确认运行',
      cancelText: '返回修改',
      onOk: doTrigger,
    })
  }

  const runPreflight = async () => {
    if (!id) return false
    setCheckingRun(true)
    setPreflightError('')
    try {
      await pipelineApi.validateRun(id)
      return true
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || '运行前检查未通过，请检查 Jenkins 实例和组件 Job 配置'
      setPreflightError(msg)
      return false
    } finally {
      setCheckingRun(false)
    }
  }

  const handleTrigger = async () => {
    if (localPreflightErrors.length > 0) {
      setPreflightError(localPreflightErrors.map((issue) => issue.detail).join('；'))
      message.error('运行前检查未通过，请先处理阻断项')
      return
    }
    const ok = await runPreflight()
    if (!ok) return
    if (!hasAnyParams) {
      doTrigger()
      return
    }
    openParamConfirm()
  }

  const renderParamInput = (param: PipelineParam) => {
    const value = paramValues[param.name] ?? param.defaultValue ?? ''
    const setValue = (nextValue?: string) => setParamValues({ ...paramValues, [param.name]: nextValue ?? '' })
    if (param.type === 'boolean') {
      return (
        <Select
          size="small"
          value={value || undefined}
          placeholder="选择开关值"
          options={[{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }]}
          onChange={setValue}
          allowClear
        />
      )
    }
    if (param.type === 'choice' && param.choices?.length) {
      return (
        <Select
          size="small"
          value={value || undefined}
          placeholder="选择参数值"
          options={param.choices.map((choice) => ({ label: choice, value: choice }))}
          onChange={setValue}
          allowClear
        />
      )
    }
    if (param.type === 'number') {
      return (
        <Input
          size="small"
          type="number"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={param.defaultValue || '输入数字'}
          maxLength={FIELD_LIMITS.paramValue}
        />
      )
    }
    return (
      <Input.TextArea
        size="small"
        autoSize={{ minRows: 1, maxRows: 4 }}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={param.defaultValue || '输入值'}
        {...inputLimit('paramValue')}
      />
    )
  }

  const renderReadonlyMappingSection = (title: string, entries: Array<[string, string]>, emptyText: string) => (
    <div className="atop-trigger-readonly-section">
      <strong>{title}</strong>
      {entries.length === 0 ? (
        <div className="atop-trigger-empty-line">{emptyText}</div>
      ) : (
        <div className="atop-trigger-readonly-list">
          {entries.map(([key, value]) => (
            <div key={`${title}-${key}-${value}`} className="atop-trigger-readonly-row">
              <span className="atop-trigger-readonly-key">{key || '-'}</span>
              <span className="atop-trigger-readonly-value">{value || '-'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  if (isLoading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
  }

  return (
    <div className="atop-trigger-workbench">
      <PageHeader
        eyebrow="PIPELINE EXECUTION"
        title={`执行流水线 · ${pipeline?.name ?? ''}`}
        subtitle="点击画布查看全局配置，点击组件查看只读属性、参数入口和执行关系。"
      />

      <div className="atop-trigger-topbar">
        <div className="atop-trigger-titleline">
          <DeploymentUnitOutlined />
          <div>
            <strong>{pipeline?.name ?? '流水线'}</strong>
            <span>Jenkins 实例：{boundInstance?.name || instanceNameMap[boundInstanceId] || boundInstanceId || '未选择'}</span>
          </div>
        </div>
        <div className="atop-trigger-metrics">
          <div><span>组件</span><strong>{dagNodes.length}</strong></div>
          <div><span>Jenkins</span><strong>{jenkinsNodes.length}</strong></div>
          <div><span>起始</span><strong>{startNodes.length}</strong></div>
          <div><span>异步</span><strong>{detachedCount}</strong></div>
        </div>
      </div>

      <div className="atop-trigger-layout">
        <section className="atop-trigger-canvas-panel">
          <div className="atop-trigger-section-head">
            <div>
              <strong>执行画布</strong>
              <span>点组件看只读配置，点空白画布看流水线基础属性和触发方式。</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Tag color={selectedNode ? 'blue' : 'gold'}>{selectedNode ? '查看组件' : '查看画布'}</Tag>
              <Tag color={dagEdges.length ? 'blue' : 'default'}>{dagEdges.length} 条连线</Tag>
            </div>
          </div>

          <PipelineFlowPreview
            nodes={dagNodes}
            edges={dagEdges}
            selectedNodeId={selectedNode?.id}
            canvasActive={selectedPreviewTarget.kind === 'canvas'}
            onSelectCanvas={() => setSelectedPreviewTarget({ kind: 'canvas' })}
            onSelectNode={(nodeId) => setSelectedPreviewTarget({ kind: 'node', id: nodeId })}
          />

          <div className="atop-trigger-node-detail">
            <div className="atop-trigger-node-card">
              <div className="atop-trigger-node-card-head">
                <span className={selectedNode ? nodeTypeClass(selectedNode.type) : 'is-canvas'}>
                  {selectedNode?.type === 'pipeline'
                    ? <ApartmentOutlined />
                    : selectedNode
                      ? <BranchesOutlined />
                      : <DeploymentUnitOutlined />}
                </span>
                <div>
                  <strong>{selectedNode ? nodeName(selectedNode) : '画布属性'}</strong>
                  <small>{selectedNode ? `${nodeTypeLabel(selectedNode.type)} 配置（只读）` : '基础信息、触发方式和 Jenkins 绑定（只读）'}</small>
                </div>
              </div>

              {selectedNode ? (
                <>
                  <div className="atop-trigger-node-facts">
                    <div><span>组件类型</span><strong>{nodeTypeLabel(selectedNode.type)}</strong></div>
                    {selectedNode.type === 'jenkins' && <div><span>Jenkins Job</span><strong>{jobNameOf(selectedNode) || '未配置'}</strong></div>}
                    {selectedNode.type === 'pipeline' && <div><span>子流水线</span><strong>{selectedNode.refId || '未选择'}</strong></div>}
                    <div><span>上游组件</span><strong>{selectedIncomingEdges.length}</strong></div>
                    <div><span>下游组件</span><strong>{selectedOutgoingEdges.length}</strong></div>
                    <div><span>Join 策略</span><strong>{selectedNode.joinPolicy === 'any' ? '任一成功即可继续' : '等待全部完成'}</strong></div>
                    <div><span>失败策略</span><strong>{selectedNode.failurePolicy === 'continue' ? '继续向后' : '失败阻断'}</strong></div>
                  </div>

                  {selectedNodeDescription && (
                    <div className="atop-trigger-readonly-note">{selectedNodeDescription}</div>
                  )}

                  {selectedNode.type === 'jenkins' && renderReadonlyMappingSection(
                    'Jenkins 参数映射',
                    mappingEntries(selectedNode.inputMapping),
                    '当前没有参数映射。',
                  )}

                  {selectedNode.type === 'pipeline' && renderReadonlyMappingSection(
                    '子流水线参数映射',
                    mappingEntries(selectedNode.paramMapping),
                    '当前没有参数映射。',
                  )}

                  {selectedNode.type === 'jenkins' && (
                    <div className="atop-trigger-readonly-section">
                      <strong>输出字段</strong>
                      {selectedNode.requiredOutputs?.length ? (
                        <div className="atop-trigger-chip-list">
                          {selectedNode.requiredOutputs.map((field) => (
                            <Tag key={field}>{field}</Tag>
                          ))}
                        </div>
                      ) : (
                        <div className="atop-trigger-empty-line">当前没有输出字段。</div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="atop-trigger-node-facts">
                    <div><span>流水线名称</span><strong>{pipeline?.name || '-'}</strong></div>
                    <div><span>触发方式</span><strong>{triggerTypeLabel(pipeline?.triggerType)}</strong></div>
                    <div><span>Jenkins 实例</span><strong>{boundInstance?.name || instanceNameMap[boundInstanceId] || boundInstanceId || '未绑定'}</strong></div>
                    <div><span>预定义参数</span><strong>{params.length} 项</strong></div>
                    <div><span>组件数量</span><strong>{dagNodes.length}</strong></div>
                    <div><span>起始组件</span><strong>{startNodes.length}</strong></div>
                    <div><span>异步连线</span><strong>{detachedCount}</strong></div>
                    <div><span>Cron 表达式</span><strong>{pipeline?.cronExpr || '-'}</strong></div>
                  </div>

                  <div className="atop-trigger-readonly-note">
                    画布属性已经固定，只读展示当前版本的基础信息、触发方式和 Jenkins 绑定。
                  </div>
                </>
              )}
            </div>

            <div className="atop-trigger-node-card">
              <div className="atop-trigger-node-card-head">
                <span><ThunderboltOutlined /></span>
                <div>
                  <strong>{selectedNode ? '关联关系' : '执行关系'}</strong>
                  <small>{selectedNode ? '仅展示当前焦点组件的上下游关系。' : '等待连线阻塞下游，异步连线只负责启动。'}</small>
                </div>
              </div>
              <div className="atop-trigger-flow-list">
                {relationEdges.length === 0 ? (
                  <div className="atop-trigger-empty-line">
                    {selectedNode ? '当前组件没有连线关系。' : '没有连线时，多个起始组件会并行启动。'}
                  </div>
                ) : relationEdges.map((edge) => {
                  const source = dagNodes.find((node) => node.id === edge.source)
                  const target = dagNodes.find((node) => node.id === edge.target)
                  return (
                    <div key={edge.id || `${edge.source}-${edge.target}`}>
                      <strong>{nodeName(source)}</strong>
                      <span>{edgeTypeLabel(edge.type)}</span>
                      <strong>{nodeName(target)}</strong>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        <aside className="atop-trigger-side-panel">
          <div className="atop-trigger-section-head">
            <div>
              <strong>本次运行</strong>
              <span>参数只影响本次提交，保存配置请回到编辑页。</span>
            </div>
            <Tag color={boundHealthy ? 'green' : 'red'}>{boundHealthy ? 'Jenkins 正常' : '待检查'}</Tag>
          </div>

          {preflightError && (
            <Alert
              className="atop-run-preflight-alert"
              type="error"
              showIcon
              message="运行前检查未通过"
              description={preflightError}
            />
          )}

          <div className="atop-run-checklist">
            <div className="atop-run-checklist-head">
              {isChecking ? <LoadingOutlined /> : localPreflightErrors.length ? <WarningOutlined /> : <CheckCircleOutlined />}
              <strong>运行前检查</strong>
              <Tag color={localPreflightErrors.length ? 'red' : 'green'}>
                {localPreflightErrors.length ? `${localPreflightErrors.length} 个阻断项` : '可提交'}
              </Tag>
            </div>
            {localPreflightIssues.map((issue) => (
              <div key={issue.key} className={`atop-run-checklist-row is-${issue.level}`}>
                {issue.level === 'ok' ? <CheckCircleOutlined /> : <WarningOutlined />}
                <span>
                  <strong>{issue.title}</strong>
                  <small>{issue.detail}</small>
                </span>
              </div>
            ))}
            <div className="atop-run-checklist-row is-info">
              <CheckCircleOutlined />
              <span>
                <strong>后端连通性复核</strong>
                <small>提交前仍会调用服务端校验组件和 Jenkins Job 可访问性。</small>
              </span>
            </div>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {params.length > 0 && (
            <div className="atop-trigger-param-section">
              <div className="atop-trigger-section-head">
                <div>
                  <strong>预定义参数</strong>
                  <span>来自流水线画布属性，提交前可覆盖默认值。</span>
                </div>
                <Tag color="blue">{params.length} 项</Tag>
              </div>
              <div className="atop-trigger-param-list">
                {params.map((param) => (
                  <div key={param.name} className="atop-trigger-param-row">
                    <div className="atop-trigger-param-meta">
                      <strong>{param.name}</strong>
                      <span>{param.description || `类型：${param.type || 'string'}`}</span>
                    </div>
                    <div className="atop-trigger-param-control">{renderParamInput(param)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="atop-trigger-param-section">
            <div className="atop-trigger-section-head">
              <div>
                <strong>临时参数</strong>
                <span>同名时覆盖预定义参数，并传给 Jenkins 组件。</span>
              </div>
              <Button
                size="small"
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => setAdHocParams([...adHocParams, { key: '', value: '' }])}
              >
                添加
              </Button>
            </div>
            {adHocParams.length === 0 ? (
              <div className="atop-trigger-empty-line">暂无临时参数。</div>
            ) : adHocParams.map((param, index) => (
              <div key={index} className="atop-trigger-adhoc-row">
                <Input
                  size="small"
                  style={{ width: 150 }}
                  placeholder="key"
                  {...inputLimit('paramName')}
                  value={param.key}
                  onChange={(event) => {
                    const copy = [...adHocParams]
                    copy[index] = { ...copy[index], key: event.target.value }
                    setAdHocParams(copy)
                  }}
                />
                <span style={{ color: '#9C9A92' }}>=</span>
                <Input
                  size="small"
                  style={{ flex: 1 }}
                  placeholder="value"
                  {...inputLimit('paramValue')}
                  value={param.value}
                  onChange={(event) => {
                    const copy = [...adHocParams]
                    copy[index] = { ...copy[index], value: event.target.value }
                    setAdHocParams(copy)
                  }}
                />
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setAdHocParams(adHocParams.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </div>

          <div className="atop-trigger-param-section">
            <div className="atop-trigger-section-head">
              <div>
                <strong>备注</strong>
                <span>展示在运行记录中，方便追踪本次提交目的。</span>
              </div>
            </div>
            <Input
              size="small"
              placeholder="本次运行说明"
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              {...inputLimit('remark')}
            />
          </div>
        </aside>
      </div>

      <div className="atop-action-dock">
        <div className="atop-action-dock-copy">
          <span>触发方式</span>
          <strong>{triggerMeta.label}</strong>
          <Tag className="atop-trigger-meta-tag" style={{ background: '#F5F5F4', color: triggerMeta.color, border: 'none' }}>
            {triggerMeta.description}
          </Tag>
        </div>
        <Button onClick={() => navigate(-1)}>取消</Button>
        <Button
          type="primary"
          icon={<CaretRightOutlined />}
          loading={submitting || checkingRun}
          disabled={!boundInstanceId || !dagNodes.length || localPreflightErrors.length > 0 || submitting || checkingRun}
          onClick={handleTrigger}
          style={{ minWidth: 168 }}
        >
          {checkingRun ? '运行前检查中' : '确认运行'}
        </Button>
      </div>
    </div>
  )
}
