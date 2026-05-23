import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useNavigate } from 'react-router-dom'
import { Card, Button, Space, Skeleton, Table, Empty, Tag, Modal, Input, Popover, message } from 'antd'
import {
  PlusOutlined, ReloadOutlined, ExpandOutlined, FullscreenExitOutlined, HistoryOutlined,
  LineChartOutlined, WarningOutlined, ClockCircleOutlined,
  CheckCircleOutlined, ThunderboltOutlined, CloseCircleOutlined,
  ApiOutlined, DeploymentUnitOutlined, EyeOutlined, QuestionCircleOutlined,
  TrophyOutlined, DesktopOutlined, ToolOutlined,
} from '@ant-design/icons'
import {
  Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer,
  Legend, Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts'
import client from '@/api/client'
import { runApi } from '@/api/pipelines'
import { jenkinsApi } from '@/api/settings'
import { useAuthStore } from '@/store/auth'
import PageHeader from '@/components/common/PageHeader'
import MetricCard from '@/components/common/MetricCard'
import SectionTitle from '@/components/common/SectionTitle'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { fmtDuration, rateColor } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'
import type { AgentNode, PipelineRun } from '@/types'

type RunSource = 'platform' | 'jenkins_report'

type DashboardRun = PipelineRun & {
  _source: RunSource
  pipelineKey?: string
  buildId?: string
  createdAt?: string
}

type DashboardSummary = {
  totalRuns?: number
  avgPassRate?: number
  avgDuration?: number
  totalFailed?: number
  totalAborted?: number
  exceptionRate?: number
  activePipelineCount?: number
  unstablePipelineCount?: number
  avgRunsPerDay?: number
  topFailing?: Array<{
    pipelineId: string
    pipelineName: string
    runCount: number
    failedRuns: number
    abortedRuns: number
    exceptionRuns?: number
    failureRate: number
    exceptionRate?: number
    avgPassRate: number
  }>
}

type TrendPoint = {
  date: string
  passRate?: number
  durationMs?: number
  runCount?: number
  failedCount?: number
  abortedCount?: number
}

type PipelineQualityStat = {
  pipelineId: string
  pipelineName: string
  runCount: number
  avgPassRate: number
  failedRuns?: number
  abortedRuns?: number
  exceptionRuns?: number
  failureRate?: number
  exceptionRate?: number
}

type AttentionItem = {
  id: string
  rank: string
  title: string
  detail: string
  time?: string
  metric: string
  tone: 'danger' | 'warning' | 'info'
  open: () => void
}

type AttentionWorkflowStatus = 'open' | 'claimed' | 'handled' | 'ignored'

type AttentionWorkflowRecord = {
  status: AttentionWorkflowStatus
  owner?: string
  note?: string
  updatedAt: string
}

const RUNNING_FETCH_LIMIT = 100
const ATTENTION_DISMISSED_KEY = 'atop.dashboard.dismissedAttention.v1'
const ATTENTION_WORKFLOW_KEY = 'atop.dashboard.attentionWorkflow.v1'
const runningStatuses = new Set(['running', 'pending', 'submitting', 'queued_in_jenkins', 'waiting'])
const queuedStatuses = new Set(['pending', 'submitting', 'queued_in_jenkins', 'waiting'])

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function getRunTime(row: Partial<DashboardRun>) {
  return row.startedAt ?? row.createdAt ?? ''
}

function getElapsedMs(row: Partial<DashboardRun>) {
  const raw = getRunTime(row)
  if (!raw) return 0
  const startedAt = new Date(raw).getTime()
  if (Number.isNaN(startedAt)) return 0
  return Math.max(0, Date.now() - startedAt)
}

function isToday(value?: string | null) {
  if (!value) return false
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

function chartValue(dataKey: string, value: unknown) {
  if (typeof value !== 'number') return value
  if (dataKey === 'passRate') return `${value}%`
  if (dataKey === 'durationMs') return fmtDuration(value)
  return value
}

function failureColor(rate?: number | null) {
  if (rate == null) return '#9C9A92'
  if (rate >= 50) return '#A32D2D'
  if (rate >= 20) return '#854F0B'
  return '#0F6E56'
}

function loadDismissedAttention() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(ATTENTION_DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function saveDismissedAttention(ids: string[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ATTENTION_DISMISSED_KEY, JSON.stringify(ids.slice(-200)))
}

function loadAttentionWorkflow(): Record<string, AttentionWorkflowRecord> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ATTENTION_WORKFLOW_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveAttentionWorkflow(data: Record<string, AttentionWorkflowRecord>) {
  if (typeof window === 'undefined') return
  const entries = Object.entries(data).slice(-300)
  window.localStorage.setItem(ATTENTION_WORKFLOW_KEY, JSON.stringify(Object.fromEntries(entries)))
}

function DashboardChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="atop-dashboard-chart-tooltip">
      <div className="atop-dashboard-chart-tooltip-title">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}：{chartValue(p.dataKey, p.value)}
        </div>
      ))}
    </div>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const currentUser = useAuthStore((s) => s.user)
  const dashboardRef = useRef<HTMLDivElement | null>(null)
  const [isDashboardFullscreen, setIsDashboardFullscreen] = useState(false)
  const [dismissedAttentionIds, setDismissedAttentionIds] = useState<string[]>(loadDismissedAttention)
  const [attentionWorkflow, setAttentionWorkflow] = useState<Record<string, AttentionWorkflowRecord>>(loadAttentionWorkflow)
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [attentionKeyword, setAttentionKeyword] = useState('')
  const [attentionPage, setAttentionPage] = useState(1)
  const [attentionPageSize, setAttentionPageSize] = useState(10)
  const [attentionNoteOpen, setAttentionNoteOpen] = useState(false)
  const [attentionNoteItem, setAttentionNoteItem] = useState<AttentionItem | null>(null)
  const [attentionNoteDraft, setAttentionNoteDraft] = useState('')

  const { data: stats, mutate: mutStats } = useSWR(
    'dashboard-stats',
    () => client.get('/pipeline-runs/dashboard-stats').then(r => r.data.data ?? r.data),
    { refreshInterval: 15_000 },
  )

  const { data: summaryData, mutate: mutSummary } = useSWR<DashboardSummary>(
    ['dashboard-summary', 30],
    () => client.get('/stats/summary', { params: { days: 30 } }).then(r => r.data.data ?? r.data),
    { refreshInterval: 60_000 },
  )

  const { data: trendData, isLoading: trendLoading, mutate: mutTrend } = useSWR<{ points?: TrendPoint[] }>(
    ['dashboard-trends', 30],
    () => client.get('/stats/trends', { params: { days: 30, groupBy: 'day' } }).then(r => r.data.data ?? r.data),
    { refreshInterval: 60_000 },
  )

  const { data: pipelineStatsData, isLoading: pipelineStatsLoading, mutate: mutPipelineStats } = useSWR<{ items?: PipelineQualityStat[] }>(
    ['dashboard-pipeline-quality', 30],
    () => client.get('/stats/pipelines', { params: { days: 30, page: 1, pageSize: 50 } }).then(r => r.data.data ?? r.data),
    { refreshInterval: 60_000 },
  )

  const { data: runs, isLoading, mutate: mutRuns } = useSWR(
    ['pipeline-runs-dashboard'],
    () => runApi.list({ page: 1, pageSize: 10 }),
    { refreshInterval: 15_000 },
  )

  const { data: runningData, isLoading: runningLoading, mutate: mutRunning } = useSWR(
    ['pipeline-runs-running', RUNNING_FETCH_LIMIT],
    () => runApi.list({
      status: 'running,pending,submitting,queued_in_jenkins,waiting',
      page: 1,
      pageSize: RUNNING_FETCH_LIMIT,
    }),
    { refreshInterval: 10_000 },
  )

  const { data: longRunningData, mutate: mutLongRunning } = useSWR(
    ['pipeline-runs-long-running', RUNNING_FETCH_LIMIT],
    () => runApi.list({
      status: 'running,pending,submitting,queued_in_jenkins,waiting',
      startedBeforeMinutes: 30,
      page: 1,
      pageSize: RUNNING_FETCH_LIMIT,
    }),
    { refreshInterval: 10_000 },
  )

  const { data: reportedRuns, isLoading: reportedLoading, mutate: mutReported } = useSWR(
    ['dashboard-reported-runs'],
    () => client.get('/report/runs', { params: { page: 1, pageSize: 8 } }).then(r => r.data.data ?? r.data),
    { refreshInterval: 15_000 },
  )

  const { data: agentNodes, isLoading: agentNodesLoading, mutate: mutAgentNodes } = useSWR<AgentNode[]>(
    ['dashboard-agent-nodes'],
    () => jenkinsApi.listAgentNodes(),
    { refreshInterval: 60_000 },
  )

  const platformItems = useMemo<DashboardRun[]>(
    () => (runs?.items ?? []).map((r) => ({ ...r, _source: 'platform' })),
    [runs?.items],
  )
  const runningRuns = useMemo<DashboardRun[]>(
    () => (runningData?.items ?? []).map((r) => ({ ...r, _source: 'platform' })),
    [runningData?.items],
  )
  const longRunningRuns = useMemo<DashboardRun[]>(
    () => (longRunningData?.items ?? []).map((r) => ({ ...r, _source: 'platform' })),
    [longRunningData?.items],
  )
  const reportedItems = useMemo<DashboardRun[]>(
    () => ((reportedRuns as any)?.items ?? []).map((r: any) => ({ ...r, _source: 'jenkins_report' })),
    [reportedRuns],
  )
  const allRuns = useMemo(
    () => [...platformItems, ...reportedItems].sort((a, b) => {
      const ta = new Date(getRunTime(a) || 0).getTime()
      const tb = new Date(getRunTime(b) || 0).getTime()
      return tb - ta
    }),
    [platformItems, reportedItems],
  )

  const runningTotal = runningData?.total ?? runningRuns.length
  const runningLoadedCount = runningRuns.length
  const queuedWaitingCount = runningRuns.filter((r) => queuedStatuses.has(String(r.status))).length
  const activeRunningCount = runningRuns.filter((r) => r.status === 'running').length
  const longestRunning = runningRuns.reduce((longest, run) => {
    if (!longest) return run
    return getElapsedMs(run) > getElapsedMs(longest) ? run : longest
  }, undefined as DashboardRun | undefined)

  const completedRuns = allRuns.filter((r) => !runningStatuses.has(String(r.status)))
  const recentFailedOrAborted = allRuns.filter((r) => r.status === 'failed' || r.status === 'aborted' || r.status === 'error')
  const history = completedRuns.slice(0, 10)
  const summary = summaryData ?? {}
  const hasSummary = toNumber(summary.totalRuns) > 0
  const points = trendData?.points ?? []
  const topFailing = Array.isArray(summary.topFailing) ? summary.topFailing : []
  const pipelineStats = useMemo(
    () => (pipelineStatsData?.items ?? [])
      .slice()
      .sort((a, b) => toNumber(b.runCount) - toNumber(a.runCount) || toNumber(b.avgPassRate) - toNumber(a.avgPassRate))
      .slice(0, 6),
    [pipelineStatsData?.items],
  )

  const recentSuccessRate = completedRuns.length
    ? (completedRuns.filter((r) => r.status === 'success').length / completedRuns.length) * 100
    : 0
  const durationValues = completedRuns
    .map((r) => toNumber((r as any).durationMs))
    .filter((v) => v > 0)

  const todayRuns = toNumber(stats?.todayRuns, allRuns.filter((r) => isToday(getRunTime(r))).length)
  const successRate = hasSummary
    ? toNumber(summary.avgPassRate)
    : toNumber(stats?.successRate, recentSuccessRate)
  const runningCount = Math.max(toNumber(stats?.runningCount, runningTotal), runningTotal)
  const failedRunCount = stats
    ? toNumber(stats.failedCount) + toNumber(stats.abortedCount)
    : recentFailedOrAborted.length
  const totalRuns30 = hasSummary ? toNumber(summary.totalRuns) : toNumber(stats?.totalRuns, runs?.total ?? allRuns.length)
  const avgDuration = hasSummary
    ? toNumber(summary.avgDuration, toNumber(stats?.avgDuration))
    : (durationValues.length ? durationValues.reduce((sum, n) => sum + n, 0) / durationValues.length : 0)
  const totalFailedRuns = hasSummary ? toNumber(summary.totalFailed) : toNumber(stats?.failedCount)
  const totalAbortedRuns = hasSummary ? toNumber(summary.totalAborted) : toNumber(stats?.abortedCount)
  const avgRunsPerDay = toNumber(summary.avgRunsPerDay)
  const activePipelineCount = hasSummary
    ? toNumber(summary.activePipelineCount)
    : new Set(completedRuns.map((r) => r.pipelineName).filter(Boolean)).size
  const unstablePipelineCount = hasSummary
    ? toNumber(summary.unstablePipelineCount)
    : new Set(recentFailedOrAborted.map((r) => r.pipelineName).filter(Boolean)).size
  const visibleAgentNodes = agentNodes ?? []
  const onlineAgentCount = visibleAgentNodes.filter((node) => node.online).length
  const totalAgentCount = visibleAgentNodes.length
  const offlineAgentCount = Math.max(0, totalAgentCount - onlineAgentCount)
  const agentOnlineRate = totalAgentCount > 0 ? (onlineAgentCount / totalAgentCount) * 100 : 0
  const exceptionRate = hasSummary
    ? toNumber(summary.exceptionRate)
    : totalRuns30 > 0
    ? ((totalFailedRuns + totalAbortedRuns) / totalRuns30) * 100
    : 0
  const hasSuccessData = hasSummary || stats?.successRate != null || completedRuns.length > 0
  const successRateText = hasSuccessData ? `${successRate.toFixed(1)}%` : '暂无'
  const lastRun = allRuns[0]
  const visibleAvgDurationText = avgDuration > 0 ? fmtDuration(avgDuration) : '暂无耗时'
  const visibleLastRunText = lastRun
    ? <RelativeTimeText value={getRunTime(lastRun)} emptyText="暂无运行" />
    : '暂无运行'

  const successTone = !hasSuccessData ? 'default' : successRate >= 80 ? 'success' : successRate >= 60 ? 'warning' : 'danger'

  const mutate = () => {
    mutStats()
    mutSummary()
    mutTrend()
    mutRuns()
    mutRunning()
    mutLongRunning()
    mutReported()
    mutPipelineStats()
    mutAgentNodes()
  }

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsDashboardFullscreen(document.fullscreenElement === dashboardRef.current)
    }
    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  const toggleDashboardFullscreen = async () => {
    try {
      if (document.fullscreenElement === dashboardRef.current) {
        await document.exitFullscreen()
        return
      }
      await dashboardRef.current?.requestFullscreen()
    } catch {
      message.error('当前浏览器不支持进入全屏，或全屏请求被拦截')
    }
  }

  const openRunDetail = (row: DashboardRun) => {
    navigate(row._source === 'jenkins_report' ? `/reported-runs/${row.id}` : `/runs/${row.id}`)
  }

  const markAttentionSeen = (id: string) => {
    setDismissedAttentionIds((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      saveDismissedAttention(next)
      return next
    })
  }

  const updateAttentionWorkflow = (item: AttentionItem, status: AttentionWorkflowStatus, note?: string) => {
    setAttentionWorkflow((prev) => {
      const next = {
        ...prev,
        [item.id]: {
          status,
          owner: status === 'claimed' ? (currentUser?.username || currentUser?.email || 'me') : prev[item.id]?.owner,
          note: note ?? prev[item.id]?.note,
          updatedAt: new Date().toISOString(),
        },
      }
      saveAttentionWorkflow(next)
      return next
    })
    if (status === 'claimed') message.success('已认领该异常')
    if (status === 'handled') message.success('已标记为处理完成')
    if (status === 'ignored') message.success('已忽略该异常')
  }

  const openAttentionNote = (item: AttentionItem) => {
    setAttentionNoteItem(item)
    setAttentionNoteDraft(attentionWorkflow[item.id]?.note ?? '')
    setAttentionNoteOpen(true)
  }

  const renderAttentionActions = (item: AttentionItem) => {
    const record = attentionWorkflow[item.id]
    const claimed = record?.status === 'claimed'
    return (
      <Space size={4} wrap onClick={(event) => event.stopPropagation()}>
        <Button size="small" onClick={() => updateAttentionWorkflow(item, claimed ? 'open' : 'claimed')}>
          {claimed ? '取消认领' : '认领'}
        </Button>
        <Button size="small" type="primary" onClick={() => updateAttentionWorkflow(item, 'handled')}>已处理</Button>
        <Button size="small" onClick={() => openAttentionNote(item)}>备注</Button>
        <Button size="small" danger onClick={() => updateAttentionWorkflow(item, 'ignored')}>忽略</Button>
        <Button size="small" onClick={() => handleAttentionClick(item)}>打开</Button>
      </Space>
    )
  }

  const attentionItems = useMemo<AttentionItem[]>(() => {
    const dismissed = new Set(dismissedAttentionIds)
    const items: AttentionItem[] = []

    longRunningRuns
      .filter((run) => runningStatuses.has(String(run.status)) && getElapsedMs(run) >= 30 * 60 * 1000)
      .forEach((run) => {
        items.push({
          id: `long-running-${run.id}`,
          rank: '久',
          title: run.pipelineName || '未命名运行',
          detail: `已运行 ${fmtDuration(getElapsedMs(run))}，建议确认 Jenkins 是否卡住`,
          time: getRunTime(run),
          metric: '进行中',
          tone: 'warning',
          open: () => openRunDetail(run),
        })
      })

    recentFailedOrAborted.forEach((run) => {
        items.push({
          id: `abnormal-${run._source}-${run.id}-${run.status}`,
          rank: '!',
          title: run.pipelineName || run.pipelineKey || '未命名运行',
          detail: run._source === 'jenkins_report' ? 'Jenkins 上报' : '平台触发',
          time: getRunTime(run),
          metric: run.status === 'aborted' ? '已中止' : '失败',
          tone: 'danger',
          open: () => openRunDetail(run),
        })
    })

    topFailing.slice(0, 5).forEach((item, index) => {
      const exceptionRate = toNumber(item.exceptionRate, toNumber(item.failureRate, Math.max(0, 100 - toNumber(item.avgPassRate))))
      const exceptionRuns = toNumber(item.exceptionRuns, toNumber(item.failedRuns) + toNumber(item.abortedRuns))
      items.push({
        id: `top-failing-${item.pipelineId}-${exceptionRuns}-${item.runCount}`,
        rank: String(index + 1),
        title: item.pipelineName,
        detail: `近 30 天运行 ${item.runCount ?? 0} 次，异常 ${exceptionRuns} 次`,
        metric: `异常率 ${exceptionRate.toFixed(1)}%`,
        tone: exceptionRate >= 50 ? 'danger' : 'warning',
        open: () => navigate(`/run-history?name=${encodeURIComponent(item.pipelineName)}&source=platform`),
      })
    })

    if (hasSuccessData && successRate < 80) {
      items.push({
        id: `low-success-rate-${Math.floor(successRate)}`,
        rank: '率',
        title: '整体成功率低于建议阈值',
        detail: `近 30 天成功率 ${successRate.toFixed(1)}%，建议查看历史趋势`,
        metric: '低于 80%',
        tone: 'warning',
        open: () => navigate('/trends'),
      })
    }

    return items.filter((item) => {
      const status = attentionWorkflow[item.id]?.status
      return !dismissed.has(item.id) && status !== 'handled' && status !== 'ignored'
    })
  }, [attentionWorkflow, dismissedAttentionIds, hasSuccessData, longRunningRuns, navigate, recentFailedOrAborted, successRate, topFailing])

  const visibleAttentionItems = attentionItems.slice(0, 5)
  const filteredAttentionItems = useMemo(() => {
    const keyword = attentionKeyword.trim().toLowerCase()
    if (!keyword) return attentionItems
    return attentionItems.filter((item) => (
      item.title.toLowerCase().includes(keyword)
      || item.detail.toLowerCase().includes(keyword)
      || item.metric.toLowerCase().includes(keyword)
      || item.rank.toLowerCase().includes(keyword)
    ))
  }, [attentionItems, attentionKeyword])
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredAttentionItems.length / attentionPageSize))
    if (attentionPage > maxPage) {
      setAttentionPage(maxPage)
    }
  }, [attentionPage, attentionPageSize, filteredAttentionItems.length])
  const attentionCurrentPage = Math.min(
    attentionPage,
    Math.max(1, Math.ceil(filteredAttentionItems.length / attentionPageSize)),
  )
  const pagedAttentionItems = filteredAttentionItems.slice(
    (attentionCurrentPage - 1) * attentionPageSize,
    attentionCurrentPage * attentionPageSize,
  )

  const handleAttentionClick = (item: AttentionItem, closeModal = false) => {
    if (closeModal) setAttentionOpen(false)
    item.open()
  }

  const attentionPolicyContent = (
    <div className="atop-dashboard-attention-policy">
      <strong>需要关注统计策略</strong>
      <span>实时运行与最近异常每 10-15 秒刷新一次。</span>
      <span>近 30 天质量汇总每 60 秒刷新一次。</span>
      <span>超过 30 分钟仍在运行、最近失败/中止、近 30 天异常率靠前、整体成功率低于 80% 会进入列表。</span>
      <span>点击事项后只从当前浏览器的大盘关注列表隐藏，历史记录仍正常保留。</span>
    </div>
  )

  const attentionCols = [
    {
      title: '事项',
      key: 'item',
      render: (_: unknown, item: AttentionItem) => (
        <span className={`atop-dashboard-attention-modal-title atop-dashboard-attention-${item.tone}`}>
          <span className="atop-dashboard-attention-rank atop-dashboard-attention-modal-rank">
            {item.rank}
          </span>
          <span className="atop-dashboard-attention-copy">
            <strong>{item.title}</strong>
            <small>
              {item.detail}
              {item.time && (
                <>
                  {' · '}
                  <RelativeTimeText value={item.time} />
                </>
              )}
            </small>
          </span>
        </span>
      ),
    },
    {
      title: '指标',
      key: 'metric',
      width: 132,
      render: (_: unknown, item: AttentionItem) => (
        <span className="atop-dashboard-attention-rate" style={{ color: item.tone === 'danger' ? '#A32D2D' : '#854F0B' }}>
          {item.metric}
        </span>
      ),
    },
    {
      title: '处理',
      key: 'workflow',
      width: 360,
      render: (_: unknown, item: AttentionItem) => renderAttentionActions(item),
    },
  ]

  const runningCols = [
    {
      title: '流水线', key: 'name',
      render: (_: unknown, row: DashboardRun) => (
        <div className="atop-running-table-name">
          <a onClick={() => openRunDetail(row)}>{row.pipelineName || '未命名运行'}</a>
          <span>#{row.id?.slice(0, 8)}</span>
        </div>
      ),
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 96,
      render: (s: PipelineRun['status']) => <PipelineStatusBadge status={s} />,
    },
    {
      title: '进度', key: 'progress', width: 140,
      render: (_: unknown, row: DashboardRun) => {
        const done = toNumber(row.successCount) + toNumber(row.failedCount) + toNumber(row.blockedCount)
        const total = toNumber(row.totalCount)
        if (total <= 0) return <Tag color="blue">等待回传</Tag>
        const pct = Math.round((done / total) * 100)
        return (
          <span style={{ color: row.failedCount > 0 ? '#A32D2D' : '#5F5E5A', fontWeight: 700 }}>
            {done}/{total} · {pct}%
          </span>
        )
      },
    },
    {
      title: '触发人', key: 'triggeredBy', width: 112,
      render: (_: unknown, row: DashboardRun) => (
        <span style={{ fontSize: 12 }}>{displayUserName((row as any).triggeredByName, row.triggeredBy, '未知触发人')}</span>
      ),
    },
    {
      title: '已运行', key: 'elapsed', width: 110,
      render: (_: unknown, row: DashboardRun) => <span style={{ color: '#9C9A92' }}>{fmtDuration(getElapsedMs(row))}</span>,
    },
    {
      title: '操作', key: 'action', width: 88,
      render: (_: unknown, row: DashboardRun) => (
        <Button size="small" className="atop-run-detail-btn" icon={<EyeOutlined />} onClick={() => openRunDetail(row)}>
          详情
        </Button>
      ),
    },
  ]

  const histCols = [
    {
      title: '来源', key: 'source', width: 112,
      render: (_: unknown, row: DashboardRun) => row._source === 'jenkins_report'
        ? <Tag className="atop-run-source-tag" icon={<ApiOutlined />} color="blue">Jenkins 上报</Tag>
        : <Tag className="atop-run-source-tag" icon={<DeploymentUnitOutlined />} color="green">平台触发</Tag>,
    },
    {
      title: '名称', key: 'name',
      render: (_: unknown, row: DashboardRun) => {
        const name = row.pipelineName || row.pipelineKey || '未命名运行'
        const idText = row.buildId ? `#${row.buildId}` : row.id ? `#${row.id.slice(0, 8)}` : ''
        return (
          <a onClick={() => openRunDetail(row)} style={{ color: '#2563EB', fontWeight: 700, fontSize: 14 }}>
            {name} <span style={{ color: '#9C9A92', fontWeight: 500 }}>{idText}</span>
          </a>
        )
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: PipelineRun['status']) => <PipelineStatusBadge status={s} />,
    },
    {
      title: '触发人', key: 'triggeredBy', width: 112,
      render: (_: unknown, row: DashboardRun) => (
        <span style={{ fontSize: 12 }}>{displayUserName((row as any).triggeredByName, row.triggeredBy, '未知触发人')}</span>
      ),
    },
    {
      title: '耗时', dataIndex: 'durationMs', key: 'dur', width: 100,
      render: (ms: number) => <span style={{ color: '#9C9A92' }}>{fmtDuration(ms)}</span>,
    },
    {
      title: '触发时间', key: 'time', width: 140,
      render: (_: unknown, row: DashboardRun) => <RelativeTimeText value={getRunTime(row)} style={{ color: '#9C9A92' }} />,
    },
    {
      title: '操作', key: 'action', width: 86,
      render: (_: unknown, row: DashboardRun) => (
        <Button size="small" className="atop-run-detail-btn" onClick={() => openRunDetail(row)}>详情</Button>
      ),
    },
  ]

  const attentionCard = (
    <Card
      className="atop-panel-card atop-dashboard-attention-card"
      size="small"
      title={
        <SectionTitle
          icon={<WarningOutlined />}
          title="需要关注"
          note="按实时运行与近 30 天质量数据生成，点击事项后会从当前大盘隐藏"
          tone={attentionItems.length > 0 ? 'danger' : 'success'}
        />
      }
      extra={
        <Space size={8} wrap>
          <Popover content={attentionPolicyContent} trigger="click" placement="bottomRight">
            <Button size="small" type="text" icon={<QuestionCircleOutlined />}>
              说明
            </Button>
          </Popover>
          <Tag color={attentionItems.length > 0 ? 'red' : 'green'}>{attentionItems.length > 0 ? `${attentionItems.length} 项` : '状态健康'}</Tag>
          {attentionItems.length > 5 && (
            <Button
              size="small"
              icon={<ExpandOutlined />}
              onClick={() => {
                setAttentionOpen(true)
                setAttentionPage(1)
              }}
            >
              查看全部
            </Button>
          )}
        </Space>
      }
    >
      {attentionItems.length > 0 ? (
        <div className="atop-dashboard-attention-list">
          {visibleAttentionItems.map((item) => (
            <div
              key={item.id}
              className={`atop-dashboard-attention-item atop-dashboard-attention-${item.tone}`}
            >
              <button type="button" className="atop-dashboard-attention-main" onClick={() => handleAttentionClick(item)}>
                <span className="atop-dashboard-attention-rank">{item.rank}</span>
                <span className="atop-dashboard-attention-copy">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                  {attentionWorkflow[item.id]?.note && <small>备注：{attentionWorkflow[item.id]?.note}</small>}
                </span>
                <span className="atop-dashboard-attention-rate" style={{ color: item.tone === 'danger' ? '#A32D2D' : '#854F0B' }}>
                  {attentionWorkflow[item.id]?.status === 'claimed' ? '已认领' : item.metric}
                </span>
              </button>
              <div className="atop-dashboard-attention-actions">
                {renderAttentionActions(item)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需要关注的事项" style={{ padding: 32 }} />
      )}
    </Card>
  )

  return (
    <div ref={dashboardRef} className={`atop-dashboard-page${isDashboardFullscreen ? ' is-fullscreen' : ''}`}>
      <PageHeader
        eyebrow="RUN OBSERVABILITY"
        title="运行大盘"
        subtitle="把平台触发与 Jenkins 上报放在同一张运行视图里，优先暴露状态、失败、耗时和最近异常。"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={mutate}>刷新</Button>
            <Button
              icon={isDashboardFullscreen ? <FullscreenExitOutlined /> : <ExpandOutlined />}
              onClick={toggleDashboardFullscreen}
            >
              {isDashboardFullscreen ? '退出全屏' : '全屏大盘'}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/pipelines')}>触发运行</Button>
          </Space>
        }
      />

      <div className="atop-dashboard-priority-grid">
        {attentionCard}

        <div className="atop-dashboard-priority-summary">
          <div className="atop-metric-grid">
            <MetricCard
              label="今日运行次数"
              value={todayRuns}
              icon={<ClockCircleOutlined />}
              foot="平台触发与 Jenkins 上报聚合"
            />
            <MetricCard
              label="近 30 天成功率"
              value={successRateText}
              icon={<CheckCircleOutlined />}
              color={rateColor(hasSuccessData ? successRate : undefined)}
              tone={successTone}
              foot={!hasSuccessData ? '等待运行数据' : successRate >= 80 ? '运行质量稳定' : '低于建议阈值 80%'}
            />
            <MetricCard
              label="进行中"
              value={runningCount}
              icon={<ThunderboltOutlined />}
              color={runningCount > 0 ? '#185FA5' : undefined}
              tone={runningCount > 0 ? 'info' : 'default'}
              foot={runningCount > 0 ? `已加载最新 ${Math.min(runningLoadedCount, RUNNING_FETCH_LIMIT)} 条` : '队列空闲，可以触发'}
            />
            <MetricCard
              label="失败 / 中止"
              value={failedRunCount}
              icon={<CloseCircleOutlined />}
              color={failedRunCount > 0 ? '#A32D2D' : undefined}
              tone={failedRunCount > 0 ? 'danger' : 'default'}
              foot={failedRunCount > 0 ? '建议优先查看异常记录' : '暂无需要处理的异常'}
            />
          </div>

          <div className="atop-dashboard-data-strip">
            <div>
              <span>平均运行耗时</span>
              <strong>{visibleAvgDurationText}</strong>
              <small>识别构建链路瓶颈</small>
            </div>
            <div>
              <span>最近同步</span>
              <strong>{visibleLastRunText}</strong>
              <small>{lastRun ? '大盘自动刷新中' : '等待运行数据'}</small>
            </div>
            <div>
              <span>活跃流水线</span>
              <strong>{activePipelineCount}</strong>
              <small>{unstablePipelineCount > 0 ? `${unstablePipelineCount} 条需关注` : '近 30 天质量稳定'}</small>
            </div>
            <div>
              <span>Agent 节点</span>
              <strong>{totalAgentCount > 0 ? `${onlineAgentCount}/${totalAgentCount}` : '暂无'}</strong>
              <small>{totalAgentCount > 0 ? `在线率 ${agentOnlineRate.toFixed(0)}%` : '等待 Jenkins 节点同步'}</small>
            </div>
          </div>
        </div>
      </div>

      {(runningTotal > 0 || runningLoading) && (
        <Card
          className="atop-panel-card atop-table-card atop-dashboard-running-card"
          size="small"
          title={
            <SectionTitle
              icon={<ThunderboltOutlined />}
              title={`当前进行中 ${runningTotal || 0} 条`}
              note={`紧凑表格分页展示，适合几十到上百条同时运行；当前加载最新 ${runningLoadedCount} 条`}
              tone="info"
            />
          }
          extra={<Button size="small" onClick={() => navigate('/run-history?source=platform')}>查看运行记录</Button>}
          styles={{ body: { padding: 0 } }}
        >
          <div className="atop-dashboard-running-summary">
            <span>运行中 <strong>{activeRunningCount}</strong></span>
            <span>排队/等待 <strong>{queuedWaitingCount}</strong></span>
            <span>最长耗时 <strong>{longestRunning ? fmtDuration(getElapsedMs(longestRunning)) : '—'}</strong></span>
            {runningTotal > RUNNING_FETCH_LIMIT && <em>仅展示最新 {RUNNING_FETCH_LIMIT} 条，完整列表请进入运行记录</em>}
          </div>
          <Table
            dataSource={runningRuns}
            columns={runningCols}
            rowKey={(row) => row.id}
            size="middle"
            loading={runningLoading}
            pagination={runningRuns.length > 8 ? { pageSize: 8, size: 'small', showSizeChanger: false } : false}
            scroll={{ x: 860 }}
            locale={{ emptyText: '暂无进行中的流水线' }}
          />
        </Card>
      )}

      <div className="atop-dashboard-main-grid">
        <Card
          className="atop-panel-card atop-dashboard-chart-card"
          size="small"
          title={
            <SectionTitle
              icon={<LineChartOutlined />}
              title="近 30 天运行稳定性"
              note="按天聚合成功率、运行量和异常量，帮助判断近期质量是否稳定"
              tone="success"
            />
          }
          extra={<Tag color="blue">有数据天数 {points.length}</Tag>}
        >
          <div className="atop-dashboard-chart-meta">
            <span>总量 <strong>{totalRuns30}</strong></span>
            <span>成功率 <strong style={{ color: rateColor(hasSuccessData ? successRate : undefined) }}>{successRateText}</strong></span>
            <span>异常率 <strong style={{ color: failureColor(exceptionRate) }}>{exceptionRate.toFixed(1)}%</strong></span>
            <span>日均 <strong>{hasSummary ? avgRunsPerDay.toFixed(1) : '0.0'}</strong></span>
          </div>
          {trendLoading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : points.length === 0 ? (
            <Empty description="暂无近 30 天趋势数据" style={{ padding: 34 }} />
          ) : (
            <ResponsiveContainer width="100%" height={246}>
              <ComposedChart data={points} margin={{ top: 10, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="dashboardPassRate" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0F6E56" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#0F6E56" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,35,55,0.08)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <YAxis yAxisId="rate" domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <RTooltip content={<DashboardChartTooltip />} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#647084' }} />
                <Bar yAxisId="count" dataKey="runCount" name="运行次数" fill="#D8E7FF" radius={[5, 5, 0, 0]} />
                <Bar yAxisId="count" dataKey="failedCount" name="失败次数" fill="#F2B7B7" radius={[5, 5, 0, 0]} />
                <Bar yAxisId="count" dataKey="abortedCount" name="中止次数" fill="#F6D7A8" radius={[5, 5, 0, 0]} />
                <Area
                  yAxisId="rate"
                  type="monotone"
                  dataKey="passRate"
                  name="成功率"
                  stroke="#0F6E56"
                  strokeWidth={2.4}
                  fill="url(#dashboardPassRate)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="atop-dashboard-ops-grid">
        <Card
          className="atop-panel-card atop-dashboard-ops-card"
          size="small"
          title={
            <SectionTitle
              icon={<TrophyOutlined />}
              title="高频流水线质量"
              note="继承原全屏大盘的流水线质量排行，按近 30 天运行频次和通过率展示"
              tone="info"
            />
          }
          extra={<Tag color="blue">TOP {pipelineStats.length}</Tag>}
        >
          {pipelineStatsLoading ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : pipelineStats.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水线质量数据" />
          ) : (
            <div className="atop-dashboard-quality-list">
              {pipelineStats.map((item, index) => {
                const passRate = toNumber(item.avgPassRate)
                const tone = passRate >= 90 ? 'success' : passRate >= 70 ? 'warning' : 'danger'
                return (
                  <button
                    type="button"
                    key={item.pipelineId || item.pipelineName}
                    className={`atop-dashboard-quality-item atop-dashboard-quality-${tone}`}
                    onClick={() => navigate(`/run-history?name=${encodeURIComponent(item.pipelineName)}&source=platform`)}
                  >
                    <span className="atop-dashboard-quality-rank">#{index + 1}</span>
                    <span className="atop-dashboard-quality-main">
                      <strong>{item.pipelineName}</strong>
                      <small>{toNumber(item.runCount)} 次运行</small>
                    </span>
                    <span className="atop-dashboard-quality-rate">{passRate.toFixed(1)}%</span>
                    <span className="atop-dashboard-quality-bar">
                      <i style={{ transform: `scaleX(${Math.min(100, Math.max(0, passRate)) / 100})` }} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        <Card
          className="atop-panel-card atop-dashboard-ops-card"
          size="small"
          title={
            <SectionTitle
              icon={<CloseCircleOutlined />}
              title="质量风险 Top 5"
              note="从近 30 天异常率靠前的流水线聚合，方便从大盘直接追踪"
              tone={topFailing.length > 0 ? 'danger' : 'success'}
            />
          }
          extra={<Tag color={topFailing.length > 0 ? 'red' : 'green'}>{topFailing.length > 0 ? `${topFailing.length} 条` : '稳定'}</Tag>}
        >
          {topFailing.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 30 天暂无高风险流水线" />
          ) : (
            <div className="atop-dashboard-risk-list">
              {topFailing.slice(0, 5).map((item) => {
                const riskRate = toNumber(item.exceptionRate, toNumber(item.failureRate, Math.max(0, 100 - toNumber(item.avgPassRate))))
                const exceptionRuns = toNumber(item.exceptionRuns, toNumber(item.failedRuns) + toNumber(item.abortedRuns))
                return (
                  <button
                    type="button"
                    key={item.pipelineId || item.pipelineName}
                    className="atop-dashboard-risk-item"
                    onClick={() => navigate(`/run-history?name=${encodeURIComponent(item.pipelineName)}&source=platform`)}
                  >
                    <span className="atop-dashboard-risk-main">
                      <strong>{item.pipelineName}</strong>
                      <small>异常 {exceptionRuns} / 运行 {toNumber(item.runCount)} 次</small>
                    </span>
                    <span className="atop-dashboard-risk-rate">{riskRate.toFixed(1)}%</span>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        <Card
          className="atop-panel-card atop-dashboard-ops-card"
          size="small"
          title={
            <SectionTitle
              icon={<DesktopOutlined />}
              title="Agent 容量状态"
              note="继承原全屏大盘的 Jenkins 节点在线情况，不按标签重复计数"
              tone={offlineAgentCount > 0 ? 'warning' : 'success'}
            />
          }
          extra={<Tag color={offlineAgentCount > 0 ? 'orange' : 'green'}>{totalAgentCount > 0 ? `${onlineAgentCount}/${totalAgentCount} 在线` : '暂无节点'}</Tag>}
        >
          {agentNodesLoading ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : visibleAgentNodes.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 Agent 节点数据" />
          ) : (
            <div className="atop-dashboard-agent-panel">
              <div className="atop-dashboard-agent-summary">
                <div>
                  <strong>{agentOnlineRate.toFixed(0)}%</strong>
                  <span>在线率</span>
                </div>
                <div>
                  <strong>{offlineAgentCount}</strong>
                  <span>离线节点</span>
                </div>
                <div>
                  <strong>{totalAgentCount}</strong>
                  <span>节点总数</span>
                </div>
              </div>
              <div className="atop-dashboard-agent-list">
                {visibleAgentNodes.slice(0, 3).map((node) => (
                  <div key={node.id} className="atop-dashboard-agent-row">
                    <span className={`atop-dashboard-agent-dot${node.online ? ' is-online' : ' is-offline'}`} />
                    <strong>{node.name || node.nodeId || '未知节点'}</strong>
                    <small>{node.online ? '在线' : '离线'}</small>
                  </div>
                ))}
              </div>
              {visibleAgentNodes.length > 3 && (
                <div className="atop-dashboard-agent-more">
                  <span>仅显示 3/{visibleAgentNodes.length} 个节点</span>
                  <Button size="small" icon={<ToolOutlined />} onClick={() => navigate('/settings/jenkins?view=agents')}>
                    查看更多
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        className="atop-panel-card atop-table-card atop-dashboard-history-card"
        title={
          <SectionTitle
            icon={<HistoryOutlined />}
            title="历史运行记录"
            note="大盘仅保留最近 10 条作为快速入口，完整数据进入运行记录页"
            tone="neutral"
          />
        }
        extra={<Button size="small" onClick={() => navigate('/run-history')}>查看全部</Button>}
        size="small"
        styles={{ body: { padding: 0 } }}
      >
        {isLoading || reportedLoading ? (
          <div style={{ padding: 18 }}>
            <Skeleton active paragraph={{ rows: 5 }} />
          </div>
        ) : (
          <Table
            dataSource={history}
            columns={histCols}
            rowKey={(row) => `${row._source}-${row.id}`}
            size="middle"
            pagination={false}
            locale={{ emptyText: '暂无最近完成运行' }}
          />
        )}
      </Card>

      <Modal
        title={
          <SectionTitle
            icon={<WarningOutlined />}
            title="全部需要关注"
            note="支持搜索和分页；点击事项后会从运行大盘的需要关注中移除"
            tone="danger"
          />
        }
        open={attentionOpen}
        onCancel={() => setAttentionOpen(false)}
        footer={null}
        width={860}
        className="atop-dashboard-attention-modal"
      >
        <div className="atop-trend-modal-toolbar">
          <Input.Search
            allowClear
            placeholder="搜索事项、流水线或指标"
            value={attentionKeyword}
            onChange={(e) => {
              setAttentionKeyword(e.target.value)
              setAttentionPage(1)
            }}
            onSearch={() => setAttentionPage(1)}
            style={{ width: 320 }}
          />
          <span>共 {filteredAttentionItems.length} 条</span>
        </div>
        <Table
          rowKey="id"
          columns={attentionCols}
          dataSource={pagedAttentionItems}
          size="middle"
          scroll={{ x: 640, y: 420 }}
          pagination={{
            current: attentionCurrentPage,
            pageSize: attentionPageSize,
            total: filteredAttentionItems.length,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (pageNo, size) => {
              setAttentionPage(pageNo)
              setAttentionPageSize(size)
            },
          }}
          onRow={(item) => ({
            className: 'atop-dashboard-attention-modal-row',
            onClick: () => handleAttentionClick(item, true),
          })}
          locale={{ emptyText: '暂无匹配事项' }}
        />
      </Modal>

      <Modal
        title="异常处理备注"
        open={attentionNoteOpen}
        onCancel={() => setAttentionNoteOpen(false)}
        onOk={() => {
          if (!attentionNoteItem) return
          updateAttentionWorkflow(attentionNoteItem, attentionWorkflow[attentionNoteItem.id]?.status ?? 'open', attentionNoteDraft.trim())
          setAttentionNoteOpen(false)
        }}
        okText="保存备注"
        cancelText="取消"
      >
        <Input.TextArea
          autoSize={{ minRows: 4, maxRows: 8 }}
          value={attentionNoteDraft}
          onChange={(event) => setAttentionNoteDraft(event.target.value)}
          placeholder="记录处理进展、排查结论或暂不处理原因"
          maxLength={500}
          showCount
        />
      </Modal>
    </div>
  )
}
