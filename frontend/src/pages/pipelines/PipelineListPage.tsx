import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import { Card, Table, Button, Space, Tag, Select, Radio, Pagination, Tooltip, Input, message } from 'antd'
import {
  PlusOutlined,
  HistoryOutlined,
  EditOutlined,
  TeamOutlined,
  CaretRightOutlined,
  DeploymentUnitOutlined,
  ApiOutlined,
  SafetyCertificateOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { pipelineApi } from '@/api/pipelines'
import { useDimensions } from '@/hooks/useDimensions'
import { useTableLayout } from '@/hooks/useTableLayout'
import { PermGuard } from '@/hooks/usePermission'
import EndOfListHint from '@/components/common/EndOfListHint'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import EmptyState from '@/components/common/EmptyState'
import { fmtDatetime } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'
import PipelineAccessDrawer from '@/components/pipeline/PipelineAccessDrawer'
import SavedFilterViews from '@/components/common/SavedFilterViews'
import { showConfirm } from '@/components/common/ConfirmModal'
import { getPipelineJenkinsSummary, getTriggerTypeMeta } from '@/utils/pipelineDag'
import type { Pipeline } from '@/types'

const ROLE_LABELS: Record<string, { label: string; color: string }> = {
  owner: { label: '创建人', color: '#0F6E56' },
  operator: { label: '可触发', color: '#185FA5' },
  viewer: { label: '可查看', color: '#5F5E5A' },
  legacy: { label: '历史权限', color: '#854F0B' },
}

const TRIGGER_FILTER_OPTIONS = [
  { label: '手动触发', value: 'manual' },
  { label: 'Cron 定时', value: 'cron' },
  { label: 'Webhook', value: 'webhook' },
  { label: '子流水线', value: 'child' },
]

const LAST_STATUS_OPTIONS = [
  { label: '运行中', value: 'running' },
  { label: '等待中', value: 'pending' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '异常', value: 'error' },
  { label: '已中止', value: 'aborted' },
]

type PipelineFilters = {
  keyword: string
  projFilter?: string
  envFilter?: string
  productFilter?: string
  osFilter?: string
  runTypeFilter?: string
  triggerFilter?: string
  lastStatusFilter?: string
  viewMode: 'table' | 'card'
}

function renderTriggerTag(row: Pipeline) {
  const meta = getTriggerTypeMeta(row.triggerType, row.cronExpr)
  return (
    <Tooltip title={meta.detail}>
      <Tag
        className="atop-trigger-meta-tag"
        style={{ fontSize: 11, background: '#F5F5F4', color: meta.color, border: 'none' }}
      >
        {meta.label}
      </Tag>
    </Tooltip>
  )
}

function renderJobSummary(row: Pipeline) {
  const summary = getPipelineJenkinsSummary(row)
  if (summary.uniqueJobCount === 0) {
    return <span className="atop-table-strong"><ApiOutlined /> 未配置</span>
  }

  return (
    <Tooltip
      title={(
        <div className="atop-rich-tooltip">
          <strong>{summary.uniqueJobCount} 个 Jenkins Job</strong>
          <span>{summary.componentCount} 个 Jenkins 组件正在引用这些 Job</span>
          {summary.jobNames.map((jobName) => (
            <code key={jobName}>{jobName}</code>
          ))}
        </div>
      )}
    >
      <span className="atop-table-strong">
        <ApiOutlined /> {summary.uniqueJobCount} 个 Job
      </span>
    </Tooltip>
  )
}

export default function PipelineListPage() {
  const navigate = useNavigate()
  const { defaultPageSize } = useTableLayout({ offsetY: 240 })
  const [keyword, setKeyword] = useState('')
  const [projFilter, setProjFilter] = useState<string>()
  const [envFilter, setEnvFilter] = useState<string>()
  const [productFilter, setProductFilter] = useState<string>()
  const [osFilter, setOsFilter] = useState<string>()
  const [runTypeFilter, setRunTypeFilter] = useState<string>()
  const [triggerFilter, setTriggerFilter] = useState<string>()
  const [lastStatusFilter, setLastStatusFilter] = useState<string>()
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [accessOpen, setAccessOpen] = useState(false)
  const [accessPipeline, setAccessPipeline] = useState<{ id: string; name: string }>()
  const {
    projectOptions,
    environmentOptions,
    productOptions,
    osOptions,
    runTypeOptions,
  } = useDimensions()

  const { data, isLoading, mutate } = useSWR(
    ['pipelines', keyword, projFilter, envFilter, productFilter, osFilter, runTypeFilter, triggerFilter, lastStatusFilter, page, pageSize],
    () => pipelineApi.list({
      keyword: keyword || undefined,
      project: projFilter,
      environment: envFilter,
      product: productFilter,
      os: osFilter,
      runType: runTypeFilter,
      triggerType: triggerFilter,
      lastRunStatus: lastStatusFilter,
      page,
      pageSize,
    }),
  )

  const pipelines = data?.items ?? []
  const configuredCount = data?.total ?? pipelines.length
  const runnableCount = pipelines.filter((item) => item.canTrigger !== false).length
  const editableCount = pipelines.filter((item) => item.canEdit !== false).length
  const jenkinsJobCount = pipelines.reduce((sum, item) => sum + getPipelineJenkinsSummary(item).uniqueJobCount, 0)
  const isLastPage = configuredCount > 0 && page * pageSize >= configuredCount
  const activeFilterCount = [
    keyword,
    projFilter,
    envFilter,
    productFilter,
    osFilter,
    runTypeFilter,
    triggerFilter,
    lastStatusFilter,
  ].filter(Boolean).length

  const resetFilters = () => {
    setKeyword('')
    setProjFilter(undefined)
    setEnvFilter(undefined)
    setProductFilter(undefined)
    setOsFilter(undefined)
    setRunTypeFilter(undefined)
    setTriggerFilter(undefined)
    setLastStatusFilter(undefined)
    setPage(1)
  }

  const applySavedFilters = (filters: PipelineFilters) => {
    setKeyword(filters.keyword ?? '')
    setProjFilter(filters.projFilter)
    setEnvFilter(filters.envFilter)
    setProductFilter(filters.productFilter)
    setOsFilter(filters.osFilter)
    setRunTypeFilter(filters.runTypeFilter)
    setTriggerFilter(filters.triggerFilter)
    setLastStatusFilter(filters.lastStatusFilter)
    setViewMode(filters.viewMode ?? 'table')
    setPage(1)
  }

  const handleDelete = (row: Pipeline) => {
    showConfirm({
      title: `确认删除流水线「${row.name}」？`,
      content: '删除后该流水线配置不可恢复，历史运行记录仍保留在运行记录中。',
      okText: '删除',
      okDanger: true,
      onOk: async () => {
        await pipelineApi.delete(row.id)
        message.success('流水线已删除')
        mutate()
      },
    })
  }

  const renderActions = (row: Pipeline, variant: 'card' | 'table' = 'card') => {
    const canEdit = row.canEdit !== false
    const canTrigger = row.canTrigger !== false
    const isOwner = row.currentRole === 'owner'

    return (
      <div className={`atop-row-actions ${variant === 'table' ? 'atop-row-actions-table' : ''}`}>
        {canTrigger && (
          <Button
            className="atop-action-button atop-trigger-action"
            aria-label={`触发运行 ${row.name}`}
            icon={<CaretRightOutlined />}
            type="primary"
            onClick={() => navigate(`/pipelines/${row.id}/run`)}
          >
            {variant === 'table' ? '触发' : '触发运行'}
          </Button>
        )}
        <div className="atop-row-secondary-actions">
          {canEdit && (
            <Button
              className="atop-action-button atop-secondary-action"
              aria-label={`编辑流水线 ${row.name}`}
              icon={<EditOutlined />}
              onClick={() => navigate(`/pipelines/${row.id}/edit`)}
            >
              编辑
            </Button>
          )}
          {isOwner && (
            <Button
              className="atop-action-button atop-secondary-action"
              aria-label={`分配流水线权限 ${row.name}`}
              icon={<TeamOutlined />}
              onClick={() => {
                setAccessPipeline({ id: row.id, name: row.name })
                setAccessOpen(true)
              }}
            >
              权限
            </Button>
          )}
          <Button
            className="atop-action-button atop-secondary-action"
            aria-label={`查看运行历史 ${row.name}`}
            icon={<HistoryOutlined />}
            onClick={() => navigate(`/run-history?name=${encodeURIComponent(row.name)}&source=platform`)}
          >
            历史
          </Button>
        </div>
        {canEdit && (
          <div className="atop-row-danger-zone" aria-label="危险操作">
            <PermGuard resource="pipeline" action="delete">
              <Button
                className="atop-action-button atop-danger-action"
                aria-label={`删除流水线 ${row.name}`}
                icon={<DeleteOutlined />}
                danger
                onClick={() => handleDelete(row)}
              >
                删除
              </Button>
            </PermGuard>
          </div>
        )}
      </div>
    )
  }

  const renderPipelineName = (row: Pipeline) => (
    <div className="atop-pipeline-title-cell">
      <span className="atop-pipeline-mark"><DeploymentUnitOutlined /></span>
      <div style={{ minWidth: 0 }}>
        {row.canTrigger !== false ? (
          <a className="atop-pipeline-link" onClick={() => navigate(`/pipelines/${row.id}/run`)}>{row.name}</a>
        ) : (
          <span className="atop-pipeline-link-disabled">{row.name}</span>
        )}
        <div className="atop-meta-row">
          <Tag style={{ fontSize: 11 }}>{row.project}</Tag>
          {renderTriggerTag(row)}
        </div>
      </div>
    </div>
  )

  const columns = [
    {
      title: '流水线名称',
      dataIndex: 'name',
      key: 'name',
      width: 360,
      render: (_name: string, row: Pipeline) => renderPipelineName(row),
    },
    {
      title: '项目',
      dataIndex: 'project',
      key: 'project',
      width: 170,
      render: (value: string) => <Tag style={{ fontSize: 11 }}>{value}</Tag>,
    },
    {
      title: '触发方式',
      dataIndex: 'triggerType',
      key: 'trigger',
      width: 120,
      render: (_value: string, row: Pipeline) => renderTriggerTag(row),
    },
    {
      title: 'Job 绑定',
      key: 'jobs',
      width: 148,
      render: (_value: unknown, row: Pipeline) => renderJobSummary(row),
    },
    {
      title: '权限',
      key: 'role',
      width: 120,
      render: (_value: unknown, row: Pipeline) => {
        const role = ROLE_LABELS[row.currentRole ?? ''] ?? { label: '默认', color: '#5F5E5A' }
        return (
          <span className="atop-table-strong" style={{ color: role.color }}>
            <SafetyCertificateOutlined /> {role.label}
          </span>
        )
      },
    },
    {
      title: '创建人',
      key: 'creator',
      width: 120,
      render: (_value: unknown, row: Pipeline) => (
        <span style={{ fontSize: 12 }}>{displayUserName(row.createdByName, row.createdBy, '已删除用户')}</span>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (value: string) => <span style={{ fontSize: 12, color: '#647084' }}>{fmtDatetime(value)}</span>,
    },
    {
      title: '更新人',
      key: 'updater',
      width: 120,
      render: (_value: unknown, row: Pipeline) => (
        <span style={{ fontSize: 12 }}>{displayUserName(row.updatedByName, row.updatedBy, '已删除用户')}</span>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      render: (value: string) => <span style={{ fontSize: 12, color: '#647084' }}>{fmtDatetime(value)}</span>,
    },
    {
      title: '最近运行',
      key: 'lastRun',
      width: 150,
      render: (_value: unknown, row: Pipeline) => (
        <Space size={4} direction="vertical" style={{ gap: 0 }}>
          {row.lastRunStatus && <PipelineStatusBadge status={row.lastRunStatus} />}
          {row.lastRunAt && <RelativeTimeText value={row.lastRunAt} style={{ fontSize: 11, color: '#9C9A92' }} />}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      align: 'center' as const,
      fixed: 'right' as const,
      render: (_value: unknown, row: Pipeline) => renderActions(row, 'table'),
    },
  ]

  return (
    <div className="atop-pipeline-page">
      <section className="atop-pipeline-command">
        <div className="atop-pipeline-command-copy">
          <div className="atop-pipeline-eyebrow">PIPELINE ORCHESTRATION</div>
          <div className="atop-pipeline-title-row">
            <h1>流水线配置</h1>
            <span className="atop-pipeline-live-badge">生产视图</span>
          </div>
          <div className="atop-pipeline-subtitle">
            面向日常配置与触发的工作台：创建人默认拥有全部权限，分配后支持查看或编辑；运行数据在独立大盘与记录页开放查看。
          </div>
          <div className="atop-pipeline-hero-pills">
            <span>权限分配</span>
            <span>Jenkins 参数触发</span>
            <span>运行记录可观测</span>
          </div>
        </div>

        <div className="atop-pipeline-command-actions">
          <Button onClick={resetFilters}>重置筛选</Button>
          <PermGuard resource="pipeline" action="create">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/pipelines/new')}>
              新建流水线
            </Button>
          </PermGuard>
        </div>
      </section>

      <section className="atop-pipeline-summary-strip" aria-label="流水线概览">
        <div><span>已配置</span><strong>{configuredCount}</strong></div>
        <div><span>可触发</span><strong>{runnableCount}</strong></div>
        <div><span>可编辑</span><strong>{editableCount}</strong></div>
        <div><span>Job 绑定</span><strong>{jenkinsJobCount}</strong></div>
      </section>

      <Card
        className="atop-panel-card atop-pipeline-board"
        size="small"
        title={(
          <div className="atop-pipeline-board-title">
            <span className="atop-pipeline-board-icon"><DeploymentUnitOutlined /></span>
            <div>
              <div className="atop-panel-title">配置清单</div>
              <div className="atop-panel-note">支持名称、项目、环境、产品、OS、运行类型、触发方式和最近状态组合查询</div>
            </div>
          </div>
        )}
        extra={(
          <div className="atop-pipeline-board-tools">
            <Input.Search
              className="atop-pipeline-search"
              placeholder="搜索流水线"
              allowClear
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value)
                setPage(1)
              }}
              onSearch={() => setPage(1)}
            />
            <Select
              placeholder="全部项目"
              allowClear
              value={projFilter}
              options={projectOptions}
              onChange={(value) => {
                setProjFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="全部环境"
              allowClear
              value={envFilter}
              options={environmentOptions}
              onChange={(value) => {
                setEnvFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="全部产品"
              allowClear
              value={productFilter}
              options={productOptions}
              onChange={(value) => {
                setProductFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="全部 OS"
              allowClear
              value={osFilter}
              options={osOptions}
              onChange={(value) => {
                setOsFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="运行类型"
              allowClear
              value={runTypeFilter}
              options={runTypeOptions}
              onChange={(value) => {
                setRunTypeFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="触发方式"
              allowClear
              value={triggerFilter}
              options={TRIGGER_FILTER_OPTIONS}
              onChange={(value) => {
                setTriggerFilter(value)
                setPage(1)
              }}
            />
            <Select
              placeholder="最近状态"
              allowClear
              value={lastStatusFilter}
              options={LAST_STATUS_OPTIONS}
              onChange={(value) => {
                setLastStatusFilter(value)
                setPage(1)
              }}
            />
            <Radio.Group value={viewMode} onChange={(event) => setViewMode(event.target.value)} size="small">
              <Radio.Button value="card">卡片</Radio.Button>
              <Radio.Button value="table">表格</Radio.Button>
            </Radio.Group>
            <SavedFilterViews<PipelineFilters>
              storageKey="atop.savedFilters.pipelines.v1"
              currentFilters={{ keyword, projFilter, envFilter, productFilter, osFilter, runTypeFilter, triggerFilter, lastStatusFilter, viewMode }}
              onApply={applySavedFilters}
              activeCount={activeFilterCount}
              presets={[
                { name: '失败流水线', note: '最近状态 failed', filters: { keyword: '', lastStatusFilter: 'failed', viewMode: 'table' } },
                { name: '手动触发', note: '只看 manual', filters: { keyword: '', triggerFilter: 'manual', viewMode: 'table' } },
                { name: 'Cron 流水线', note: '定时任务配置', filters: { keyword: '', triggerFilter: 'cron', viewMode: 'table' } },
              ]}
            />
          </div>
        )}
        styles={{ body: { padding: 0 } }}
        loading={viewMode === 'card' && isLoading}
      >
        {!isLoading && pipelines.length === 0 ? (
          <>
            <div className="atop-pipeline-scrollarea">
              <EmptyState description="暂无流水线" />
            </div>
            <div className="atop-pipeline-pagination">
              <Pagination
                current={page}
                pageSize={pageSize}
                total={data?.total ?? 0}
                showSizeChanger
                showTotal={(total) => `共 ${total} 条`}
                onChange={(nextPage, nextPageSize) => {
                  setPage(nextPage)
                  setPageSize(nextPageSize)
                }}
              />
            </div>
          </>
        ) : viewMode === 'card' ? (
          <>
            <div className="atop-pipeline-scrollarea">
              <div className="atop-pipeline-tile-grid">
                {pipelines.map((row) => {
                  const updaterText = displayUserName(row.updatedByName, row.updatedBy, '已删除用户')
                  const role = ROLE_LABELS[row.currentRole ?? ''] ?? { label: '默认', color: '#5F5E5A' }
                  const jobSummary = getPipelineJenkinsSummary(row)
                  return (
                    <article
                      className={`atop-pipeline-card${row.lastRunStatus ? ` atop-pipeline-card-${row.lastRunStatus}` : ''}`}
                      key={row.id}
                    >
                      <div className="atop-pipeline-card-main">
                        <div className="atop-pipeline-card-head">
                          <span className="atop-pipeline-mark"><DeploymentUnitOutlined /></span>
                          <div style={{ minWidth: 0 }}>
                            <div
                              className="atop-pipeline-name"
                              style={{ cursor: row.canTrigger !== false ? 'pointer' : 'default' }}
                              onClick={() => {
                                if (row.canTrigger !== false) navigate(`/pipelines/${row.id}/run`)
                              }}
                            >
                              {row.name}
                            </div>
                            <div className="atop-pipeline-desc">
                              {[row.environment, row.product, row.runType].filter(Boolean).join(' / ') || 'Jenkins 任务配置与参数触发'}
                            </div>
                          </div>
                        </div>

                        <div className="atop-meta-row atop-pipeline-tag-row">
                          <Tag style={{ fontSize: 11 }}>{row.project}</Tag>
                          {renderTriggerTag(row)}
                          <Tag style={{ fontSize: 11 }}>创建人：{displayUserName(row.createdByName, row.createdBy, '已删除用户')}</Tag>
                        </div>

                        <div className="atop-pipeline-card-audit">
                          <span>创建 {fmtDatetime(row.createdAt)}</span>
                          <span>更新 {updaterText} · {fmtDatetime(row.updatedAt)}</span>
                        </div>

                        <div className="atop-pipeline-mini-metrics">
                          <div>
                            <span>最近运行</span>
                            <strong>
                              {row.lastRunStatus ? <PipelineStatusBadge status={row.lastRunStatus} /> : '未运行'}
                              {row.lastRunAt && (
                                <RelativeTimeText value={row.lastRunAt} style={{ marginLeft: 5, fontStyle: 'normal', fontWeight: 900 }} />
                              )}
                            </strong>
                          </div>
                          <div>
                            <span>Jenkins Job</span>
                            <strong title={jobSummary.jobNames.join(', ') || undefined}>
                              <ApiOutlined />
                              {jobSummary.uniqueJobCount > 0 ? `${jobSummary.uniqueJobCount} 个 Job` : '未配置'}
                            </strong>
                            {jobSummary.componentCount > 0 && (
                              <div className="atop-pipeline-job-note">{jobSummary.componentCount} 个组件引用</div>
                            )}
                          </div>
                          <div>
                            <span>权限</span>
                            <strong style={{ color: role.color }}>
                              <SafetyCertificateOutlined /> {role.label}
                            </strong>
                          </div>
                        </div>
                      </div>
                      {renderActions(row)}
                    </article>
                  )
                })}
              </div>
              <EndOfListHint className="atop-pipeline-endline" visible={isLastPage && pipelines.length > 0} />
            </div>
            <div className="atop-pipeline-pagination">
              <Pagination
                current={page}
                pageSize={pageSize}
                total={data?.total ?? 0}
                showSizeChanger
                showTotal={(total) => `共 ${total} 条`}
                onChange={(nextPage, nextPageSize) => {
                  setPage(nextPage)
                  setPageSize(nextPageSize)
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="atop-pipeline-scrollarea atop-pipeline-table-wrap">
              <Table
                dataSource={pipelines}
                columns={columns}
                rowKey="id"
                size="middle"
                loading={isLoading}
                pagination={false}
                scroll={{ x: 1680 }}
              />
              <EndOfListHint className="atop-pipeline-endline" visible={isLastPage && pipelines.length > 0} />
            </div>
            <div className="atop-pipeline-pagination">
              <Pagination
                current={page}
                pageSize={pageSize}
                total={data?.total ?? 0}
                showSizeChanger
                showTotal={(total) => `共 ${total} 条`}
                onChange={(nextPage, nextPageSize) => {
                  setPage(nextPage)
                  setPageSize(nextPageSize)
                }}
              />
            </div>
          </>
        )}
      </Card>

      {accessPipeline && (
        <PipelineAccessDrawer
          open={accessOpen}
          onClose={() => setAccessOpen(false)}
          pipelineId={accessPipeline.id}
          pipelineName={accessPipeline.name}
        />
      )}
    </div>
  )
}
