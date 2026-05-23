import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Card, Select, Space, Table, Tag, Spin, Empty, Radio, Button, Modal, Progress, Input,
} from 'antd'
import {
  BarChartOutlined, TableOutlined, WarningOutlined,
} from '@ant-design/icons'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  Legend, ResponsiveContainer, BarChart, Bar, Area, AreaChart,
} from 'recharts'
import client from '@/api/client'
import PageHeader from '@/components/common/PageHeader'
import MetricCard from '@/components/common/MetricCard'
import SectionTitle from '@/components/common/SectionTitle'
import { useDimensions } from '@/hooks/useDimensions'
import { fmtDuration, rateColor } from '@/utils/format'

type Days = '7' | '30' | '90'
type GroupBy = 'day' | 'week'

function failureRateColor(rate?: number | null): string {
  if (rate == null) return '#9C9A92'
  if (rate >= 50) return '#A32D2D'
  if (rate >= 20) return '#854F0B'
  return '#0F6E56'
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function getExceptionRuns(row: any): number {
  return toNumber(row?.exceptionRuns, toNumber(row?.failedRuns) + toNumber(row?.abortedRuns))
}

function getExceptionRate(row: any): number {
  const backendRate = Number(row?.exceptionRate)
  if (Number.isFinite(backendRate)) return backendRate
  const runCount = toNumber(row?.runCount)
  if (runCount <= 0) return 0
  return Math.round((getExceptionRuns(row) * 1000) / runCount) / 10
}

function formatLastRun(value?: string | null): string {
  if (!value) return '暂无'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '暂无'
  return d.toLocaleDateString()
}

function pipelineOptionLabel(item: any): string {
  return item?.name || item?.pipelineName || item?.displayName || item?.key || item?.id || '未命名流水线'
}

// ── Custom tooltip for recharts ────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#1F1F1E', border: '1px solid #333',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ color: '#9C9A92', marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}：{typeof p.value === 'number' && p.dataKey === 'durationMs'
            ? fmtDuration(p.value)
            : p.dataKey === 'passRate'
            ? `${p.value}%`
            : p.value}
        </div>
      ))}
    </div>
  )
}

