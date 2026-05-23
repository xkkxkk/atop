import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import useSWR from 'swr'
import { Card, Table, Button, Select, Input, Tag, Segmented, Space, Modal, message } from 'antd'
import {
  ClearOutlined,
  EyeOutlined,
  FilterOutlined,
  ReloadOutlined,
  ApiOutlined,
  DeploymentUnitOutlined,
  SearchOutlined,
  HistoryOutlined,
  RedoOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { runApi } from '@/api/pipelines'
import { useTableLayout } from '@/hooks/useTableLayout'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import SavedFilterViews from '@/components/common/SavedFilterViews'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { fmtDuration, fmtDatetime } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'
import type { PipelineRun } from '@/types'

type Source = 'platform' | 'jenkins_report' | 'all'

type UnifiedRun = Record<string, any> & {
  _source: Source | 'platform' | 'jenkins_report'
}

type RunHistoryFilters = {
  source: Source
  statusFilter?: string
  keyword: string
}

const STATUS_OPTIONS = [
  { label: '运行中', value: 'running' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '异常', value: 'error' },
  { label: '已中止', value: 'aborted' },
]

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  error: '异常',
  aborted: '已中止',
}

const SOURCE_LABEL: Record<Source, string> = {
  all: '全部来源',
  platform: '平台触发',
  jenkins_report: 'Jenkins 上报',
}

const ACTIVE_RUN_STATUSES = ['pending', 'submitting', 'queued_in_jenkins', 'waiting', 'running']

function getRunTime(row: UnifiedRun) {
  return row.startedAt ?? row.createdAt ?? ''
}

