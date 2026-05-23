import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { Alert, Button, Card, Empty, Spin, Tag, message } from 'antd'
import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ClusterOutlined,
  LinkOutlined,
  RedoOutlined,
  ReloadOutlined,
  StopOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { runApi } from '@/api/pipelines'
import EndOfListHint from '@/components/common/EndOfListHint'
import MetricCard from '@/components/common/MetricCard'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { showConfirm } from '@/components/common/ConfirmModal'
import type { TaskRun } from '@/types'
import { fmtDatetime, fmtDuration } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'

const ACTIVE_RUN_STATUSES = ['pending', 'submitting', 'queued_in_jenkins', 'waiting', 'running']
const FAILURE_TASK_STATUSES = ['failed', 'error', 'submit_failed', 'blocked']
const WAITING_TASK_STATUSES = ['pending', 'waiting', 'submitting', 'queued_in_jenkins']

const TASK_STATUS_META: Record<
  string,
  { label: string; color: string; tone: 'default' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  pending: { label: '等待中', color: '#8C8C8C', tone: 'default' },
  waiting: { label: '等待依赖', color: '#8C8C8C', tone: 'default' },
  submitting: { label: '提交中', color: '#2563EB', tone: 'info' },
  queued_in_jenkins: { label: 'Jenkins 排队中', color: '#2563EB', tone: 'info' },
  running: { label: '运行中', color: '#2563EB', tone: 'info' },
  success: { label: '成功', color: '#0F6E56', tone: 'success' },
  failed: { label: '失败', color: '#DC2626', tone: 'danger' },
  error: { label: '异常', color: '#DC2626', tone: 'danger' },
  submit_failed: { label: '提交失败', color: '#DC2626', tone: 'danger' },
  blocked: { label: '已阻塞', color: '#BA7517', tone: 'warning' },
  aborted: { label: '已中止', color: '#854F0B', tone: 'warning' },
}

type ReportedStage = {
  id?: string
  stageKey?: string
  stageName?: string
  status?: string
  nodeName?: string
  durationMs?: number
  errorSummary?: string
}

function taskTitle(task: TaskRun) {
  return task.testSetName || task.dagNodeId || task.id
}

function taskTypeLabel(task: TaskRun) {
  if (task.dagNodeType === 'jenkins') return 'Jenkins 组件'
  if (task.dagNodeType === 'pipeline') return '子流水线'
  if (task.dagNodeType === 'gate') return '等待 / 汇聚'
  return '任务'
}

function summarizeOutputs(outputs?: Record<string, unknown>) {
  if (!outputs) return []
  return Object.entries(outputs).slice(0, 3)
}

function tagColorByStatus(status: string) {
  if (status === 'success') return 'green'
  if (FAILURE_TASK_STATUSES.includes(status)) return 'red'
  if (status === 'aborted') return 'orange'
  if (['running', 'queued_in_jenkins', 'submitting'].includes(status)) return 'blue'
  return 'default'
}