export default function TrendPage() {
  const [days, setDays]       = useState<Days>('30')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [project, setProject] = useState<string>('')
  const [pipelineId, setPipelineId] = useState<string>('')
  const [pipelineLabelFallbacks, setPipelineLabelFallbacks] = useState<Record<string, string>>({})
  const [top5Open, setTop5Open] = useState(false)
  const [allStatsOpen, setAllStatsOpen] = useState(false)
  const [statsKeywordDraft, setStatsKeywordDraft] = useState('')
  const [statsKeyword, setStatsKeyword] = useState('')
  const [statsPage, setStatsPage] = useState(1)
  const [statsPageSize, setStatsPageSize] = useState(10)

  const { projectOptions } = useDimensions()

  // Fetch summary
  const summaryKey = [`/stats/summary`, project, days]
  const { data: summaryData } = useSWR(summaryKey,
    () => client.get('/stats/summary', { params: { project: project || undefined, days } })
      .then(r => r.data.data))

  // Fetch trend points
  const trendKey = [`/stats/trends`, pipelineId, project, days, groupBy]
  const { data: trendData, isLoading: trendLoading } = useSWR(trendKey,
    () => client.get('/stats/trends', {
      params: {
        pipelineId: pipelineId || undefined,
        project:    project || undefined,
        days, groupBy,
      }
    }).then(r => r.data.data))

  // Fetch preview only; the full list is loaded lazily in the modal for performance.
  const breakdownKey = [`/stats/pipelines-preview`, project, days]
  const { data: breakdownData, isLoading: breakdownLoading } = useSWR(breakdownKey,
    () => client.get('/stats/pipelines', { params: { project: project || undefined, days, page: 1, pageSize: 5 } })
      .then(r => r.data.data))

  const allStatsKey = allStatsOpen ? [`/stats/pipelines-modal`, project, days, statsKeyword, statsPage, statsPageSize] : null
  const { data: allStatsData, isLoading: allStatsLoading } = useSWR(allStatsKey,
    () => client.get('/stats/pipelines', {
      params: {
        project: project || undefined,
        days,
        keyword: statsKeyword || undefined,
        page: statsPage,
        pageSize: statsPageSize,
      },
    }).then(r => r.data.data))

  // Fetch pipeline list for filter
  const { data: pipelines = [] } = useSWR('/pipelines-for-filter',
    () => client.get('/pipelines', { params: { pageSize: 200 } })
      .then(r => r.data.data?.items ?? []))
  const pipelineOptions = useMemo(() => {
    const options = pipelines
      .filter((p: any) => !project || p.project === project)
      .map((p: any) => ({
        value: p.id || p.pipelineId,
        label: pipelineOptionLabel(p),
      }))
      .filter((item: any) => item.value)
    Object.entries(pipelineLabelFallbacks).forEach(([value, label]) => {
      if (!options.some((item: any) => item.value === value)) {
        options.push({ value, label })
      }
    })
    return options
  }, [pipelines, project, pipelineLabelFallbacks])

  const selectPipelineFilter = (id?: string, label?: string) => {
    const nextId = id ?? ''
    if (nextId && label && !pipelineOptions.some((item: any) => item.value === nextId)) {
      setPipelineLabelFallbacks((prev) => ({ ...prev, [nextId]: label }))
    }
    setPipelineId(nextId)
  }

  const points   = trendData?.points ?? []
  const summary  = summaryData ?? {}
  const breakdown = breakdownData?.items ?? []
  const breakdownTotal = breakdownData?.total ?? breakdown.length
  const visibleBreakdown = breakdown.slice(0, 5)
  const breakdownEmptyText = breakdownTotal > 0 && !breakdownLoading
    ? '统计明细暂未加载成功，请刷新页面或查看全部'
    : '暂无流水线统计数据'
  const allStatsItems = allStatsData?.items ?? []
  const allStatsTotal = allStatsData?.total ?? 0
  const summaryTopFailing: any[] = Array.isArray(summary.topFailing) ? summary.topFailing : []
  const topExceptionPipelines = (summaryTopFailing.length > 0 ? summaryTopFailing : breakdown)
    .map((item: any) => ({
      ...item,
      exceptionRuns: getExceptionRuns(item),
      exceptionRate: getExceptionRate(item),
    }))
    .filter((item: any) => item.exceptionRuns > 0)
    .sort((a: any, b: any) => (
      b.exceptionRate - a.exceptionRate
      || b.exceptionRuns - a.exceptionRuns
      || toNumber(b.runCount) - toNumber(a.runCount)
    ))
    .slice(0, 5)
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(allStatsTotal / statsPageSize))
    if (statsPage > maxPage) {
      setStatsPage(maxPage)
    }
  }, [allStatsTotal, statsPage, statsPageSize])
  const summaryTotalRuns = toNumber(summary.totalRuns)
  const summaryFailedRuns = toNumber(summary.totalFailed)
  const summaryAbortedRuns = toNumber(summary.totalAborted)
  const summaryExceptionRuns = summaryFailedRuns + summaryAbortedRuns
  const summaryExceptionRate = summaryTotalRuns > 0
    ? Math.round((summaryExceptionRuns * 1000) / summaryTotalRuns) / 10
    : 0

  const breakdownCols = [
    {
      title: '流水线', dataIndex: 'pipelineName', ellipsis: true,
      width: 220,
      render: (v: string, r: any) => (
        <span
          className="atop-trend-pipeline-link"
          onClick={() => selectPipelineFilter(r.pipelineId, v || r.pipelineName)}
          title={v}
        >
          {v}
        </span>
      ),
    },
    { title: '运行次数', dataIndex: 'runCount', width: 90,
      render: (v: number) => <Tag>{v} 次</Tag> },
    {
      title: '平均成功率', dataIndex: 'avgPassRate', width: 110,
      render: (v: number) => (
        <span style={{ color: rateColor(v), fontWeight: 600 }}>{toNumber(v).toFixed(1)}%</span>
      ),
      sorter: (a: any, b: any) => toNumber(a.avgPassRate) - toNumber(b.avgPassRate),
    },
    {
      title: '平均耗时', dataIndex: 'avgDuration', width: 110,
      render: (v: number) => (
        <span style={{ color: '#9C9A92' }}>{toNumber(v) > 0 ? fmtDuration(v) : '暂无'}</span>
      ),
    },
    {
      title: '异常运行', key: 'exceptionRuns', width: 128,
      render: (_: unknown, row: any) => (
        <Space size={4} wrap>
          <Tag color={toNumber(row.failedRuns) > 0 ? 'red' : 'green'}>失败 {toNumber(row.failedRuns)}</Tag>
          <Tag color={toNumber(row.abortedRuns) > 0 ? 'orange' : 'default'}>中止 {toNumber(row.abortedRuns)}</Tag>
        </Space>
      ),
      sorter: (a: any, b: any) => getExceptionRuns(a) - getExceptionRuns(b),
    },
    {
      title: '异常率', key: 'exceptionRate', width: 100,
      render: (_: unknown, row: any) => {
        const rate = getExceptionRate(row)
        return <span style={{ color: failureRateColor(rate), fontWeight: 700 }}>{rate.toFixed(1)}%</span>
      },
      sorter: (a: any, b: any) => getExceptionRate(a) - getExceptionRate(b),
    },
    {
      title: '最近运行', dataIndex: 'lastRunAt', width: 112,
      render: (v: string) => <span style={{ color: '#9C9A92' }}>{formatLastRun(v)}</span>,
    },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="QUALITY TREND"
        title="历史趋势"
        subtitle="按项目、流水线和时间范围观察质量走势，帮助定位长期异常率高的任务。"
        extra={
          <Space wrap>
            <Select
              placeholder="全部项目"
              allowClear
              style={{ width: 160 }}
              value={project || undefined}
              onChange={v => { setProject(v ?? ''); setPipelineId(''); setStatsPage(1) }}
              options={projectOptions}
            />
            <Select
              placeholder="全部流水线"
              allowClear
              showSearch
              style={{ width: 200 }}
              value={pipelineId || undefined}
              onChange={v => selectPipelineFilter(v ?? '')}
              optionFilterProp="label"
              options={pipelineOptions}
            />
            <Radio.Group
              value={days}
              onChange={e => { setDays(e.target.value); setStatsPage(1) }}
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="7">7 天</Radio.Button>
              <Radio.Button value="30">30 天</Radio.Button>
              <Radio.Button value="90">90 天</Radio.Button>
            </Radio.Group>
          </Space>
        }
      />

      {/* Summary metrics */}
      <div className="atop-metric-grid">
        <MetricCard
          label={`总运行次数（近 ${days} 天）`}
          value={summaryTotalRuns}
          foot="当前筛选范围内的运行总量"
        />
        <MetricCard
          label="平均成功率"
          value={summary.avgPassRate != null ? `${toNumber(summary.avgPassRate).toFixed(1)}%` : '暂无'}
          color={rateColor(summary.avgPassRate)}
          tone={summary.avgPassRate >= 80 ? 'success' : summary.avgPassRate > 0 ? 'danger' : 'default'}
          foot={summary.avgPassRate >= 80 ? '质量表现稳定' : summary.avgPassRate > 0 ? '低于建议阈值 80%' : '等待统计数据'}
        />
        <MetricCard
          label="平均耗时"
          value={toNumber(summary.avgDuration) > 0 ? fmtDuration(summary.avgDuration) : '暂无耗时'}
          foot="部分 Jenkins 上报可能缺少耗时"
        />
        <MetricCard
          label="异常运行"
          value={summaryExceptionRuns}
          color={summaryExceptionRuns > 0 ? '#DC2626' : undefined}
          tone={summaryExceptionRuns > 0 ? 'danger' : 'default'}
          foot={summaryExceptionRuns > 0 ? `异常率 ${summaryExceptionRate.toFixed(1)}%，失败 ${summaryFailedRuns} / 中止 ${summaryAbortedRuns}` : '当前范围暂无异常'}
        />
      </div>

      {/* Trend charts */}
      <div className="atop-two-grid" style={{ marginBottom: 16 }}>
        {/* Pass rate trend */}
        <Card
          className="atop-panel-card"
          title={<div className="atop-panel-title">成功率趋势</div>}
          size="small"
          extra={
            <Radio.Group
              value={groupBy}
              onChange={e => setGroupBy(e.target.value)}
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="day">按天</Radio.Button>
              <Radio.Button value="week">按周</Radio.Button>
            </Radio.Group>
          }
        >
          {trendLoading ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin />
            </div>
          ) : points.length === 0 ? (
            <Empty description="暂无数据" style={{ padding: 40 }} />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <defs>
                  <linearGradient id="passRateGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0F6E56" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0F6E56" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <RTooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="passRate"
                  name="成功率"
                  stroke="#0F6E56"
                  fill="url(#passRateGrad)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Duration trend */}
        <Card
          className="atop-panel-card"
          title={
            <div>
              <div className="atop-panel-title">平均耗时趋势</div>
              <div className="atop-panel-note">等待 Jenkins 上报耗时后可持续观察瓶颈</div>
            </div>
          }
          size="small"
        >
          {trendLoading ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin />
            </div>
          ) : points.length === 0 ? (
            <Empty description="暂无数据" style={{ padding: 40 }} />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9C9A92" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#9C9A92"
                  tickFormatter={v => fmtDuration(v)}
                />
                <RTooltip content={<ChartTooltip />} />
                <Line
                  type="monotone"
                  dataKey="durationMs"
                  name="平均耗时"
                  stroke="#2563EB"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Run count + failed count bar chart */}
      <Card
        className="atop-panel-card"
        title={<div className="atop-panel-title">每日运行量与异常量</div>}
        size="small"
        style={{ marginBottom: 16 }}
      >
        {trendLoading ? (
          <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : points.length === 0 ? (
          <Empty description="暂无数据" style={{ padding: 30 }} />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9C9A92" />
              <YAxis tick={{ fontSize: 11 }} stroke="#9C9A92" />
              <RTooltip content={<ChartTooltip />} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="runCount"    name="运行次数" fill="#2563EB" radius={[2,2,0,0]} />
              <Bar dataKey="failedCount" name="失败次数" fill="#DC2626" radius={[2,2,0,0]} />
              <Bar dataKey="abortedCount" name="中止次数" fill="#D97706" radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card
        className="atop-panel-card atop-trend-breakdown-card"
        title={
          <SectionTitle
            icon={<TableOutlined />}
            title={`各流水线统计（近 ${days} 天）`}
            note="默认展示最近运行量最高的 5 条，展开后可查看当前筛选范围内全部流水线"
            tone="neutral"
          />
        }
        size="small"
        extra={
          <Space wrap>
            <Button
              size="small"
              icon={<WarningOutlined />}
              disabled={topExceptionPipelines.length === 0}
              onClick={() => setTop5Open(true)}
            >
              查看异常率 TOP 5
            </Button>
            <Button
              size="small"
              onClick={() => {
                setStatsKeywordDraft('')
                setStatsKeyword('')
                setStatsPage(1)
                setAllStatsOpen(true)
              }}
            >
              查看全部 {breakdownTotal} 条
            </Button>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table
          rowKey={(row) => row.pipelineId || row.pipelineName}
          columns={breakdownCols}
          dataSource={visibleBreakdown}
          loading={breakdownLoading}
          size="middle"
          pagination={false}
          scroll={{ x: 900 }}
          tableLayout="fixed"
          className="atop-trend-preview-table"
          locale={{ emptyText: breakdownEmptyText }}
        />
      </Card>

      <Modal
        title={
          <SectionTitle
            icon={<TableOutlined />}
            title={`全部流水线统计（近 ${days} 天）`}
            note="按服务端分页加载，支持搜索流水线名称，避免一次性渲染大量 30 天统计数据"
            tone="neutral"
          />
        }
        open={allStatsOpen}
        onCancel={() => setAllStatsOpen(false)}
        footer={null}
        width={980}
        className="atop-trend-stats-modal"
      >
        <div className="atop-trend-modal-toolbar">
          <Input.Search
            allowClear
            placeholder="搜索流水线名称"
            value={statsKeywordDraft}
            onChange={(e) => {
              setStatsKeywordDraft(e.target.value)
              if (!e.target.value) {
                setStatsKeyword('')
                setStatsPage(1)
              }
            }}
            onSearch={(value) => {
              setStatsKeyword(value.trim())
              setStatsPage(1)
            }}
            style={{ width: 280 }}
          />
          <span>共 {allStatsTotal} 条</span>
        </div>
        <Table
          rowKey={(row) => row.pipelineId || row.pipelineName}
          columns={breakdownCols}
          dataSource={allStatsItems}
          loading={allStatsLoading}
          size="middle"
          scroll={{ x: 920, y: 520 }}
          pagination={{
            current: statsPage,
            pageSize: statsPageSize,
            total: allStatsTotal,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setStatsPage(p)
              setStatsPageSize(ps)
            },
          }}
          locale={{ emptyText: '暂无匹配流水线' }}
        />
      </Modal>

      <Modal
        title={
          <SectionTitle
            icon={<BarChartOutlined />}
            title="异常率最高的流水线 TOP 5"
            note="统计口径：失败、错误、中止运行 / 当前筛选范围内总运行次数"
            tone="danger"
          />
        }
        open={top5Open}
        onCancel={() => setTop5Open(false)}
        footer={null}
        width={760}
      >
        {topExceptionPipelines.length === 0 ? (
          <Empty description="当前范围暂无异常流水线" style={{ padding: 30 }} />
        ) : (
          <div className="atop-trend-top-list">
            {topExceptionPipelines.map((p: any, i: number) => {
              const exceptionRate = getExceptionRate(p)
              const exceptionRuns = getExceptionRuns(p)
              const failedRuns = toNumber(p.failedRuns)
              const abortedRuns = toNumber(p.abortedRuns)
              const runCount = toNumber(p.runCount)
              return (
                <button
                  key={p.pipelineId || p.pipelineName}
                  className="atop-trend-top-item"
                  onClick={() => {
                    selectPipelineFilter(p.pipelineId, p.pipelineName)
                    setTop5Open(false)
                  }}
                >
                  <span className="atop-trend-top-rank">{i + 1}</span>
                  <span className="atop-trend-top-main">
                    <strong>{p.pipelineName || '未命名流水线'}</strong>
                    <small>运行 {runCount} 次，异常 {exceptionRuns} 次，失败 {failedRuns} / 中止 {abortedRuns}</small>
                    <Progress
                      percent={Math.min(100, Math.max(0, exceptionRate))}
                      showInfo={false}
                      strokeColor={failureRateColor(exceptionRate)}
                      trailColor="#EEF2F7"
                    />
                  </span>
                  <span className="atop-trend-top-rate" style={{ color: failureRateColor(exceptionRate) }}>
                    {exceptionRate.toFixed(1)}%
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}