function normalize(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function receiptMapKey(name?: string, buildId?: string | number, buildUrl?: string) {
  if (buildUrl) return `url:${normalize(buildUrl)}`
  if (buildId && name) return `build:${normalize(name)}#${String(buildId)}`
  return ''
}

function buildReportedMap(items: UnifiedRun[]) {
  const map = new Map<string, UnifiedRun>()
  items.forEach((item) => {
    const name = item.pipelineName || item.pipelineKey
    const keyByUrl = receiptMapKey(name, item.buildId, item.buildUrl)
    if (keyByUrl) map.set(keyByUrl, item)
    if (item.buildId && name) {
      map.set(`build:${normalize(name)}#${String(item.buildId)}`, item)
    }
  })
  return map
}

function receiptMeta(row: UnifiedRun, reportedMap: Map<string, UnifiedRun>) {
  if (row._source === 'jenkins_report') {
    return {
      tone: row.status === 'success' ? 'green' : row.status === 'failed' || row.status === 'error' ? 'red' : 'blue',
      label: 'Jenkins 主动上报',
      detail: row.buildId ? `Build #${row.buildId}` : '独立上报记录',
      buildUrl: row.buildUrl,
      matched: true,
    }
  }

  const pipelineName = row.pipelineName || row.pipelineKey
  const matched = reportedMap.get(receiptMapKey(pipelineName, row.jenkinsBuildId, row.jenkinsBuildUrl))
    || reportedMap.get(receiptMapKey(pipelineName, row.jenkinsBuildId))

  if (matched) {
    return {
      tone: matched.status === 'success' ? 'green' : matched.status === 'failed' || matched.status === 'error' ? 'red' : 'blue',
      label: matched.status === 'success' ? '已接收 Jenkins 回执' : 'Jenkins 回执异常',
      detail: matched.buildId ? `Build #${matched.buildId} · ${STATUS_LABEL[matched.status] ?? matched.status}` : '已收到 Jenkins 回执',
      buildUrl: matched.buildUrl || row.jenkinsBuildUrl,
      matched: true,
    }
  }

  if (row.jenkinsBuildId || row.jenkinsBuildUrl) {
    return {
      tone: ACTIVE_RUN_STATUSES.includes(String(row.status)) ? 'blue' : 'orange',
      label: ACTIVE_RUN_STATUSES.includes(String(row.status)) ? '等待 Jenkins 回执' : '未收到 Jenkins 回执',
      detail: row.jenkinsBuildId ? `Build #${row.jenkinsBuildId}` : '已提交 Jenkins',
      buildUrl: row.jenkinsBuildUrl,
      matched: false,
    }
  }

  return {
    tone: undefined,
    label: '平台链路',
    detail: '当前记录没有 Jenkins 回执信息',
    buildUrl: undefined,
    matched: false,
  }
}

export default function RunHistoryPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initName = searchParams.get('name') || ''
  const initSource = (searchParams.get('source') as Source) || (initName ? 'platform' : 'all')
  const initStatus = searchParams.get('status') || undefined
  const { tableProps, defaultPageSize } = useTableLayout({ offsetY: 470 })
  const tableScrollY = Math.max(260, Number(tableProps.scroll?.y ?? 360) - 24)

  const [source, setSource] = useState<Source>(initSource)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(initStatus)
  const [keyword, setKeyword] = useState(initName)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [rebuildingId, setRebuildingId] = useState<string>()

  const { data: platformData, isLoading: platformLoading, mutate: mutatePlatform } = useSWR(
    source !== 'jenkins_report' ? ['platform-runs', statusFilter, keyword, page, pageSize] : null,
    () => runApi.list({ status: statusFilter, keyword: keyword || undefined, page, pageSize }),
  )

  const { data: reportedData, isLoading: reportedLoading, mutate: mutateReported } = useSWR(
    source !== 'platform' ? ['reported-runs', statusFilter, keyword, page, pageSize] : null,
    () => client.get('/report/runs', {
      params: { status: statusFilter, keyword, page, pageSize },
    }).then((response) => response.data.data ?? response.data),
  )

  const { data: reportedLookupData } = useSWR(
    source === 'platform' ? ['reported-runs-lookup', statusFilter, keyword] : null,
    () => client.get('/report/runs', {
      params: { status: statusFilter, keyword, page: 1, pageSize: 1000 },
    }).then((response) => response.data.data ?? response.data),
  )

  const items = useMemo<UnifiedRun[]>(() => {
    if (source === 'platform') {
      return (platformData?.items ?? []).map((item: any) => ({ ...item, _source: 'platform' }))
    }
    if (source === 'jenkins_report') {
      return (reportedData?.items ?? []).map((item: any) => ({ ...item, _source: 'jenkins_report' }))
    }
    const platformItems = (platformData?.items ?? []).map((item: any) => ({ ...item, _source: 'platform' }))
    const reportedItems = (reportedData?.items ?? []).map((item: any) => ({ ...item, _source: 'jenkins_report' }))
    return [...platformItems, ...reportedItems].sort((left, right) => {
      const leftTime = new Date(getRunTime(left) || 0).getTime()
      const rightTime = new Date(getRunTime(right) || 0).getTime()
      return rightTime - leftTime
    })
  }, [platformData?.items, reportedData?.items, source])

  const reportedLookupItems = useMemo(
    () => (source === 'platform' ? ((reportedLookupData?.items ?? []) as UnifiedRun[]) : ((reportedData?.items ?? []) as UnifiedRun[])),
    [reportedData?.items, reportedLookupData?.items, source],
  )
  const reportedMap = useMemo(() => buildReportedMap(reportedLookupItems), [reportedLookupItems])

  const total = (source === 'platform'
    ? platformData?.total
    : source === 'jenkins_report'
      ? reportedData?.total
      : (platformData?.total ?? 0) + (reportedData?.total ?? 0)) ?? 0
  const isLoading = platformLoading || reportedLoading
  const activeFilterCount = [source !== 'all', !!statusFilter, !!keyword].filter(Boolean).length

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(total / pageSize))
    if (page > maxPage) {
      setPage(maxPage)
    }
  }, [page, pageSize, total])

  const resetFilters = () => {
    setStatusFilter(undefined)
    setKeyword('')
    setSource('all')
    setPage(1)
  }

  const applySavedFilters = (filters: RunHistoryFilters) => {
    setSource(filters.source ?? 'all')
    setStatusFilter(filters.statusFilter || undefined)
    setKeyword(filters.keyword ?? '')
    setPage(1)
  }

  const handleRebuild = (row: UnifiedRun) => {
    if (ACTIVE_RUN_STATUSES.includes(row.status)) {
      message.info('运行中的记录暂时不能重跑，请等待当前执行结束后再操作')
      return
    }

    Modal.confirm({
      title: `使用当时快照重跑「${row.pipelineName || row.pipelineKey || '该流水线'}」？`,
      content: '系统会读取这条运行当时保存的流水线快照和运行参数创建新任务，不读取当前最新配置。',
      okText: '重新运行',
      cancelText: '取消',
      onOk: async () => {
        setRebuildingId(row.id)
        try {
          const result = await runApi.rebuild(row.id)
          message.success('已按历史快照创建重跑')
          mutatePlatform()
          navigate(`/runs/${result.runId}`)
        } finally {
          setRebuildingId(undefined)
        }
      },
    })
  }

  const columns = [
    {
      title: '来源',
      dataIndex: '_source',
      key: 'source',
      width: 104,
      render: (value: string) => value === 'jenkins_report'
        ? <Tag className="atop-run-source-tag" icon={<ApiOutlined />} color="blue">Jenkins 上报</Tag>
        : <Tag className="atop-run-source-tag" icon={<DeploymentUnitOutlined />} color="green">平台触发</Tag>,
    },
    {
      title: '名称',
      key: 'name',
      ellipsis: true,
      render: (_value: unknown, row: UnifiedRun) => {
        const name = row.pipelineName || row.pipelineKey
        return (
          <a
            style={{ fontWeight: 500 }}
            onClick={() => navigate(row._source === 'jenkins_report' ? `/reported-runs/${row.id}` : `/runs/${row.id}`)}
          >
            {name}
            {row.buildId ? <span style={{ color: '#9C9A92', marginLeft: 6, fontSize: 11 }}>#{row.buildId}</span> : null}
          </a>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: PipelineRun['status']) => <PipelineStatusBadge status={value} />,
    },
    {
      title: 'Jenkins 回执',
      key: 'receipt',
      width: 220,
      render: (_value: unknown, row: UnifiedRun) => {
        const meta = receiptMeta(row, reportedMap)
        return (
          <div className="atop-run-receipt-cell">
            <Tag color={meta.tone}>{meta.label}</Tag>
            <span>{meta.detail}</span>
            {meta.buildUrl && (
              <a href={meta.buildUrl} target="_blank" rel="noreferrer">
                <LinkOutlined /> Jenkins
              </a>
            )}
          </div>
        )
      },
    },
    {
      title: '触发人',
      key: 'triggeredBy',
      width: 108,
      render: (_value: unknown, row: UnifiedRun) => (
        <span>{displayUserName(row.triggeredByName, row.triggeredBy, '未知触发人')}</span>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 90,
      render: (value?: number) => value ? <span style={{ fontSize: 12, color: '#5F5E5A' }}>{fmtDuration(value)}</span> : '—',
    },
    {
      title: '开始时间',
      key: 'startedAt',
      width: 164,
      render: (_value: unknown, row: UnifiedRun) => (
        <span style={{ fontSize: 12, color: '#9C9A92' }}>
          {getRunTime(row) ? fmtDatetime(getRunTime(row)) : '—'}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      fixed: 'right' as const,
      render: (_value: unknown, row: UnifiedRun) => {
        const rebuildDisabled = ACTIVE_RUN_STATUSES.includes(row.status)
        return (
          <Space size={6} className="atop-run-row-actions">
            <Button
              className="atop-run-detail-btn"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(row._source === 'jenkins_report' ? `/reported-runs/${row.id}` : `/runs/${row.id}`)}
            >
              详情
            </Button>
            {row._source === 'platform' && (
              <Button
                className="atop-run-detail-btn"
                size="small"
                icon={<RedoOutlined />}
                loading={rebuildingId === row.id}
                disabled={rebuildDisabled}
                title={rebuildDisabled ? '运行中暂不可重跑，请等待结束后再操作' : undefined}
                onClick={() => handleRebuild(row)}
              >
                重跑
              </Button>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <div className="atop-run-history-page">
      <div className="atop-run-history-head" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <PageHeader
          eyebrow="RUN RECORDS"
          title="运行记录"
          subtitle="平台触发与 Jenkins 主动上报统一汇总在这里，列表会额外标出是否已接收 Jenkins 回执。"
          extra={<Button icon={<ReloadOutlined />} onClick={() => { mutatePlatform(); mutateReported() }}>刷新</Button>}
        />
        <div className="atop-run-filter-panel">
          <div className="atop-run-filter-copy">
            <span className="atop-run-filter-icon"><FilterOutlined /></span>
            <div>
              <div className="atop-run-filter-title">筛选运行记录</div>
              <div className="atop-run-filter-note">按来源、状态、名称快速定位执行记录</div>
            </div>
          </div>
          <div className="atop-run-filter-controls">
            <Segmented
              className="atop-run-source-switch"
              value={source}
              onChange={(value) => { setSource(value as Source); setPage(1) }}
              options={[
                { label: '全部', value: 'all' },
                { label: '平台触发', value: 'platform' },
                { label: 'Jenkins 上报', value: 'jenkins_report' },
              ]}
            />
            <Select
              className="atop-run-status-select"
              placeholder="全部状态"
              allowClear
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={(value) => { setStatusFilter(value); setPage(1) }}
            />
            <Input.Search
              className="atop-run-search"
              prefix={<SearchOutlined />}
              placeholder="搜索流水线名称 / buildId"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onSearch={() => setPage(1)}
              allowClear
            />
            <Button icon={<ClearOutlined />} onClick={resetFilters}>
              重置
            </Button>
            <SavedFilterViews<RunHistoryFilters>
              storageKey="atop.savedFilters.runHistory.v1"
              currentFilters={{ source, statusFilter, keyword }}
              onApply={applySavedFilters}
              activeCount={activeFilterCount}
              presets={[
                { name: '失败运行', note: '平台与 Jenkins 失败记录', filters: { source: 'all', statusFilter: 'failed', keyword: '' } },
                { name: '中止运行', note: '快速定位 aborted', filters: { source: 'all', statusFilter: 'aborted', keyword: '' } },
                { name: 'Jenkins 上报失败', note: '只看外部回执', filters: { source: 'jenkins_report', statusFilter: 'failed', keyword: '' } },
              ]}
            />
          </div>
          <div className="atop-run-filter-summary">
            <span>来源：{SOURCE_LABEL[source]}</span>
            <span>状态：{statusFilter ? STATUS_LABEL[statusFilter] : '全部状态'}</span>
            <span>筛选：{activeFilterCount} 项</span>
            <strong>共 {total} 条</strong>
          </div>
        </div>
      </div>

      <Card
        className="atop-panel-card atop-table-card atop-run-history-card"
        size="small"
        title={(
          <SectionTitle
            icon={<HistoryOutlined />}
            title="运行记录列表"
            note="新增 Jenkins 回执列后，可以直接区分平台发起、Jenkins 已回执、以及回执失败或未回执的情况"
            tone="neutral"
          />
        )}
        styles={{ body: { padding: 0 } }}
      >
        <Table
          {...tableProps}
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          scroll={{ x: 1320, y: tableScrollY }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (value) => `共 ${value} 条`,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPage)
              setPageSize(nextPageSize)
            },
          }}
        />
      </Card>
    </div>
  )
}