function reportedStageMeta(status?: string) {
  switch (String(status || '').toLowerCase()) {
    case 'success':
      return { label: '成功', color: 'green' as const }
    case 'failed':
    case 'error':
      return { label: '失败', color: 'red' as const }
    case 'aborted':
      return { label: '已中止', color: 'orange' as const }
    case 'running':
    case 'in_progress':
      return { label: '运行中', color: 'blue' as const }
    default:
      return { label: '等待中', color: 'default' as const }
  }
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function isFailureLike(status?: string) {
  const value = String(status || '').toLowerCase()
  return value === 'failed' || value === 'error' || value === 'aborted'
}

function matchReportedStage(task: TaskRun, stages: ReportedStage[]) {
  if (!stages.length) return undefined
  const names = [
    task.nodeName,
    task.testSetName,
    task.dagNodeId,
  ].map(normalizeText).filter(Boolean)

  if (!names.length) return undefined

  return stages.find((stage) => {
    const candidates = [
      stage.nodeName,
      stage.stageName,
      stage.stageKey,
    ].map(normalizeText)
    return names.some((name) => candidates.includes(name))
  })
}

function deriveDisplayRunStatus(runStatus: string, tasks: TaskRun[]) {
  if (!tasks.length) return runStatus
  if (tasks.some((task) => task.status === 'running')) return 'running'
  if (tasks.some((task) => ['submitting', 'queued_in_jenkins'].includes(task.status))) return 'queued_in_jenkins'
  if (tasks.some((task) => ['pending', 'waiting'].includes(task.status))) return 'waiting'
  if (tasks.some((task) => FAILURE_TASK_STATUSES.includes(task.status))) return 'failed'
  if (tasks.some((task) => task.status === 'aborted')) return 'aborted'
  if (tasks.every((task) => task.status === 'success')) return 'success'
  return runStatus
}

function waitingReasonOf(task?: TaskRun) {
  if (!task || !WAITING_TASK_STATUSES.includes(task.status)) return ''
  const reason = String(task.phase ?? '').trim()
  if (!reason || reason === 'completed') return ''
  return reason
}

function taskStatusLabel(status?: string) {
  return TASK_STATUS_META[String(status || '')]?.label ?? status ?? '-'
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [rebuilding, setRebuilding] = useState(false)

  const { data: run, isLoading, mutate } = useSWR(
    id ? `run-${id}` : null,
    () => runApi.get(id!),
    { refreshInterval: (data) => ACTIVE_RUN_STATUSES.includes(data?.status) ? 3000 : 0 },
  )

  const { data: taskPage, mutate: mutateTasks } = useSWR(
    id ? `run-tasks-${id}` : null,
    () => runApi.getTaskRuns(id!, { page: 1, pageSize: 200 }),
    { refreshInterval: ACTIVE_RUN_STATUSES.includes(run?.status ?? '') ? 3000 : 0 },
  )

  const { data: reportedData, mutate: mutateReported } = useSWR(
    id ? `reported-by-run-${id}` : null,
    () => client.get(`/report/by-run/${id}`).then((r) => r.data.data ?? r.data),
    { refreshInterval: ACTIVE_RUN_STATUSES.includes(run?.status ?? '') ? 5000 : 0 },
  )

  const tasks = taskPage?.items ?? []
  const reportedRun = reportedData?.found ? reportedData.run : null
  const reportedStages = (Array.isArray(reportedData?.stages) ? reportedData.stages : []) as ReportedStage[]
  const jenkinsTasks = useMemo(() => tasks.filter((task) => task.dagNodeType === 'jenkins'), [tasks])
  const taskReportedStageMap = useMemo(() => {
    const pairs = tasks.map((task) => {
      const stage = matchReportedStage(task, reportedStages)
      if (stage) return [task.id, stage] as const
      return null
    }).filter(Boolean) as Array<readonly [string, ReportedStage]>

    if (pairs.length === 0 && reportedRun && jenkinsTasks.length === 1) {
      const fallbackStage = reportedStages[0]
      if (fallbackStage) {
        return new Map<string, ReportedStage>([[jenkinsTasks[0].id, fallbackStage]])
      }
    }

    return new Map<string, ReportedStage>(pairs)
  }, [jenkinsTasks, reportedRun, reportedStages, tasks])
  const reportedFailureStage = useMemo(
    () => reportedStages.find((stage) => isFailureLike(stage.status)),
    [reportedStages],
  )
  const hasReportedFailure = !!reportedRun && (isFailureLike(reportedRun.status) || !!reportedFailureStage)

  const activeTask = useMemo(
    () => tasks.find((task) => ACTIVE_RUN_STATUSES.includes(task.status)) ?? tasks[0],
    [tasks],
  )

  useEffect(() => {
    const fallbackTaskId = activeTask?.id
    if (!fallbackTaskId) {
      setSelectedTaskId(undefined)
      return
    }
    setSelectedTaskId((current) => (
      current && tasks.some((task) => task.id === current) ? current : fallbackTaskId
    ))
  }, [activeTask, tasks])

  if (isLoading || !run) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <Spin />
      </div>
    )
  }

  const isRunning = ACTIVE_RUN_STATUSES.includes(run.status)
  const jenkinsBuildUrl = run.jenkinsBuildUrl || reportedRun?.buildUrl
  const jenkinsBuildId = run.jenkinsBuildId || reportedRun?.buildId
  const durationMs = run.durationMs || reportedRun?.durationMs
  const triggerUser = displayUserName(run.triggeredByName, run.triggeredBy, '未知触发人')
  const focusedTask = tasks.find((task) => task.id === selectedTaskId) ?? activeTask
  const focusedWaitingReason = waitingReasonOf(focusedTask)
  const displayRunStatus = deriveDisplayRunStatus(run.status, tasks)
  const focusedReportedStage = focusedTask ? taskReportedStageMap.get(focusedTask.id) : undefined
  const callbackMismatch = hasReportedFailure && !['failed', 'error', 'aborted'].includes(displayRunStatus)

  const queueingTasks = tasks.filter((task) => ['submitting', 'queued_in_jenkins'].includes(task.status)).length
  const waitingTasks = tasks.filter((task) => ['pending', 'waiting'].includes(task.status)).length
  const failedTasks = tasks.filter((task) => FAILURE_TASK_STATUSES.includes(task.status)).length
  const successTasks = tasks.filter((task) => task.status === 'success').length
  const failureInsight = (() => {
    const failedTask = tasks.find((task) => FAILURE_TASK_STATUSES.includes(task.status) || task.status === 'aborted')
    const matchedStage = failedTask ? taskReportedStageMap.get(failedTask.id) : reportedFailureStage
    const summary = failedTask?.errorSummary || matchedStage?.errorSummary || reportedRun?.errorSummary || run.errorSummary || run.abortReason || ''

    if (run.status === 'aborted' || failedTask?.status === 'aborted') {
      return {
        title: '运行已中止',
        type: '人工或系统中止',
        target: failedTask ? taskTitle(failedTask) : run.pipelineName,
        summary: summary || '本次运行被中止，后续未开始组件不会继续调度。',
        suggestions: ['确认中止原因和操作者', '如配置无误，可使用历史快照重跑', '检查是否存在超时或外部取消策略'],
      }
    }

    if (callbackMismatch) {
      return {
        title: 'Jenkins 回执与平台状态不一致',
        type: '状态同步异常',
        target: matchedStage?.stageName || matchedStage?.stageKey || reportedRun?.buildId || run.pipelineName,
        summary: summary || 'Jenkins 已上报失败，但平台组件状态尚未完全同步。',
        suggestions: ['刷新详情页确认最新回执', '打开 Jenkins 构建查看失败阶段', '若持续不一致，请检查回调地址和凭证'],
      }
    }

    if (failedTask?.status === 'submit_failed' || failedTask?.status === 'queued_in_jenkins') {
      return {
        title: 'Jenkins 提交或排队异常',
        type: taskStatusLabel(failedTask.status),
        target: taskTitle(failedTask),
        summary: summary || '组件未能稳定进入 Jenkins 构建队列。',
        suggestions: ['检查 Jenkins 实例连通性和凭证', '确认 Job 名称与参数格式', '查看 Jenkins 队列是否拥塞'],
      }
    }

    if (failedTask?.status === 'blocked') {
      return {
        title: '上游失败导致阻断',
        type: '依赖阻断',
        target: taskTitle(failedTask),
        summary: summary || '当前组件因上游失败策略被阻断。',
        suggestions: ['先处理最早失败的上游组件', '确认 Join 策略和失败策略是否符合预期', '必要时调整画布依赖后重新触发'],
      }
    }

    if (failedTask) {
      return {
        title: '组件执行失败',
        type: taskTypeLabel(failedTask),
        target: taskTitle(failedTask),
        summary: summary || '组件执行阶段返回失败，请结合 Jenkins 日志定位。',
        suggestions: ['打开 Jenkins 构建日志定位错误行', '核对本次运行参数和输入映射', '查看最近同名组件是否有相似失败'],
      }
    }

    if (hasReportedFailure) {
      return {
        title: 'Jenkins 上报失败',
        type: '外部回执失败',
        target: reportedFailureStage?.stageName || reportedFailureStage?.stageKey || run.pipelineName,
        summary: summary || '当前没有平台组件明细，但 Jenkins 回执中存在失败阶段。',
        suggestions: ['打开 Jenkins 构建查看阶段日志', '检查回执 stage 与画布组件名称是否一致', '刷新后等待平台明细同步'],
      }
    }

    if (run.status === 'failed' || run.status === 'error') {
      return {
        title: '运行失败',
        type: taskStatusLabel(run.status),
        target: run.pipelineName,
        summary: summary || '平台记录本次运行失败，但暂未拿到组件级失败信息。',
        suggestions: ['刷新运行详情', '检查服务端调度日志', '确认 Jenkins 回调是否正常'],
      }
    }

    return null
  })()

  const refreshAll = () => {
    void mutate()
    void mutateTasks()
    void mutateReported()
  }

  const handleAbort = () => {
    showConfirm({
      title: '确认中止流水线？',
      content: '中止后会停止当前执行链路，未开始的组件不会继续调度。',
      okText: '确认中止',
      onOk: async () => {
        await runApi.abort(id!)
        message.success('已发送中止请求')
        refreshAll()
      },
    })
  }

  const handleRebuild = () => {
    if (isRunning) {
      message.info('运行中不可重跑，请等待本次运行结束后再操作')
      return
    }
    showConfirm({
      title: `使用当时快照重跑「${run.pipelineName}」？`,
      content: '系统会使用这条运行当时保存的流水线配置快照和运行参数创建新运行，不读取流水线当前最新配置。',
      okText: '重跑',
      onOk: async () => {
        setRebuilding(true)
        try {
          const res = await runApi.rebuild(id!)
          message.success('已按历史快照创建重跑')
          navigate(`/runs/${res.runId}`)
        } finally {
          setRebuilding(false)
        }
      },
    })
  }

  return (
    <div className="atop-page-shell atop-run-detail-shell">
      <section className="atop-detail-hero atop-run-detail-hero">
        <div>
          <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/run-history')}>
            返回运行记录
          </Button>
          <div className="atop-detail-title" style={{ marginTop: 10 }}>
            {run.pipelineName}
            <span style={{ color: '#9C9A92', marginLeft: 8, fontSize: 13, fontWeight: 700 }}>
              #{run.id?.slice(0, 8)}
            </span>
          </div>
          <div className="atop-detail-subtitle">
            <UserOutlined /> {triggerUser}
            {run.startedAt && (
              <>
                {' '}
                · <ClockCircleOutlined /> {fmtDatetime(run.startedAt)}
              </>
            )}
          </div>
        </div>
        <div className="atop-detail-actions">
          <Button
            size="small"
            icon={<RedoOutlined />}
            loading={rebuilding}
            disabled={isRunning}
            title={isRunning ? '运行中不可重跑，请等待结束后再操作' : undefined}
            onClick={handleRebuild}
          >
            重跑
          </Button>
          {jenkinsBuildUrl && (
            <Button size="small" icon={<LinkOutlined />} href={jenkinsBuildUrl} target="_blank">
              Jenkins {jenkinsBuildId ? `#${jenkinsBuildId}` : '构建'}
            </Button>
          )}
          {isRunning && (
            <Button size="small" danger icon={<StopOutlined />} onClick={handleAbort}>
              中止
            </Button>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={refreshAll}>
            刷新
          </Button>
        </div>
      </section>

      {(run.status === 'failed' || run.status === 'error') && run.errorSummary && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="本次运行失败"
          description={run.errorSummary}
        />
      )}

      {run.status === 'aborted' && run.abortReason && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="本次运行已中止"
          description={run.abortReason}
        />
      )}

      {callbackMismatch && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="Jenkins 回执提示存在失败信息"
          description={reportedFailureStage?.errorSummary || reportedRun?.errorSummary || 'Jenkins 已上报失败，但平台主状态还没有完全反映到组件列表里。'}
        />
      )}

      {failureInsight && (
        <Card className="atop-content-card atop-run-failure-panel" size="small">
          <div className="atop-run-failure-head">
            <span><WarningOutlined /></span>
            <div>
              <strong>失败归因摘要</strong>
              <small>{failureInsight.title}</small>
            </div>
            <Tag color="red">{failureInsight.type}</Tag>
          </div>
          <div className="atop-run-failure-body">
            <div>
              <span>定位对象</span>
              <strong>{failureInsight.target}</strong>
            </div>
            <div>
              <span>摘要</span>
              <strong>{failureInsight.summary}</strong>
            </div>
          </div>
          <div className="atop-run-failure-actions">
            {failureInsight.suggestions.map((item) => (
              <Tag key={item}>{item}</Tag>
            ))}
          </div>
        </Card>
      )}

      <div className="atop-run-detail-grid">
        <div className="atop-run-detail-main">
          <div className="atop-run-detail-metrics">
            <MetricCard
              label="运行状态"
              value={TASK_STATUS_META[displayRunStatus]?.label ?? displayRunStatus}
              color={TASK_STATUS_META[displayRunStatus]?.color}
              tone={TASK_STATUS_META[displayRunStatus]?.tone ?? 'default'}
            />
            <MetricCard label="总耗时" value={fmtDuration(durationMs)} />
            <MetricCard label="成功组件" value={successTasks} tone="success" />
            <MetricCard label="排队 / 提交中" value={queueingTasks} tone="info" />
            <MetricCard label="等待中" value={waitingTasks} />
            <MetricCard label="失败组件" value={failedTasks} tone={failedTasks > 0 ? 'danger' : 'default'} />
          </div>

          <div className="atop-status-strip">
            <PipelineStatusBadge status={displayRunStatus as any} />
            {run.remark && <Tag>{run.remark}</Tag>}
            {run.jenkinsQueueId ? <Tag color="blue">Queue #{run.jenkinsQueueId}</Tag> : null}
            {run.jenkinsBuildId ? <Tag color="green">Build #{run.jenkinsBuildId}</Tag> : null}
            {reportedRun ? <Tag color={hasReportedFailure ? 'red' : 'processing'}>{hasReportedFailure ? 'Jenkins 回执异常' : '已接收 Jenkins 回执'}</Tag> : null}
          </div>

          <Card
            className="atop-content-card atop-run-component-card"
            size="small"
            title={(
              <div className="atop-stage-title">
                <ClusterOutlined />
                <span>组件执行明细</span>
              </div>
            )}
          >
            {!tasks.length ? (
              reportedStages.length ? (
                <div className="atop-run-stage-feed">
                  {reportedStages.map((stage) => {
                    const meta = reportedStageMeta(stage.status)
                    return (
                      <div key={stage.id || stage.stageKey} className="atop-run-stage-item">
                        <div className="atop-run-stage-copy">
                          <strong>{stage.stageName || stage.stageKey || 'Jenkins 阶段'}</strong>
                          <span>
                            {stage.nodeName || 'Jenkins 回执'}
                            {stage.durationMs ? ` · ${fmtDuration(stage.durationMs)}` : ''}
                          </span>
                        </div>
                        <Tag color={meta.color}>{meta.label}</Tag>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前还没有拿到组件执行记录" />
              )
            ) : (
              <div className="atop-run-component-list">
                {tasks.map((task) => {
                  const meta = TASK_STATUS_META[task.status] ?? TASK_STATUS_META.pending
                  const outputs = summarizeOutputs(task.outputs)
                  const waitingReason = waitingReasonOf(task)
                  const reportedStage = taskReportedStageMap.get(task.id)
                  const reportedMeta = reportedStage ? reportedStageMeta(reportedStage.status) : null
                  return (
                    <div
                      key={task.id}
                      className={`atop-run-component-item${focusedTask?.id === task.id ? ' is-active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={focusedTask?.id === task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedTaskId(task.id)
                        }
                      }}
                    >
                      <div className="atop-run-component-head">
                        <div>
                          <strong>{taskTitle(task)}</strong>
                          <span>{taskTypeLabel(task)} · {task.dagDetached ? '异步分支' : '主链路'}</span>
                        </div>
                        <div className="atop-run-component-tags">
                          <Tag color={tagColorByStatus(task.status)}>{meta.label}</Tag>
                          {reportedMeta ? <Tag color={reportedMeta.color}>{isFailureLike(reportedStage?.status) ? '回执失败' : '已回执'}</Tag> : null}
                        </div>
                      </div>
                      <div className="atop-run-component-facts">
                        <span>Queue：{task.jenkinsQueueId || '-'}</span>
                        <span>Build：{task.jenkinsBuildId || '-'}</span>
                        <span>耗时：{fmtDuration(task.durationMs)}</span>
                        <span>阶段：{task.phase || '-'}</span>
                        <span>节点：{task.nodeName || '-'}</span>
                      </div>
                      {waitingReason && (
                        <div className="atop-queue-note">
                          <ClockCircleOutlined />
                          <span>{waitingReason}</span>
                        </div>
                      )}
                      {reportedStage && (
                        <div className={`atop-run-receipt-note${isFailureLike(reportedStage.status) ? ' is-danger' : ''}`}>
                          <CheckCircleOutlined />
                          <span>
                            Jenkins 回执：{reportedStage.stageName || reportedStage.stageKey || reportedStage.nodeName || '阶段回执'}
                            {reportedStage.errorSummary ? ` · ${reportedStage.errorSummary}` : ''}
                          </span>
                        </div>
                      )}
                      {!waitingReason && task.errorSummary && <div className="atop-error-note">{task.errorSummary}</div>}
                      {!!outputs.length && (
                        <div className="atop-run-output-strip">
                          {outputs.map(([key, value]) => (
                            <Tag key={key}>
                              {key}: {String(value)}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                <EndOfListHint visible={tasks.length > 0} />
              </div>
            )}
          </Card>

          {reportedStages.length > 0 && (
            <Card
              className="atop-content-card atop-run-component-card"
              size="small"
              title={(
                <div className="atop-stage-title">
                  <CheckCircleOutlined />
                  <span>Jenkins 回执阶段</span>
                </div>
              )}
            >
              <div className="atop-run-stage-feed">
                {reportedStages.map((stage) => {
                  const meta = reportedStageMeta(stage.status)
                  return (
                    <div key={`reported-${stage.id || stage.stageKey}`} className="atop-run-stage-item">
                      <div className="atop-run-stage-copy">
                        <strong>{stage.stageName || stage.stageKey || 'Jenkins 阶段'}</strong>
                        <span>
                          {stage.nodeName || 'Jenkins 回执'}
                          {stage.durationMs ? ` · ${fmtDuration(stage.durationMs)}` : ''}
                          {stage.errorSummary ? ` · ${stage.errorSummary}` : ''}
                        </span>
                      </div>
                      <Tag color={meta.color}>{meta.label}</Tag>
                    </div>
                  )
                })}
              </div>
            </Card>
          )}
        </div>

        <aside className="atop-run-detail-side">
          <Card
            className="atop-content-card atop-run-focus-card"
            size="small"
            title={(
              <div className="atop-stage-title">
                <BranchesOutlined />
                <span>当前焦点</span>
              </div>
            )}
          >
            {focusedTask ? (
              <div className="atop-run-focus-body">
                <div className="atop-run-focus-title">
                  <strong>{taskTitle(focusedTask)}</strong>
                  <Tag color={tagColorByStatus(focusedTask.status)}>
                    {TASK_STATUS_META[focusedTask.status]?.label ?? focusedTask.status}
                  </Tag>
                </div>
                <div className="atop-run-focus-grid">
                  <div><span>组件类型</span><strong>{taskTypeLabel(focusedTask)}</strong></div>
                  <div><span>Queue ID</span><strong>{focusedTask.jenkinsQueueId || '-'}</strong></div>
                  <div><span>Build ID</span><strong>{focusedTask.jenkinsBuildId || '-'}</strong></div>
                  <div><span>开始时间</span><strong>{focusedTask.startedAt ? fmtDatetime(focusedTask.startedAt) : '-'}</strong></div>
                </div>
                {focusedTask.jenkinsBuildUrl && (
                  <Button block icon={<LinkOutlined />} href={focusedTask.jenkinsBuildUrl} target="_blank">
                    打开 Jenkins 控制台
                  </Button>
                )}
                {focusedWaitingReason && (
                  <Alert type="info" showIcon message={focusedWaitingReason} />
                )}
                {focusedReportedStage && (
                  <Alert
                    type={isFailureLike(focusedReportedStage.status) ? 'error' : 'success'}
                    showIcon
                    message={
                      focusedReportedStage.errorSummary
                        ? `Jenkins 回执：${focusedReportedStage.errorSummary}`
                        : `Jenkins 回执：${focusedReportedStage.stageName || focusedReportedStage.stageKey || '已接收'}`
                    }
                  />
                )}
                {!focusedWaitingReason && focusedTask.errorSummary && (
                  <Alert type="warning" showIcon message={focusedTask.errorSummary} />
                )}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无组件状态" />
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}
