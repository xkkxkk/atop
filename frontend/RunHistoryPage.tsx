import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import useSWR from 'swr'
import { Card, Table, Button, Select, Input, Tag, Segmented, Space, Modal, message } from 'antd'
import {
  ClearOutlined, EyeOutlined, FilterOutlined, ReloadOutlined,
  ApiOutlined, DeploymentUnitOutlined, SearchOutlined, HistoryOutlined, RedoOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { runApi } from '@/api/pipelines'
import { useTableLayout } from '@/hooks/useTableLayout'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { fmtDuration, fmtDatetime } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'
import type { PipelineRun } from '@/types'

type Source = 'platform' | 'jenkins_report' | 'all'

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

export default function RunHistoryPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initName = searchParams.get('name') || ''
  const initSource = searchParams.get('source') as Source || (initName ? 'platform' : 'all')
  const initStatus = searchParams.get('status') || undefined

  const { tableProps, defaultPageSize } = useTableLayout({ offsetY: 470 })
  const [source, setSource] = useState<Source>(initSource)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(initStatus)
  const [keyword, setKeyword] = useState<string>(initName)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [rebuildingId, setRebuildingId] = useState<string>()

  // Platform runs
  const { data: platformData, isLoading: platformLoading, mutate: mutPlatform } = useSWR(
    source !== 'jenkins_report' ? ['platform-runs', statusFilter, keyword, page, pageSize] : null,
    () => runApi.list({ status: statusFilter, keyword: keyword || undefined, page, pageSize }),
  )

  // Jenkins reported runs
  const { data: reportedData, isLoading: reportedLoading, mutate: mutReported } = useSWR(
    source !== 'platform' ? ['reported-runs', statusFilter, keyword, page, pageSize] : null,
    () => client.get('/report/runs', {
      params: { status: statusFilter, keyword, page, pageSize },
    }).then(r => r.data.data ?? r.data),
  )

  // Unified view
  const items = (() => {
    if (source === 'platform') {
      return (platformData?.items ?? []).map((r: any) => ({ ...r, _source: 'platform' }))
    }
    if (source === 'jenkins_report') {
      return (reportedData?.items ?? []).map((r: any) => ({ ...r, _source: 'jenkins_report' }))
    }
    // all: combine & sort
    const p = (platformData?.items ?? []).map((r: any) => ({ ...r, _source: 'platform' }))
    const j = (reportedData?.items ?? []).map((r: any) => ({ ...r, _source: 'jenkins_report' }))
    return [...p, ...j].sort((a, b) => {
      const ta = new Date(a.startedAt ?? a.createdAt ?? 0).getTime()
      const tb = new Date(b.startedAt ?? b.createdAt ?? 0).getTime()
      return tb - ta
    })
  })()

  const total = (source === 'platform' ? platformData?.total : source === 'jenkins_report' ? reportedData?.total : (platformData?.total ?? 0) + (reportedData?.total ?? 0)) ?? 0
  const isLoading = platformLoading || reportedLoading
  const activeFilterCount = [source !== 'all', !!statusFilter, !!keyword].filter(Boolean).length
  const resetFilters = () => {
    setStatusFilter(undefined)
    setKeyword('')
    setSource('all')
    setPage(1)
  }

  const handleRebuild = (row: any) => {
    Modal.confirm({
      title: `使用原参数重新运行「${row.pipelineName || row.pipelineKey || '该流水线'}」？`,
      content: '系统会读取这条平台触发记录的运行参数，按当前流水线配置直接创建一次新的运行。',
      okText: '重新运行',
      cancelText: '取消',
      onOk: async () => {
        setRebuildingId(row.id)
        try {
          const res = await runApi.rebuild(row.id)
          message.success('已重新触发运行')
          mutPlatform()
          navigate(`/runs/${res.runId}`)
        } finally {
          setRebuildingId(undefined)
        }
      },
    })
  }

  const cols = [
    {
      title: '来源', dataIndex: '_source', key: 'source', width: 104,
      render: (s: string) => s === 'jenkins_report'
        ? <Tag className="atop-run-source-tag" icon={<ApiOutlined />} color="blue">Jenkins 上报</Tag>
        : <Tag className="atop-run-source-tag" icon={<DeploymentUnitOutlined />} color="green">平台触发</Tag>,
    },
    {
      title: '名称', key: 'name', ellipsis: true,
      render: (_: any, row: any) => {
        const name = row.pipelineName || row.pipelineKey
        return (
          <a style={{ fontWeight: 500 }} onClick={() => {
            if (row._source === 'jenkins_report') {
              navigate(`/reported-runs/${row.id}`)
            } else {
              navigate(`/runs/${row.id}`)
            }
          }}>
            {name}
            {row.buildId ? <span style={{ color: '#9C9A92', marginLeft: 6, fontSize: 11 }}>#{row.buildId}</span> : null}
          </a>
        )
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: PipelineRun['status']) => <PipelineStatusBadge status={s} />,
    },
    {
      title: '触发人', key: 'triggeredBy', width: 100,
      render: (_: any, row: any) => displayUserName(row.triggeredByName, row.triggeredBy, '未知触发人'),
    },
    {
      title: '耗时', dataIndex: 'durationMs', key: 'dur', width: 90,
      render: (ms?: number) => ms ? <span style={{ fontSize: 12, color: '#5F5E5A' }}>{fmtDuration(ms)}</span> : '—',
    },
    {
      title: '开始时间', dataIndex: 'startedAt', key: 'startedAt', width: 160,
      render: (t?: string) => t ? <span style={{ fontSize: 12, color: '#9C9A92' }}>{fmtDatetime(t)}</span> : '—',
    },
    {
      title: '操作', key: 'action', width: 188, fixed: 'right' as const,
      render: (_: unknown, row: any) => (
        <Space size={6} className="atop-run-row-actions">
          <Button className="atop-run-detail-btn" size="small" icon={<EyeOutlined />} onClick={() => {
            if (row._source === 'jenkins_report') {
              navigate(`/reported-runs/${row.id}`)
            } else {
              navigate(`/runs/${row.id}`)
            }
          }}>
            详情
          </Button>
          {row._source === 'platform' && (
            <Button
              className="atop-run-detail-btn"
              size="small"
              icon={<RedoOutlined />}
              loading={rebuildingId === row.id}
              onClick={() => handleRebuild(row)}
            >
              重跑
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="atop-run-history-page">
      <div className="atop-run-history-head" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <PageHeader
          eyebrow="RUN RECORDS"
          title="运行记录"
          subtitle="平台触发与 Jenkins 主动上报统一进入这里，历史记录默认不按流水线授权限制。"
          extra={<Button icon={<ReloadOutlined />} onClick={() => { mutPlatform(); mutReported() }}>刷新</Button>}
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
              onChange={(v) => { setSource(v as Source); setPage(1) }}
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
              onChange={(v) => { setStatusFilter(v); setPage(1) }}
            />
            <Input.Search
              className="atop-run-search"
              prefix={<SearchOutlined />}
              placeholder="搜索流水线名称 / buildId"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onSearch={() => setPage(1)}
              allowClear
            />
            <Button icon={<ClearOutlined />} onClick={resetFilters}>
              重置
            </Button>
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
        title={
          <SectionTitle
            icon={<HistoryOutlined />}
            title="运行记录列表"
            note="支持按来源、状态和名称过滤，点击详情查看阶段与日志"
            tone="neutral"
          />
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table
          {...tableProps}
          dataSource={items}
          columns={cols}
          rowKey="id"
          loading={isLoading}
          scroll={{ x: 980, y: tableProps.scroll?.y }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
        />
      </Card>
    </div>
  )
}
